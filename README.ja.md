# mihari

> **日本語** | [English](./README.md)

ローカルのログファイル、cron スケジュール、CloudWatch Logs、Datadog Monitor に反応して **Claude agent** を実行する CLI。

> mihari (見張り) — シグナルを見張って、Claude agent に対応を任せる軽量エンジン。

## できること

- ログファイルを定期ポーリング（tail 相当）。新規行が正規表現にマッチでランブック起動
- cron 式で時刻ベースの定期実行（HTTP 監視は agent に `Bash(curl:*)` を許可して書く）
- CloudWatch Logs を `interval_sec` 間隔でポーリング（ローカル `file` トリガーと対称、AWS SDK は使うときだけ動的 import）
- Datadog Monitor をポーリングし、`ok -> alert` などの状態遷移 1 件ごとに発火（Datadog SDK は使うときだけ動的 import）
- ランブックは **agent 1 本** で実行（Agent SDK ループ、ファイル編集 / Bash ツール経由）。Datadog / Jira / Slack のような外部 SaaS は `providers:` を opt-in で宣言すると、各サービスの作法 preamble が system prompt に挿入される。認証は env、YAML には書かない
- ファイル位置 / 発火時刻を `~/.mihari/state/` に保存

## クイックスタート

```bash
npm install
npm run build

# ランブックを書く
cat > runbooks/dd-monitor-jira.yaml <<'YAML'
id: dd-monitor-jira
trigger:
  source: datadog_monitors
  site: datadoghq.com
  monitor_tags: [env:prod]
  transitions: [alert, ok]
  interval_sec: 60
agent:
  prompt: |
    Datadog monitor "{{ event.monitor_name }}" が
    {{ event.from_state }} -> {{ event.to_state }} に遷移した。
    調査して Jira を起票またはクローズせよ。
  providers: [datadog, jira]
  allowed_tools:
    - "Bash(curl:*)"
    - "Bash(jq:*)"
YAML

# 常駐モード
npx mihari daemon

# 1回だけポーリング（cron 向け）
npx mihari poll

# 履歴を見る
npx mihari history
```

## ドキュメント

| | |
|------------|------|
| [doc/cli.ja.md](./doc/cli.ja.md) | CLI コマンドリファレンス |
| [doc/runbook-spec.ja.md](./doc/runbook-spec.ja.md) | ランブック YAML 仕様 |
| [runbooks/examples/](./runbooks/examples/) | サンプルランブック |

開発者向けの設計方針・内部仕様は [CLAUDE.md](./CLAUDE.md)。

## チェック

リポジトリ構造の検証は [monban](https://github.com/Mulyu/monban)。

```bash
npx @mulyu/monban all
```
