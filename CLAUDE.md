# CLAUDE.md

このリポジトリで作業するときの設計方針と内部仕様。ユーザー向けドキュメントは `doc/` を参照。

## プロジェクト概要

**mihari** はローカルのログファイル、cron スケジュール、CloudWatch Logs、Datadog Monitor に反応して **Claude Agent** を実行する CLI。1.0 でステップ列を撤廃し、ランブックは `trigger + agent` の単一実行に絞った。

- `file` トリガー: ログファイルを tail し、新規行が正規表現にマッチで発火
- `cron` トリガー: 5フィールド cron 式で定期発火
- `aws_cloudwatch_logs` トリガー: CloudWatch Logs を `interval_sec` 間隔でポーリングし、event 1 件ごとに発火
- `datadog_monitors` トリガー: Datadog Monitor を `interval_sec` 間隔でポーリングし、状態遷移 1 件ごとに発火
- 実行ロジックは `agent:` ブロック単一。Claude Agent SDK で動的に Bash / Read / Edit などを使う
- 外部 SaaS の作法は **provider preamble**（`agent.providers: []` で opt-in）で system prompt に注入
- state は `~/.mihari/state/` にローカル保存

## 設計原則

1. **ポーリングのみ。Webhook は作らない。** inotify も使わない。新トリガー追加は一級市民として扱う（観測対象が既存と異なるなら新トリガーを足す。SDK は当該トリガーが存在する時のみ動的 import）。
2. **重複実行は許容、冪等性はランブック側責務。** state でベストエフォートで防ぐが「絶対1回」は捨てる。`MIHARI_IDEMPOTENCY_KEY` は agent に env として常に渡る。
3. **state 書き込み失敗は fail-open。** ログだけ残して処理続行。provider 必須 env の不足も起動時 warn のみ。
4. **ランブックは agent 単一実行。ステップ列は持たない。** 1.0 で `bash` / `claude` / `claude_agent` ステップを撤廃。決定的処理（curl 1 本など）も agent loop に乗せる。動的判断は agent の責務、お決まり SaaS 作法は provider preamble の責務。
5. **ローカル前提。** リモート同期しない、複数マシン対応しない。

## ディレクトリ構造

```
mihari/
├── README.md
├── CLAUDE.md                   # ← これ
├── doc/                        # ユーザー向け（CLI / ランブック YAML）
├── monban.yml                  # 構造リンタ設定
├── package.json
├── tsconfig.json
├── src/                        # 直下に .ts は置かない。すべてサブディレクトリ配下
│   ├── agent/
│   │   ├── runner.ts           # Claude Agent SDK の query() を呼ぶ単一ランナー
│   │   ├── template.ts         # {{ event.* }} / {{ env.X }} の置換
│   │   └── providers/
│   │       ├── index.ts        # Provider 型 / composePreambles / missingEnv
│   │       ├── datadog.ts      # 必須 env + preamble
│   │       ├── jira.ts
│   │       └── slack.ts
│   ├── cli/
│   │   └── index.ts            # commander エントリ。bootstrap → dispatcher
│   ├── types/
│   │   └── index.ts            # Runbook / Trigger / Agent / TriggerEvent / RunResult
│   ├── engine/
│   │   ├── dispatcher.ts       # tick(): trigger を回して executor へ
│   │   ├── executor.ts         # execute(runbook, event): agent 1 本を回す
│   │   └── matcher.ts          # 純粋関数。trigger event → Match[]
│   ├── loader/                 # YAML → Runbook[] のバリデーション群
│   │   ├── index.ts            # 公開エントリ
│   │   ├── error.ts            # RunbookValidationError
│   │   ├── primitives.ts       # mustString / optional* 等の小物
│   │   ├── trigger.ts          # 4 トリガー
│   │   ├── agent.ts            # agent: 直下 + providers
│   │   └── runbook.ts          # 全体（id / trigger / agent + 旧 steps: 拒否）
│   ├── state/
│   │   └── store.ts            # ~/.mihari/state I/O
│   ├── triggers/
│   │   ├── file.ts             # FilePoller
│   │   ├── cron.ts             # CronScheduler
│   │   ├── aws-cloudwatch-logs.ts
│   │   └── datadog-monitors.ts
│   └── lib/
│       ├── logger.ts
│       └── idempotency.ts      # event → 決定的 12 hex キー
├── test/                       # vitest
└── runbooks/
    └── examples/               # agent 形のサンプル群
```

## データフロー

```
RunbookLoader → runbooks (各 runbook は agent 必須)
StateStore     → 各種 I/O

Dispatcher.tick():
  for each trigger source:
    events = poller.tick(...)
    for event:
      for m in matcher.match*(event, runbooks):
        if runbook.enabled === false: skip
        if cooldown_sec && elapsed < cooldown_sec: skip
        executor.execute(m.runbook, m.event)

Executor.execute(runbook, event):
  agent = await runAgent(runbook.agent, { event, idempotencyKey })
  state.appendRunResult({ ...agent をくるんだ RunResult })
```

`agent.system` 合成順序: `[conventions preamble (if true)] → [provider preambles in declared order] → [user system]`。

## State 配置

```
~/.mihari/state/
├── pollers/<sha1(path)>.json                                # FilePoller オフセット
├── triggers/<sha1(runbook_id)>.json                         # CronScheduler last_fired_at
├── aws-cloudwatch-logs/<sha1(region|group)>.json            # cursor
├── datadog-monitors/<sha1(site|sorted-monitor_tags)>.json   # per-monitor state map
└── runs/<YYYY-MM-DD>/<run_id>.jsonl                         # 実行履歴（agent 単一の RunResult）
```

書き込みは `proper-lockfile` でロック → tmp 書き → `rename()` で atomic 置換。書き込み失敗は warn のみで続行（fail-open）。

## ポーラー判定

トリガー側の判定ロジックは 0.x からそのまま。詳細は `src/triggers/` 各ファイルの実装と `doc/runbook-spec.md` を参照。

## Provider preamble

`agent.providers: [...]` で宣言した provider それぞれの preamble が system prompt に prepend される。各 provider は `src/agent/providers/<name>.ts` に:

- `name`: リテラル小文字（`Provider` 型に列挙）
- `requiredEnv`: 必須環境変数（不足時は起動時 warn）
- `preamble`: 認証 env 名・主要エンドポイント・curl 例・冪等性パターンを書く文字列

をエクスポートする。確定的 API 呼び出しロジックは agent + ランブック著者の prompt に委ね、preamble は呼び出し作法の「ヒント」に留める。

## 失敗モードと対応

| 失敗 | 対応 |
|------|------|
| ランブック YAML 不正 | 起動時に投げる（fail-closed） |
| `steps:` キーが残存 | 1.0 で廃止された旨のメッセージで投げる |
| state ディレクトリ作成失敗 | 起動時に投げる |
| state 読み込み破損 | 該当 state を破棄して新規扱い、warn |
| state 書き込み失敗 | warn ログのみ、処理続行（fail-open） |
| provider 必須 env 不足 | 起動時 warn のみ。agent 実行時に SDK が失敗を返してランブック ok=false |
| ログファイル消失 | warn のみ、次ティックで再試行 |
| ログファイル inode 変化 / truncate | ローテーション/切り詰め扱い、`offset = 0` |
| agent 失敗（max_turns / refusal / pause_turn 等） | `runRunbook` が ok=false で返す |
| agent timeout | `AbortController` で停止、`timed_out=true` |
| プロセス強制終了 | 永続化前なら次回重複実行（許容） |

## 並列性

すべて逐次：複数 Poller / Scheduler、同一行への複数マッチ、agent 実行。並列が必要になったら追加する。

## 主要ライブラリ

| 用途 | 採用 |
|------|------|
| CLI | `commander` |
| YAML | `yaml` |
| Cron | `croner` |
| ファイルロック | `proper-lockfile` |
| ロギング | `pino` |
| テスト | `vitest` |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk`（agent 実行時に動的 import） |
| CloudWatch Logs | `@aws-sdk/client-cloudwatch-logs`（`aws_cloudwatch_logs` トリガー使用時のみ動的 import） |
| Datadog Monitors | `@datadog/datadog-api-client`（`datadog_monitors` トリガー使用時のみ動的 import） |

`@anthropic-ai/sdk`（単発 messages.create 用）は 1.0 で不要になり依存から外した。

## コーディング規約

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- I/O 境界（外部ファイル、ユーザー入力）でのみバリデーション
- エラー処理は state 書き込みなど fail-open が妥当な箇所と、それ以外を区別。デフォルトは投げる
- コメントは **WHY** のみ。デフォルト 0 行。識別子で表現できる WHAT は書かない
- ログは `pino` で構造化 JSON。各モジュールは `logger("component-name")` で root の child を取る

## やらないこと（Non-Goals）

- Webhook サーバ／受信エンドポイント公開
- mihari 自身からの能動通知（Slack / Datadog などへの通知は agent の Bash tool から curl で行う）
- 承認フロー / HTTP / SQL 等の新ステップ種別（ステップ概念自体を廃止した）
- リモートステート同期（S3 等）
- GUI
- マルチテナント

ポーリング型の新トリガー追加（他クラウドのログ／イベントを取りに行くなど）と、新 provider 追加は non-goal ではない。direction の判定フローを通して足す。
