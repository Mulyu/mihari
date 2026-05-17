# ランブック仕様

> **日本語** | [English](./runbook-spec.md)

ランブックは `runbooks/*.yaml` に置く。起動時、トップレベルのみ非再帰でディレクトリを読む。

## スキーマ

```yaml
id: kebab-case-id          # 必須。`[a-z0-9][a-z0-9-]*` に一致
description: ...           # 任意
enabled: true              # 任意。false にすると daemon/poll はスキップ（既定 true）
cooldown_sec: 300          # 任意。直近の発火から N 秒以内は再発火しない
trigger: ...               # 必須。file / cron / aws_cloudwatch_logs / datadog_monitors のいずれか
agent: ...                 # 必須。Claude agent ブロックを 1 つ
```

1.0 ランブックは `agent:` を **必ず 1 つ** 持つ。0.x の `steps:` は廃止。`steps:` キーが残っているランブックは loader が拒否する。

## トリガー

### `file`

```yaml
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
```

| フィールド | 役割 |
|----------|------|
| `path` | tail する絶対パス |
| `pattern` | 行に対する正規表現 |

複数のランブックが同じ行にマッチした場合は順次実行される。初回起動時は state がないのでファイル末尾から読み始める（過去ログを巻き戻さない）。

### `cron`

```yaml
trigger:
  source: cron
  schedule: "*/5 * * * *"
```

| フィールド | 役割 |
|----------|------|
| `schedule` | 5 フィールド cron 式 |

初回観測では発火せず次のスロットを待つ。手動テストは `mihari run <id>`。1 ティック中に複数スロットが過ぎていても発火は 1 回（catch-up しない）。

### `aws_cloudwatch_logs`

```yaml
trigger:
  source: aws_cloudwatch_logs
  region: us-east-1
  log_group: /aws/lambda/myfunc
  pattern: "ERROR"             # メッセージ本文への任意の正規表現
  interval_sec: 60
```

認証は AWS SDK の標準チェーン（環境変数 / `~/.aws/credentials` / IAM ロール）に完全委譲。mihari は YAML に認証フィールドを置かない。SDK は当該トリガーが存在する時のみ動的 import。同じ `(region, log_group)` を購読する複数ランブックは 1 つのポーラーを共有し、`interval_sec` は最小値が採用される。

### `aws_cloudwatch_alarms`

```yaml
trigger:
  source: aws_cloudwatch_alarms
  region: us-east-1
  alarm_names:                 # 任意。省略するとリージョン内の全アラームを購読
    - prod-checkout-5xx
  transitions:                 # 任意。発火する遷移先 state。既定 ["ALARM"]
    - ALARM
    - OK
  interval_sec: 60
```

| フィールド | 役割 |
|---|---|
| `region` | AWS リージョン |
| `alarm_names` | 監視対象アラーム名のリスト（省略時は region 内全体） |
| `transitions` | 発火する遷移先 state。`OK` / `ALARM` / `INSUFFICIENT_DATA` のいずれか（CloudWatch のリテラルそのまま） |
| `interval_sec` | ポーリング間隔（秒） |

認証は AWS SDK 標準チェーン（`aws_cloudwatch_logs` と同じ）。SDK は当該トリガーが存在するときのみ動的 import。同じ `(region, alarm_names)` を購読する複数ランブックは 1 つのポーラーを共有し、`transitions` フィルタは matcher 側で個別適用される。MetricAlarm と CompositeAlarm の両方を購読する。

### `datadog_monitors`

```yaml
trigger:
  source: datadog_monitors
  site: datadoghq.com
  monitor_tags:                # 任意。Datadog SDK の monitorTags へ AND 連結で渡す
    - "env:prod"
  transitions:                 # 任意。発火する遷移先 state。既定 ["alert"]
    - alert
    - warn
  interval_sec: 60
```

認証は環境変数 `DD_API_KEY` / `DD_APP_KEY` を mihari が読み、SDK にそのまま渡す。同じ `(site, monitor_tags)` を購読する複数ランブックは 1 つのポーラーを共有し、`transitions` フィルタは matcher 側で個別適用される。

## Agent

```yaml
agent:
  prompt: |
    Investigate {{ event.line }} and decide what to do.
  prompt_file: prompts/investigate.md     # prompt と排他
  system: You are an on-call agent.       # 任意
  system_file: prompts/system.md          # 任意。system と排他
  model: claude-opus-4-7                  # 既定 claude-opus-4-7

  allowed_tools:                          # 必須・非空
    - Read
    - "Bash(curl:*)"
    - "Bash(jq:*)"
    - "Bash(git status:*)"

  permission_mode: strict                 # strict（既定）/ bypass
  max_turns: 30                           # 既定 30
  timeout_sec: 600                        # 既定 600
  conventions: false                      # 既定。PR 冪等性 preamble の opt-in
  cwd: /home/user/work                    # 絶対パス。既定 process.cwd()
```

| フィールド | 役割 |
|----------|------|
| `prompt` / `prompt_file` | プロンプト本文かそのファイル（排他、どちらか必須） |
| `system` / `system_file` | system プロンプト（任意、排他） |
| `model` | モデル ID（既定 `claude-opus-4-7`） |
| `allowed_tools` | ツール許可リスト。`Read` / `Edit` / `Write` のような名前と `Bash(<command>:*)` / `Bash(<exact>)` のパターンを混在できる。**非空必須**。リスト外のツール呼び出しはプロンプトを出さずに拒否される |
| `permission_mode` | `strict`（既定）は `canUseTool` で全ツール呼び出しを判定。`bypass` は `allowDangerouslySkipPermissions` を立てる |
| `max_turns` | 最大ターン数。mihari 既定 `30` |
| `timeout_sec` | エージェント実行全体のタイムアウト秒。mihari 既定 `600` |
| `cwd` | エージェントの作業ディレクトリ（絶対パス）。既定は mihari 起動時のディレクトリ |
| `conventions` | `true` で、`claude/fix-$MIHARI_IDEMPOTENCY_KEY` を branch 名にする / 既存 branch / 既存 open PR / dirty tree を検出したらスキップする旨の preamble を冒頭に挿入する。preamble は `git status:*` / `git ls-remote:*` / `gh pr list:*` を要求するので、有効化する場合は `allowed_tools` に追加すること。既定 `false` |

合成された system prompt の順序は `[conventions preamble（true のとき）] → [user system]`。

## SaaS 連携

mihari 自体は SaaS（Datadog / Jira / Slack 等）の呼び出し作法を agent に注入しない。認証 env 名・エンドポイント・curl 例・冪等性パターンは、ランブック著者が `agent.prompt` または `agent.system` に直接書く責務。

実例は `runbooks/examples/dd-monitor-jira.yaml` などを参照。`MIHARI_IDEMPOTENCY_KEY` は agent の env に常時注入されるので、重複検出（issue 検索 / branch 名 / message タグ等）にそのまま使える。

## 変数

`agent.prompt` / `agent.system` および対応する `_file` の中身は `{{ ... }}` で展開される。

| 変数 | `file` | `cron` | `aws_cloudwatch_logs` | `aws_cloudwatch_alarms` | `datadog_monitors` |
|------|--------|--------|---|---|---|
| `{{ event.line }}` | マッチ行 | 空文字 | event の message | 空文字 | 空文字 |
| `{{ event.path }}` | ログファイルパス | 空文字 | log_group 名 | 空文字 | 空文字 |
| `{{ event.timestamp }}` | 行を読んだ時刻 (ISO 8601) | 発火時刻 | event の timestamp | 遷移観測時刻 | 遷移観測時刻 |
| `{{ event.log_stream }}` | 空文字 | 空文字 | log_stream 名 | 空文字 | 空文字 |
| `{{ event.monitor_id }}` | 空文字 | 空文字 | 空文字 | 空文字 | Datadog monitor id |
| `{{ event.monitor_name }}` | 空文字 | 空文字 | 空文字 | 空文字 | Datadog monitor 名 |
| `{{ event.alarm_name }}` | 空文字 | 空文字 | 空文字 | CloudWatch alarm 名 | 空文字 |
| `{{ event.alarm_arn }}` | 空文字 | 空文字 | 空文字 | CloudWatch alarm ARN | 空文字 |
| `{{ event.from_state }}` | 空文字 | 空文字 | 空文字 | 直前の alarm state | 直前の monitor state |
| `{{ event.to_state }}` | 空文字 | 空文字 | 空文字 | 現在の alarm state | 現在の monitor state |
| `{{ env.<NAME> }}` | `process.env[NAME]` | 同左 | 同左 | 同左 | 同左 |

エージェントの Bash tool 子プロセスには次が env として追加される:

- `MIHARI_IDEMPOTENCY_KEY` — runbook id と trigger event から決定的に算出する 12 桁 hex。同じトリガーが再観測されたら同じキーになる。Jira issue 検索の JQL や branch 名に混ぜて重複検知に使う

## バリデーション

```bash
mihari validate runbooks/dd-monitor-jira.yaml
mihari validate runbooks/                # ディレクトリを渡すと中身を全部検証
```

## サンプル

`runbooks/examples/` を参照:

- `dd-monitor-jira.yaml` — Datadog monitor 遷移 → Jira 起票/クローズ
- `file-slack-alert.yaml` — アプリログ ERROR → Slack 一次切り分け
- `cron-health-agent.yaml` — 定期 health check → 失敗時 Slack 通知
- `cw-error-triage.yaml` — CloudWatch Logs ERROR → Slack 一次切り分け
- `cw-alarm-pagerduty.yaml` — CloudWatch alarm 遷移 → PagerDuty trigger/resolve
