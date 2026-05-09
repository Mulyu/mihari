# CLAUDE.md

このリポジトリで作業するときの設計方針と内部仕様。ユーザー向けドキュメントは `doc/` を参照。

## プロジェクト概要

**mihari** はローカルのログファイル、cron スケジュール、CloudWatch Logs、または Datadog Monitor に反応して bash ランブックを実行する CLI。

- `file` トリガー: ログファイルを tail し、新規行が正規表現にマッチで発火
- `cron` トリガー: 5フィールド cron 式で定期発火
- `aws_cloudwatch_logs` トリガー: CloudWatch Logs を `interval_sec` 間隔でポーリングし、event 1 件ごとに発火
- `datadog_monitors` トリガー: Datadog Monitor を `interval_sec` 間隔でポーリングし、状態遷移 1 件ごとに発火
- ステップは `bash` / `claude`（単発）/ `claude_agent`（副作用あり、Agent SDK）の3種別
- state は `~/.mihari/state/` にローカル保存

## 設計原則

1. **ポーリングのみ。Webhook は作らない。** inotify も使わない。シンプルさと移植性を優先。ただし、ポーリング型である限り新トリガー追加は一級市民として扱う。観測対象（読み取り元・cursor の単位・SDK 依存）が既存トリガーと異なるなら、既存の拡張に押し込めず新トリガーを正面から足してよい。SDK は当該トリガーが存在する時だけ動的 import する形（`aws_cloudwatch_logs` パターン）で、本体の依存を増やさない。
2. **重複実行は許容、冪等性はランブック側責務。** state でベストエフォートで防ぐが「絶対1回」は捨てる。
3. **state 書き込み失敗は fail-open。** ログだけ残して処理続行。state 破損で全ポーリングが止まるほうが運用上のリスクが大きい。
4. **新ステップ種別は追加しない（当面）。** 既存の `bash` / `claude` / `claude_agent` 以外は増やさない。新しい振る舞いはまず「`bash` で書けるか」で篩う。書ける場合は `runbooks/examples/` にサンプルを足す形で表現する。
5. **ローカル前提。** リモート同期しない、複数マシン対応しない。

## ディレクトリ構造

```
mihari/
├── README.md
├── CLAUDE.md                   # ← これ
├── doc/                        # ユーザー向け（CLI / ランブックYAML）
├── monban.yml                  # 構造リンタ設定
├── package.json
├── tsconfig.json
├── src/                        # 直下に .ts は置かない。すべてサブディレクトリ配下
│   ├── cli/
│   │   └── index.ts            # commander エントリ。bootstrap → dispatcher
│   ├── types/
│   │   └── index.ts            # Runbook / Trigger / TriggerEvent / StepContext / RunResult
│   ├── engine/                 # オーケストレーション層
│   │   ├── dispatcher.ts       # tick(): trigger を回して executor へ
│   │   ├── executor.ts         # execute(runbook, event) ステップループ
│   │   └── matcher.ts          # 純粋関数。file event → Match[]
│   ├── loader/                 # YAML → Runbook[] のバリデーション群
│   │   ├── index.ts            # 公開エントリ（loadRunbooks / loadRunbookFile）
│   │   ├── error.ts            # RunbookValidationError
│   │   ├── primitives.ts       # mustString / optional* 等の小物
│   │   ├── prompt-file.ts      # readPromptOrFile（claude / claude_agent 共有）
│   │   ├── trigger.ts          # file / cron トリガー
│   │   ├── step-common.ts      # 全ステップ共通フィールド（id/timeout_sec/...）
│   │   ├── step-bash.ts        # bash ステップ
│   │   ├── step-claude.ts      # claude ステップ
│   │   ├── step-claude-agent.ts # claude_agent ステップ
│   │   └── runbook.ts          # 全体 + steps[] dispatch
│   ├── state/
│   │   └── store.ts            # ~/.mihari/state I/O
│   ├── triggers/               # YAML の trigger.source に対応する取得元
│   │   ├── file.ts             # FilePoller（offset/inode/size 判定）
│   │   ├── cron.ts             # CronScheduler（croner で発火判定）
│   │   ├── aws-cloudwatch-logs.ts  # AwsCloudWatchLogsPoller（FilterLogEvents + cursor）
│   │   └── datadog-monitors.ts # DatadogMonitorsPoller（listMonitors + per-monitor state diff）
│   ├── steps/                  # 各ステップの実行
│   │   ├── template.ts         # 共有テンプレ展開（bash / claude 両方）
│   │   ├── bash-step.ts        # spawn bash（注入安全）
│   │   ├── claude-step.ts      # 単発の messages.create。副作用なし
│   │   └── claude-agent-step.ts # @anthropic-ai/claude-agent-sdk による agent ループ。副作用あり
│   └── lib/                    # 横断ヘルパ
│       ├── logger.ts           # 共有 pino root + setLogLevel
│       └── idempotency.ts      # event → 決定的 12 hex キー
├── test/                       # vitest
└── runbooks/
    └── examples/
```

## データフロー

```
RunbookLoader → runbooks
StateStore     → 各種 I/O

Dispatcher.tick():
  for FilePoller:
    events = poller.tick(dryRun)        # FileEvent[]
    for event:
      for m in matcher.match(event, runbooks):
        if runbook.enabled === false: skip
        if cooldown_sec && elapsed < cooldown_sec: skip
        executor.execute(m.runbook, m.event)

  for AwsCloudWatchLogsPoller:
    events = poller.tick(now, dryRun)   # AwsCloudWatchLogsEvent[]
    for event:
      for m in matcher.matchAwsCloudWatchLogs(event, runbooks):
        # enabled / cooldown チェックは file と同じ
        executor.execute(m.runbook, m.event)

  for DatadogMonitorsPoller:
    events = poller.tick(now, dryRun)   # DatadogMonitorEvent[]
    for event:
      for m in matcher.matchDatadogMonitor(event, runbooks):
        # enabled / cooldown チェックは file と同じ
        executor.execute(m.runbook, m.event)

  for CronScheduler:
    if runbook.enabled === false: skip
    event = scheduler.tick(now, dryRun) # CronEvent | null
    if event && cooldown elapsed:
      executor.execute(scheduler.runbook, event)

Executor:
  anyFailed = false; stopped = false
  for step in runbook.steps:
    if !shouldRun(step.condition, anyFailed, stopped): record skipped; continue
    runBashStep(step, { event })
    if !ok && step.on_error === "stop": stopped = true
  state.appendRunResult(...)
```

`shouldRun` ルール（`step.condition` フィールド）:
- 省略: `!stopped`（既存挙動を維持）
- `always`: 常に実行（stopped 後でも）
- `on_failure`: `anyFailed || stopped` のとき実行
- `on_success`: `!anyFailed && !stopped` のとき実行

`TriggerEvent` は識別共用体（`type: "file" | "cron" | "manual" | "aws_cloudwatch_logs" | "datadog_monitor"`）。`bash-step` は `event.type` で `MIHARI_EVENT_LINE` `MIHARI_EVENT_PATH` `MIHARI_EVENT_LOG_STREAM` を埋めるか空文字にする。`datadog_monitor` の場合は加えて `MIHARI_EVENT_MONITOR_ID` `MIHARI_EVENT_MONITOR_NAME` `MIHARI_EVENT_FROM_STATE` `MIHARI_EVENT_TO_STATE` を埋める（他種別では空文字）。`event.timestamp` は常に存在。

## State 配置

```
~/.mihari/state/
├── pollers/<sha1(path)>.json                                # FilePoller オフセット
├── triggers/<sha1(runbook_id)>.json                         # CronScheduler last_fired_at
├── aws-cloudwatch-logs/<sha1(region|group)>.json            # AwsCloudWatchLogsPoller cursor
├── datadog-monitors/<sha1(site|sorted-monitor_tags)>.json   # DatadogMonitorsPoller per-monitor state map
└── runs/<YYYY-MM-DD>/<run_id>.jsonl                         # 実行履歴
```

書き込みは `proper-lockfile` でロック → tmp ファイル書き → `rename()` で atomic 置換。書き込み失敗は warn ログだけ残して続行（fail-open）。

## ポーラー判定

### `FilePoller`

| 状態 | 判定 | 対応 |
|-----|------|------|
| stateなし | 初回 | EOF からスタート（`offset = size`） |
| `inode` 変化 | ローテーション | `offset = 0` |
| `size < offset` | truncate | `offset = 0` |
| `size > offset` | 通常追記 | `offset` から `size` まで読む |
| `size == offset` | 変化なし | 何もしない |

末尾の改行未確定行は次ティックまで保留。

### `CronScheduler`

- 初回観測: 発火せず state だけシード（`mihari run <id>` で手動実行可能）
- 以降: `next(schedule, last_fired_at) <= now` なら発火し `last_fired_at = now`
- 1ティックで複数スロットが過ぎていても発火は1回（catch-up しない）

### `AwsCloudWatchLogsPoller`

| 状態 | 判定 | 対応 |
|-----|------|------|
| stateなし | 初回 | 発火せず cursor を「今」にシード |
| `now - last_polled_at < interval_sec` | interval 未経過 | 何もしない（API も叩かない） |
| 上記以外 | poll | `FilterLogEvents(startTime=last_event_timestamp_ms)` を nextToken で全件取得 |

- 初回観測: `file` と対称で履歴を遡らない
- boundary 重複: 同 ms に複数 event があり得るため `last_event_ids` で前回観測分を弾く
- pagination: 1 tick あたり最大 50 hops（残りは次 tick）
- 同じ `(region, log_group)` を購読する複数ランブックがあれば、ポーラーは 1 つに集約され `interval_sec` は最小値が採用される
- AWS SDK は `aws_cloudwatch_logs` ランブックがある時だけ動的 import（`claude_agent` と同パターン）。認証は SDK 標準チェーンに完全委譲し、mihari は `region` 以外の AWS 固有フィールドを持たない

### `DatadogMonitorsPoller`

| 状態 | 判定 | 対応 |
|-----|------|------|
| stateなし | 初回 | 全 monitor の現在 `overall_state` を保存して終了（発火せず seed） |
| `now - last_polled_at < interval_sec` | interval 未経過 | 何もしない（API も叩かない） |
| 上記以外 | poll | `listMonitors({ monitorTags, page, pageSize: 100 })` を hasMore が落ちるまで取得 |

- 初回観測: `file` / `aws_cloudwatch_logs` と対称で履歴を遡らない
- 状態遷移検出: 前回 state の `monitor_states[id]` と現在 `overall_state` を比較。差分があれば 1 件 event を emit。`transitions` フィルタは matcher 側で適用（同 key を異なる `transitions` で複数 runbook が購読できる）
- 新規 monitor: 初回観測扱いで発火しない（次回 tick から差分検出対象に入る）
- pagination: 1 tick あたり最大 50 hops（残りは次 tick）
- 同じ `(site, monitor_tags)` を購読する複数ランブックがあれば、ポーラーは 1 つに集約され `interval_sec` は最小値が採用される
- Datadog SDK は `datadog_monitors` ランブックがある時だけ動的 import。認証は環境変数 `DD_API_KEY` / `DD_APP_KEY` から読み SDK にそのまま渡す。mihari は YAML に認証フィールドを置かない（`site` のみ）

## 失敗モードと対応

| 失敗 | 対応 |
|------|------|
| ランブック YAML 不正 | 起動時に投げる（fail-closed） |
| state ディレクトリ作成失敗 | 起動時に投げる |
| state 読み込み破損 | 該当 state を破棄して新規扱い、warn ログ |
| state 書き込み失敗 | warn ログのみ、処理続行（fail-open） |
| ログファイル消失 | warn ログのみ、次ティックで再試行 |
| ログファイル inode 変化 / truncate | ローテーション/切り詰め扱い、`offset = 0` |
| bash 非0終了 / timeout | `on_error` に従う（stop / continue） |
| プロセス強制終了 | 永続化前なら次回重複実行（許容） |

## 並列性

すべて逐次：複数 Poller / Scheduler、同一行への複数マッチ、ランブック内ステップ。並列が必要になったら追加する。

## 主要ライブラリ

| 用途 | 採用 |
|------|------|
| CLI | `commander` |
| YAML | `yaml` |
| Cron | `croner` |
| ファイルロック | `proper-lockfile` |
| ロギング | `pino` |
| テスト | `vitest` |
| Claude API（単発） | `@anthropic-ai/sdk` |
| Claude エージェント | `@anthropic-ai/claude-agent-sdk`（claude-step の `agent: true` 時のみ動的 import） |
| CloudWatch Logs | `@aws-sdk/client-cloudwatch-logs`（`aws_cloudwatch_logs` トリガーが存在する時のみ動的 import） |
| Datadog Monitors | `@datadog/datadog-api-client`（`datadog_monitors` トリガーが存在する時のみ動的 import） |

## コーディング規約

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- I/O 境界（外部ファイル、ユーザー入力）でのみバリデーション
- エラー処理は state 書き込みなど fail-open が妥当な箇所と、それ以外を区別。デフォルトは投げる
- コメントは **WHY** のみ。WHAT は識別子で表現
- ログは `pino` で構造化 JSON。各モジュールは `logger("component-name")` で root の child を取る

## やらないこと（Non-Goals）

- Webhook サーバ／受信エンドポイント公開
- mihari 自身からの能動通知（Slack / Datadog などへの通知はランブックの `bash` から `curl` で行う）
- 承認フロー / HTTP / SQL 等の新ステップ種別
- リモートステート同期（S3 等）
- GUI
- マルチテナント

ポーリング型の新トリガー追加（他クラウドのログ／イベントを取りに行くなど）は non-goal ではない。`aws_cloudwatch_logs` の動的 import パターンに倣って足す。
