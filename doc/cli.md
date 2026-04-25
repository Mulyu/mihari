# CLI Reference

mihari の CLI コマンド一覧。

## 共通

```
runbook <command> [options]
```

| グローバルオプション | 内容 |
|------|------|
| `--config <path>` | 設定ファイルパス（デフォ `~/.runbook/config.yaml`） |
| `--state-dir <path>` | stateディレクトリ（デフォ `~/.runbook/state`） |
| `--log-level <level>` | `debug` / `info` / `warn` / `error`（デフォ `info`） |
| `--help` | ヘルプ表示 |

## `runbook daemon`

常駐モード。設定済みの全Pollerを定期間隔でループ実行する。

```bash
runbook daemon
```

| オプション | 内容 |
|------|------|
| `--interval <sec>` | ポーリング間隔（デフォ 60） |
| `--sources <list>` | 起動するPollerをカンマ区切り指定（例: `datadog,slack`） |

`Ctrl+C` (SIGINT) で graceful shutdown。実行中のランブックは完走を待つ。

## `runbook poll <source>`

指定Pollerを1回だけ実行する。GHA cron向け。

```bash
runbook poll datadog --since 6m
runbook poll slack --since 10m
```

| オプション | 内容 |
|------|------|
| `--since <duration>` | この時間以内のイベントを対象（例: `6m`, `1h`） |
| `--dry-run` | マッチング結果を表示するだけで実行しない |

`--since` を省略すると `last_seen_at` を起点にする。stateが無ければ「現在時刻 - 5分」をデフォルトに。

## `runbook run <runbook-id>`

ランブックをトリガーなしで直接実行する。テストや手動運用用。

```bash
runbook run aurora-pgsql-tmp-investigate
runbook run aurora-pgsql-tmp-investigate --input alert_id=12345 --input title="test"
```

| オプション | 内容 |
|------|------|
| `--input <key=value>` | `inputs.*` 変数を上書き（複数可） |
| `--event-file <path>` | JSONファイルから `event` 変数を読み込み |
| `--no-approval` | 承認ステップをスキップ（write系のローカル動作確認用） |

## `runbook list`

ランブック一覧を表示する。

```bash
runbook list
runbook list --source datadog        # トリガーソースで絞り込み
runbook list --json                  # JSON出力
```

出力例：

```
ID                                  PERMS       SOURCE    DESCRIPTION
aurora-pgsql-tmp-investigate        read-only   datadog   Aurora pgsql_tmp ディスク逼迫の調査
ecs-task-failure-restart            write       datadog   ECSタスク失敗時の再起動（要承認）
```

## `runbook validate <path>`

ランブックYAMLの構文・スキーマを検証する。

```bash
runbook validate runbooks/aurora-pgsql-tmp.yaml
runbook validate runbooks/                       # ディレクトリ指定で全件
```

エラーがあれば終了コード 1 で詳細を出力。CIで使う想定。

## 環境変数

| 変数 | 用途 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude Agent SDK の認証 |
| `DD_API_KEY` / `DD_APP_KEY` | Datadog Poller |
| `SLACK_BOT_TOKEN` | Slack Poller / 承認フロー |
| `RUNBOOK_STATE_DIR` | stateディレクトリ（`--state-dir`より優先） |
| `RUNBOOK_LOG_LEVEL` | ログレベル |

## 終了コード

| Code | 意味 |
|------|------|
| 0 | 成功 |
| 1 | ランブック実行失敗 / バリデーションエラー |
| 2 | 設定エラー（API key欠如など） |
| 130 | SIGINT による中断 |
