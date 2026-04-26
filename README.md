# mihari

ローカルのログファイル、または cron スケジュールに反応して bash ランブックを実行する CLI。

> mihari (見張り) — ログを見張って、決まった対応を自動で走らせる軽量エンジン。

## できること

- ログファイルを定期ポーリング（tail 相当）。新規行が正規表現にマッチでランブック起動
- cron 式で時刻ベースの定期実行（HTTP 監視は `bash` + `curl` で書く）
- ランブックは `bash` ステップ
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
| [doc/cli.md](./doc/cli.md) | CLI コマンドリファレンス |
| [doc/runbook-spec.md](./doc/runbook-spec.md) | ランブック YAML 仕様 |
| [runbooks/examples/](./runbooks/examples/) | サンプルランブック |

開発者向けの設計方針・内部仕様は [CLAUDE.md](./CLAUDE.md)。

## チェック

リポジトリ構造の検証は [monban](https://github.com/Mulyu/monban)。

```bash
npx @mulyu/monban all
```
