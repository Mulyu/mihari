# mihari

Slack / Datadog をポーリングし、検知したイベントに対応する **AIランブック** を実行するCLIツール。

> mihari (見張り) — アラートを見張り、Claudeに調査・対応させる軽量エンジン。

## なにをするもの

- Datadog や Slack を定期ポーリングしてアラートを拾う
- アラートにマッチするランブック（YAML）を見つけて実行する
- ランブックは `bash` ステップと `claude` ステップ（Claude Agent SDK）の混在
- read-only な調査は自動、write系は承認フロー
- ローカル常駐（`daemon`）でも、GitHub Actions上のワンショット（`poll`）でも動く

## なにをしないもの

- Webhookサーバの提供（明示的に作らない。ポーリングで倒す）
- 取りこぼしゼロの保証（重複は許容、冪等性はランブック責務）
- 非エンジニア向けGUI

## 全体像

```
┌──────────┐      ┌──────────┐      ┌──────────┐
│ Pollers  │      │ Matcher  │      │ Executor │
│ datadog  │ ───► │ trigger  │ ───► │  steps   │
│ slack    │event │  rules   │ run  │  loop    │
└──────────┘      └──────────┘      └────┬─────┘
                                         │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                    ┌──────────┐  ┌──────────┐  ┌──────────┐
                    │  bash    │  │  claude  │  │ approval │
                    │  step    │  │  step    │  │  gate    │
                    └──────────┘  └────┬─────┘  └──────────┘
                                       ▼
                              Claude Agent SDK
                              (Bash, Read, MCP...)
```

## クイックスタート

```bash
# 1. インストール
npm install
npm run build

# 2. ランブックを書く（runbooks/*.yaml）
cp runbooks/examples/aurora-pgsql-tmp.yaml runbooks/

# 3. ローカルで一回だけポーリング
DD_API_KEY=... DD_APP_KEY=... ANTHROPIC_API_KEY=... \
  npx runbook poll datadog --since 10m

# 4. ランブックを直接実行（テスト・手動）
npx runbook run aurora-pgsql-tmp-investigate

# 5. 常駐モード
npx runbook daemon
```

## ランブックの最小例

```yaml
id: aurora-pgsql-tmp-investigate
description: Aurora pgsql_tmp ディスク逼迫の調査
trigger:
  source: datadog
  match:
    monitor_tags: ["service:aurora"]
    title_pattern: "pgsql_tmp|disk"
permissions: read-only
steps:
  - id: collect_clusters
    bash: aws rds describe-db-clusters --output json
    capture: clusters_json
  - id: investigate
    claude:
      prompt: |
        対象クラスタ: {{ steps.collect_clusters.output }}
        pg_stat_activity を確認し、長時間 temp_files を生成しているクエリを特定して #alerts-aurora にサマリ投稿してください。
      allowed_tools: ["Bash", "Read", "mcp__slack__*"]
```

詳しくは [doc/runbook-spec.md](./doc/runbook-spec.md) を参照。

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [doc/architecture.md](./doc/architecture.md) | 全体アーキテクチャと処理フロー |
| [doc/cli.md](./doc/cli.md) | CLIコマンドリファレンス |
| [doc/runbook-spec.md](./doc/runbook-spec.md) | ランブックYAML仕様、ステップ種別、変数システム |
| [doc/pollers.md](./doc/pollers.md) | Datadog / Slack Pollerの仕様 |
| [doc/state.md](./doc/state.md) | ステート管理（重複防止、S3同期） |
| [doc/permissions.md](./doc/permissions.md) | read-only / write 権限モデル |
| [doc/approval.md](./doc/approval.md) | 承認フロー（write系） |
| [doc/github-actions.md](./doc/github-actions.md) | GHAでの運用方法 |
| [doc/development.md](./doc/development.md) | 開発スコープとロードマップ |

## ステータス

MVP（Phase 1）開発中。現時点のスコープは [doc/development.md](./doc/development.md) を参照。

## ライセンス

未定。
