# Architecture

mihari の全体アーキテクチャと処理フロー。

## コンポーネント構成

```
                    ┌──────────────────────────────────────────┐
                    │            CLI Entry Point                │
                    │  runbook daemon | poll | run | list       │
                    └──────────────────┬───────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
        ┌──────────┐            ┌──────────┐            ┌──────────┐
        │ Pollers  │            │ Matcher  │            │ Executor │
        │          │            │          │            │          │
        │ datadog  │  events    │ trigger  │  runbook   │  steps   │
        │ slack    │ ─────────► │  rules   │ ─────────► │  loop    │
        └──────────┘            └──────────┘            └────┬─────┘
                                                             │
                                              ┌──────────────┼──────────────┐
                                              ▼              ▼              ▼
                                        ┌──────────┐  ┌──────────┐  ┌──────────┐
                                        │  bash    │  │  claude  │  │ approval │
                                        │  step    │  │  step    │  │  gate    │
                                        └──────────┘  └────┬─────┘  └──────────┘
                                                           │
                                                           ▼
                                                  Claude Agent SDK
                                                  (Bash, Read, MCP...)
```

## 役割

### CLI Entry Point (`src/cli.ts`)

`commander` でサブコマンドに分岐：
- `daemon` 全Pollerを永続ループ
- `poll <source>` 指定Pollerを1回だけ実行（GHA向け）
- `run <runbook-id>` ランブック直接実行（テスト・手動）
- `list` ランブック一覧
- `validate <path>` ランブック構文チェック

### Poller (`src/pollers/*`)

外部サービスから新規イベントを取得する。

- **Datadog Poller**: `GET /api/v1/events?priority=normal&start=<unix>&end=<unix>` でアラートイベントを取得
- **Slack Poller**: `conversations.history` で指定チャンネルのメッセージを取得（メンション検知 / botアラート二次トリガー）

各Pollerは `last_seen_at` を `~/.runbook/state/pollers/<source>.json` に保存し、次回ポーリングの起点にする。

### Matcher (`src/core/matcher.ts`)

イベントとランブックの `trigger` 定義を突き合わせる。

```ts
function matches(event: Event, trigger: Trigger): boolean {
  if (trigger.source !== event.source) return false;
  // monitor_tags, title_pattern などをANDで評価
}
```

複数ランブックが同一イベントにマッチした場合は **全て並列実行**。衝突回避はランブック側責務。

### Executor (`src/core/executor.ts`)

マッチしたランブックの `steps` を上から順に実行する。各ステップの出力は `capture` でテンプレ変数に格納され、後続ステップから `{{ steps.<id>.output }}` で参照できる。

### Steps (`src/steps/*`)

| Step | 役割 | 出力 |
|------|------|------|
| `bash` | 任意のシェル実行（決定論的処理、データ収集、外部CLI起動） | stdout |
| `claude` | Claude Agent SDK 呼び出し（判断、要約、調査、書き込み） | 最終応答テキスト |
| `approval` | Slack/CLIで承認待ち（write系で使用） | true/false |

## 処理フロー（典型例）

1. `runbook poll datadog --since 6m` がGHA cronで起動
2. S3から state pull → `last_seen_at` をロード
3. Datadog Poller が新規イベントを取得
4. 処理済みID（ring buffer）にあるイベントは skip
5. Matcher が各イベントに対応するランブックを探す
6. Executor がランブックを実行
   - `bash` ステップ → 子プロセスで実行、stdoutを `capture`
   - `claude` ステップ → Claude Agent SDK にプロンプト渡し、最終応答を `capture`
   - `approval` ステップ → Slackリアクションを定期取得して承認/タイムアウト判定
7. 実行完了後 `markProcessed` で処理済みIDを永続化
8. S3に state push

## 実行モード

### `daemon` モード（ローカル常駐）

各Pollerを設定済みインターバル（例: 60秒）で永続ループ。`Ctrl+C` で graceful shutdown。stateは `~/.runbook/state/` に直接 I/O。

### `poll` モード（GHA向けワンショット）

`--since` で時間窓を指定して1回だけ実行。`*/5 * * * *` などで定期実行する想定。

```yaml
- run: npx runbook poll datadog --since 6m
```

`--since 6m` は cron間隔(5m) + バッファ(1m) で取りこぼしを抑える。

### `run` モード（直接実行）

ランブックをトリガーなしで起動。テストや手動オペレーション用。

```bash
npx runbook run aurora-pgsql-tmp-investigate --input alert_id=12345
```

## 同時実行と整合性

| 環境 | 同時実行の発生源 | 対策 |
|------|-----------------|------|
| ローカル `daemon` | 複数Pollerが同じstate fileに書く | `proper-lockfile` でファイルロック |
| ローカル `run` 並走 | ユーザーが複数CLIを叩く | 同上 |
| GHA `poll` | cron + workflow_dispatch の重なり | `concurrency.group` で直列化 |
| GHA + ローカル混在 | 両方走ってるとき | 諦める → 重複実行は許容 |

詳細は [state.md](./state.md) を参照。
