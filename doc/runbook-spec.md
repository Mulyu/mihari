# Runbook Specification

ランブックYAMLの仕様。

## ファイル配置

```
runbooks/
├── aurora-pgsql-tmp.yaml
├── ecs-task-failure.yaml
└── examples/
    └── ...
```

`runbooks/` 配下の `*.yaml` を起動時に全部ロードする。`examples/` は明示的にコピーするまで使われない（推奨慣習）。

## 全体構造

```yaml
id: aurora-pgsql-tmp-investigate     # ユニークID（必須、kebab-case推奨）
description: ...                      # 人間向け説明
version: 1                            # スキーマバージョン

trigger:                              # 必須（runで使うときも形式上書く）
  source: datadog                     # datadog | slack
  match:
    monitor_tags: ["service:aurora"]
    title_pattern: "pgsql_tmp|disk"

permissions: read-only                # read-only | write
require_approval: false               # write のとき true 推奨

inputs:                               # トリガーから抽出する変数（任意）
  alert_id: "{{ event.id }}"
  title: "{{ event.title }}"

steps:                                # 必須
  - id: step1
    bash: ...
  - id: step2
    claude:
      prompt: ...
```

## トリガー

```yaml
trigger:
  source: datadog
  match:
    monitor_tags: ["service:aurora", "env:prod"]    # 全部含むときマッチ
    title_pattern: "pgsql_tmp|disk full"            # 正規表現
    alert_type: ["error", "warning"]                # 任意
```

```yaml
trigger:
  source: slack
  match:
    channel: "C01234567"                            # チャンネルID
    user_pattern: "^U.*BOT.*$"                      # bot投稿のみ等
    text_pattern: "P1 alert"
```

複数ランブックが同一イベントにマッチしたら **全て並列実行**。衝突回避はランブック側の責務。

## ステップ

### `bash` ステップ

```yaml
- id: collect_clusters
  bash: |
    aws rds describe-db-clusters \
      --query 'DBClusters[?starts_with(DBClusterIdentifier, `prod-`)]' \
      --output json
  capture: clusters_json              # stdout を変数に格納
  timeout_sec: 30                     # デフォ60秒
  on_error: stop                      # stop | continue（デフォ stop）
  env:
    AWS_REGION: ap-northeast-1
```

| フィールド | 内容 |
|----------|------|
| `bash` | シェルスクリプト本文（複数行可） |
| `capture` | stdout を格納する変数名 |
| `timeout_sec` | タイムアウト秒数 |
| `on_error` | 失敗時の挙動（`stop` でランブック停止、`continue` で次へ） |
| `env` | 環境変数追加 |

### `claude` ステップ

```yaml
- id: investigate
  claude:
    prompt: |
      Datadogアラート: {{ inputs.title }}
      対象: {{ steps.collect_clusters.output }}
      pg_stat_activity を確認し、長時間 temp_files を生成しているクエリを特定してください。
    allowed_tools: ["Bash", "Read", "mcp__slack__*"]
    max_turns: 20
    timeout_sec: 600
    system_prompt: ...                # 任意。デフォはClaude Code相当
    mcp_servers: ["slack", "github"]  # 任意。設定済みMCPから有効化
  capture: investigation_summary       # 最終アシスタント応答を格納
  on_error: stop
```

| フィールド | 内容 |
|----------|------|
| `prompt` | プロンプト本文。テンプレ展開可 |
| `allowed_tools` | 許可ツール（[permissions.md](./permissions.md) 参照） |
| `max_turns` | 最大ターン数（デフォ 20） |
| `timeout_sec` | タイムアウト秒数（デフォ 600） |
| `system_prompt` | システムプロンプト上書き |
| `mcp_servers` | 有効化するMCPサーバ名 |
| `capture` | 最終応答テキストを格納する変数名 |

`@anthropic-ai/claude-agent-sdk` を呼び出す。デフォルトは新規セッション。

### `approval` ステップ

```yaml
- id: confirm_restart
  approval:
    channel: "#ops-approvals"
    message: |
      ECSタスクを再起動します。承認してください。
      対象: {{ steps.identify.output }}
    timeout_sec: 1800                 # 30分
    require_reactions: ["white_check_mark"]
    require_count: 1
  on_error: stop
```

Slackに承認カードを投稿し、指定リアクションが付くまでポーリング。詳細は [approval.md](./approval.md)。

## 変数システム

テンプレ構文は `{{ ... }}`。展開タイミングはステップ実行直前。

| 変数 | 内容 |
|------|------|
| `{{ inputs.<key> }}` | トリガーから抽出した `inputs:` 定義の値 |
| `{{ event.<field> }}` | Pollerが返したイベントの生フィールド |
| `{{ steps.<id>.output }}` | 指定ステップの `capture` 結果 |
| `{{ env.<NAME> }}` | 環境変数 |

`bash` の `capture` は stdout、`claude` の `capture` は最終アシスタント応答。これが「bashとclaudeを混ぜる接着剤」。

## 権限とデフォルトツール

```yaml
permissions: read-only       # 自動実行
permissions: write           # 承認必須
```

詳細は [permissions.md](./permissions.md)。

## バリデーション

```bash
runbook validate runbooks/aurora-pgsql-tmp.yaml
```

CIで全ランブックを検証することを推奨。

## 完全なサンプル

```yaml
id: aurora-pgsql-tmp-investigate
description: Aurora pgsql_tmp ディスク逼迫の調査
version: 1

trigger:
  source: datadog
  match:
    monitor_tags: ["service:aurora"]
    title_pattern: "pgsql_tmp|disk"

permissions: read-only
require_approval: false

inputs:
  alert_id: "{{ event.id }}"
  monitor_id: "{{ event.monitor_id }}"
  title: "{{ event.title }}"

steps:
  - id: collect_clusters
    bash: |
      aws rds describe-db-clusters \
        --query 'DBClusters[?starts_with(DBClusterIdentifier, `prod-`)]' \
        --output json
    capture: clusters_json
    timeout_sec: 30

  - id: investigate
    claude:
      prompt: |
        Datadogアラート: {{ inputs.title }}
        対象クラスタ:
        ```json
        {{ steps.collect_clusters.output }}
        ```

        以下を実行してください:
        1. 各クラスタに psql で接続し pg_stat_activity を確認
        2. 長時間 temp_files を生成しているクエリを特定
        3. 結果を3行サマリで #alerts-aurora にSlack投稿（slack MCPツール使用）
      allowed_tools: ["Bash", "Read", "mcp__slack__*"]
      max_turns: 20
      timeout_sec: 600
    capture: investigation_summary
```
