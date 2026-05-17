# CLI リファレンス

> **日本語** | [English](./cli.md)

## 共通

```
mihari <command> [options]
```

| グローバルオプション | 内容 |
|------|------|
| `--runbooks-dir <path>` | ランブックディレクトリ（デフォ `./runbooks`） |
| `--state-dir <path>` | state ディレクトリ（デフォ `~/.mihari/state`） |
| `--log-level <level>` | `debug` / `info` / `warn` / `error`（デフォ `info`） |

ログは pino の構造化 JSON で stdout に出力。

| 環境変数 | 役割 |
|----------|------|
| `MIHARI_STATE_DIR` | `--state-dir` の既定値 |
| `MIHARI_LOG_LEVEL` | `--log-level` の既定値 |

## `mihari daemon`

常駐モード。ファイルポーラー、cron スケジューラ、CloudWatch Logs ポーラー、CloudWatch Alarms ポーラー、Datadog Monitors ポーラーを定期間隔でティックする。

```bash
mihari daemon --interval 30
```

| オプション | 内容 |
|------|------|
| `--interval <sec>` | ティック間隔（デフォ 10） |

`Ctrl+C` (SIGINT) / SIGTERM で現在のティック完了を待ってから終了。

## `mihari poll`

すべてのトリガーを1回だけ評価する。終了コードは1件でも失敗があれば `1`。

```bash
mihari poll
mihari poll --dry-run
```

| オプション | 内容 |
|------|------|
| `--dry-run` | 発火対象だけ表示（実行しない） |

## `mihari run <runbook-id>`

ランブックをトリガー無しで実行する。`event` は `{type: "manual", timestamp: now}`。

```bash
mihari run dd-monitor-jira
```

## `mihari list`

ランブック一覧を表示する。各行は `<id>\t<trigger>\t<description>`。

```bash
mihari list
```

トリガー表記は `file:<path>` / `cron:<schedule>` / `aws_cloudwatch_logs:<region>|<log_group>` / `aws_cloudwatch_alarms:<region>|<カンマ区切り alarm_names>` / `datadog_monitors:<site>|<カンマ区切り monitor_tags>` / `datadog_logs:<site>|<query>` のいずれか。

## `mihari status`

各ランブックの最終実行時刻・成否・次回発火予定を一覧表示する。

```bash
mihari status
```

出力例（タブ区切り）：

```
file-slack-alert    file:/var/log/myapp.log                        2026-04-29T02:11Z   ok    -
cron-health-agent   cron:*/5 * * * *                               2026-04-29T03:05Z   FAIL  2026-04-29T03:10Z
cw-error-triage     aws_cloudwatch_logs:us-east-1|/aws/lambda/fn   2026-04-29T03:00Z   ok    -
dd-monitor-jira     datadog_monitors:datadoghq.com|env:prod        2026-04-29T03:00Z   ok    -
```

`enabled: false` のランブックは行頭に `[disabled]` が付く。`NEXT` 列は `file` / `aws_cloudwatch_logs` / `aws_cloudwatch_alarms` / `datadog_monitors` / `datadog_logs` トリガーでは常に `-`。

## `mihari validate <path>`

ランブック YAML の構文・スキーマを検証する。エラー時は終了コード 1。

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/
```

## `mihari history [run_id]`

実行履歴を表示する。引数なしで最近一覧、`run_id` を渡すと詳細 JSON。

```bash
mihari history                              # 直近20件
mihari history --runbook api-health
mihari history --since 2026-04-25 --limit 5
mihari history --json
mihari history run_abc12345                 # 1件の詳細
```

| オプション | 内容 |
|------|------|
| `--runbook <id>` | runbook id で絞り込み |
| `--limit <n>` | 最大件数（デフォ 20） |
| `--since <date>` | `YYYY-MM-DD` 以降のみ |
| `--json` | JSON 出力 |

## 終了コード

| Code | 意味 |
|------|------|
| 0 | 成功 |
| 1 | ランブック実行失敗 / バリデーションエラー / 未検出 |
| 2 | オプション不正 |
| 130 | SIGINT による中断 |
