# CLAUDE.md

このリポジトリで作業するときの設計方針と内部仕様。ユーザー向けドキュメントは `doc/` を参照。

## プロジェクト概要

**mihari** はローカルのログファイル、または cron スケジュールに反応して bash ランブックを実行する CLI。

- `file` トリガー: ログファイルを tail し、新規行が正規表現にマッチで発火
- `cron` トリガー: 5フィールド cron 式で定期発火
- ステップは `bash` と `claude`（単発 / agent モード）をサポート
- state は `~/.mihari/state/` にローカル保存

## 設計原則

1. **ポーリングのみ。Webhook は作らない。** inotify も使わない。シンプルさと移植性を優先。
2. **重複実行は許容、冪等性はランブック側責務。** state でベストエフォートで防ぐが「絶対1回」は捨てる。
3. **state 書き込み失敗は fail-open。** ログだけ残して処理続行。state 破損で全ポーリングが止まるほうが運用上のリスクが大きい。
4. **ステップは bash と claude。** 承認フロー / HTTP 等は将来拡張として置いておくが、コードもドキュメントも書かない。
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
├── src/
│   ├── cli.ts                  # commander エントリ。bootstrap → dispatcher
│   ├── core/
│   │   ├── logger.ts           # 共有 pino root + setLogLevel
│   │   ├── runbook-loader.ts   # YAML → Runbook[]、起動時 fail-closed
│   │   ├── matcher.ts          # 純粋関数。file event → Match[]
│   │   ├── dispatcher.ts       # tick(): poller/scheduler を回して executor へ
│   │   ├── executor.ts         # execute(runbook, event) ステップループ
│   │   └── state.ts            # ~/.mihari/state I/O
│   ├── steps/
│   │   ├── bash-step.ts        # spawn bash + テンプレ展開（注入安全）
│   │   └── claude-step.ts      # 単発: @anthropic-ai/sdk / agent: @anthropic-ai/claude-agent-sdk
│   ├── pollers/
│   │   ├── file.ts             # tail（offset/inode/size 判定）
│   │   └── cron.ts             # croner で発火判定
│   └── types.ts                # Runbook / Trigger / TriggerEvent / RunResult
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

`TriggerEvent` は識別共用体（`type: "file" | "cron" | "manual"`）。`bash-step` は `event.type` で `MIHARI_EVENT_LINE` `MIHARI_EVENT_PATH` を埋めるか空文字にする。`event.timestamp` は常に存在。

## State 配置

```
~/.mihari/state/
├── pollers/<sha1(path)>.json         # FilePoller オフセット
├── triggers/<sha1(runbook_id)>.json  # CronScheduler last_fired_at
└── runs/<YYYY-MM-DD>/<run_id>.jsonl  # 実行履歴
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

## コーディング規約

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- I/O 境界（外部ファイル、ユーザー入力）でのみバリデーション
- エラー処理は state 書き込みなど fail-open が妥当な箇所と、それ以外を区別。デフォルトは投げる
- コメントは **WHY** のみ。WHAT は識別子で表現
- ログは `pino` で構造化 JSON。各モジュールは `logger("component-name")` で root の child を取る

## やらないこと（Non-Goals）

- Webhook サーバ
- Datadog / Slack 連携
- 承認フロー
- リモートステート同期（S3 等）
- GUI
- マルチテナント
