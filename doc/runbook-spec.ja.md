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

### `datadog_logs`

```yaml
trigger:
  source: datadog_logs
  site: datadoghq.com
  query: "service:checkout status:error"   # Datadog Logs Search のクエリ文字列
  interval_sec: 60
```

| フィールド | 役割 |
|---|---|
| `site` | Datadog のサイト |
| `query` | Datadog Logs Search のクエリ文字列 |
| `interval_sec` | ポーリング間隔（秒） |

認証は `datadog_monitors` と同じく env `DD_API_KEY` / `DD_APP_KEY`。SDK は当該トリガーが存在するときのみ動的 import（`datadog_monitors` と同じパッケージを共有）。同じ `(site, query)` を購読する複数ランブックは 1 つのポーラーを共有する。

カーソルは timestamp ベースで、同 timestamp に並ぶ event id を境界 dedup 用に保持する（`aws_cloudwatch_logs` と同じパターン）。1 tick で取り切れない場合は次 tick に持ち越す。

### `jira_search`

```yaml
trigger:
  source: jira_search
  base: https://example.atlassian.net      # Jira のベース URL（末尾スラッシュは無視）
  jql: project = OPS AND status = Open     # ORDER BY は書かない
  interval_sec: 120
```

| フィールド | 役割 |
|---|---|
| `base` | Jira のベース URL（`http://` または `https://`） |
| `jql` | 検索条件。`ORDER BY` は書かない（poller が `updated ASC` で並べる） |
| `interval_sec` | ポーリング間隔（秒） |

認証は環境変数 `JIRA_USER` / `JIRA_TOKEN` から basic 認証を組む。SDK は使わず Node 標準の global fetch を使う（動的 import なし）。同じ `(base, jql)` を購読する複数ランブックは 1 つのポーラーを共有する。

API エンドポイントは Jira Cloud の `/rest/api/3/search/jql` を `POST` で叩く。旧 `/rest/api/3/search` は Jira Cloud で廃止されたため使わない。ページングは `nextPageToken` トークンベース（cap 50 hop）。

カーソルは Jira issue の `updated` を ms 値で保持し、同 ms に並ぶ issue_key を境界 dedup 用に保持する。`updated >=` の JQL 比較は分粒度なので、分境界に丸めた時刻をフィルタに使う。

### `github_workflow_runs`

```yaml
trigger:
  source: github_workflow_runs
  repo: example/app
  branch: main                 # 任意。matcher で filter
  workflows:                   # 任意。"ci.yml" / ".github/workflows/ci.yml" / workflow 名のいずれか
    - ci.yml
  conclusions:                 # 任意。発火する conclusion。既定 ["failure"]
    - failure
    - cancelled
  interval_sec: 60
```

| フィールド | 役割 |
|---|---|
| `repo` | `owner/repo` 形式 |
| `branch` | 任意。filter on `head_branch` |
| `workflows` | 任意。filter on workflow 名 / file path / slug |
| `conclusions` | 任意。`success` / `failure` / `cancelled` / `skipped` / `timed_out` / `action_required` / `neutral` / `startup_failure` / `stale` のいずれか（GitHub のリテラルそのまま）。既定 `["failure"]` |
| `interval_sec` | ポーリング間隔（秒） |

認証は env `GH_TOKEN`（Bearer）。SDK は使わず Node 標準の global fetch。同じ `repo` を購読する複数ランブックは 1 つのポーラーを共有し、`branch` / `workflows` / `conclusions` のフィルタは matcher 側で個別適用される。

カーソルは run id（monotonic）。初回 seed では top の run id を保存して過去履歴を遡らない。tick 中は page 1 から DESC 順に取得し、cursor 以下の run id を 1 件見つけたらページングを打ち切る。

### `sentry_issues`

```yaml
trigger:
  source: sentry_issues
  base: https://sentry.io               # SaaS / self-hosted どちらも可
  organization: my-org
  project: my-project
  levels:                                # 任意。発火対象の level。既定 ["error", "fatal"]
    - error
    - fatal
  interval_sec: 60
```

| フィールド | 役割 |
|---|---|
| `base` | Sentry のベース URL |
| `organization` | Sentry org slug |
| `project` | Sentry project slug |
| `levels` | 任意。`fatal` / `error` / `warning` / `info` / `debug` / `sample`（Sentry のリテラルそのまま）。既定 `["error", "fatal"]` |
| `interval_sec` | ポーリング間隔（秒） |

認証は env `SENTRY_AUTH_TOKEN` (Bearer)。SDK は使わず Node 標準の global fetch。同じ `(base, organization, project)` を購読する複数ランブックは 1 つのポーラーを共有し、`levels` フィルタは matcher 側で個別適用される。

カーソルは `{issue_id -> last_seen_ms}` map。`is:unresolved` の issue を 24h 窓で観測し、未知 issue は `is_new=true` で fire、既知 issue は `last_seen` が進んだら fire する。datadog_monitors と同じ「前回 state ∪ 今回観測分」merge 方式。


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

主要なテンプレ変数（トリガー別に値が変わるもの）:

- `{{ event.line }}` — file の行 / aws_cloudwatch_logs の message / datadog_log の message
- `{{ event.path }}` — file のパス / aws_cloudwatch_logs の log_group / datadog_log の query
- `{{ event.timestamp }}` — すべて。発火または遷移観測時刻（ISO 8601）
- `{{ event.log_stream }}` — aws_cloudwatch_logs のみ
- `{{ event.service }}` — datadog_log のみ
- `{{ event.host }}` — datadog_log のみ
- `{{ event.alarm_name }}` / `{{ event.alarm_arn }}` — aws_cloudwatch_alarm のみ
- `{{ event.monitor_id }}` / `{{ event.monitor_name }}` — datadog_monitor のみ
- `{{ event.issue_key }}` / `{{ event.summary }}` — jira_issue のみ
- `{{ event.status }}` — jira_issue / sentry_issue
- `{{ event.issue_id }}` / `{{ event.title }}` / `{{ event.level }}` / `{{ event.permalink }}` — sentry_issue のみ
- `{{ event.run_id }}` / `{{ event.workflow_name }}` / `{{ event.branch }}` / `{{ event.conclusion }}` / `{{ event.html_url }}` — github_workflow_run のみ
- `{{ event.from_state }}` / `{{ event.to_state }}` — aws_cloudwatch_alarm / datadog_monitor
- `{{ env.<NAME> }}` — `process.env[NAME]`

該当しないトリガーで参照したテンプレ変数は空文字に展開される。

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
- `dd-logs-pagerduty.yaml` — Datadog Logs ERROR → PagerDuty trigger
- `jira-open-incident-slack.yaml` — Jira incident updated → Slack 通知
- `github-ci-fix.yaml` — GitHub Actions CI 失敗 → 修正 PR を agent が作成
- `sentry-jira.yaml` — Sentry issue 新規 or regression → Jira 起票
