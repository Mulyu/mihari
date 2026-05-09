# mihari

> **日本語** | [English](./README.md)

ローカルのログファイル、cron スケジュール、CloudWatch Logs、または Datadog Monitor に反応して bash ランブックを実行する CLI。

> mihari (見張り) — ログを見張って、決まった対応を自動で走らせる軽量エンジン。

## できること

- ログファイルを定期ポーリング（tail 相当）。新規行が正規表現にマッチでランブック起動
- cron 式で時刻ベースの定期実行（HTTP 監視は `bash` + `curl` で書く）
- CloudWatch Logs を `interval_sec` 間隔でポーリング（ローカル `file` トリガーと対称、AWS SDK は使うときだけ動的 import）
- Datadog Monitor をポーリングし、`ok -> alert` などの状態遷移 1 件ごとに発火（Datadog SDK は使うときだけ動的 import）
- ランブックは `bash` / `claude`（単発の Anthropic API 呼び出し）/ `claude_agent`（Agent SDK ループ、ファイル編集・Bash ツール経由で副作用あり）ステップで構成
- ファイル位置 / 発火時刻を `~/.mihari/state/` に保存

## クイックスタート

```bash
npm install
npm run build

# ランブックを書く
cat > runbooks/disk-full.yaml <<'YAML'
id: disk-full-cleanup
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
steps:
  - id: cleanup
    bash: /usr/local/bin/cleanup-tmp.sh
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
