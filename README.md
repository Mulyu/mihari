# mihari

ローカルのログファイル、または cron スケジュールに反応して **bashランブック** を実行するCLIツール。

> mihari (見張り) — ログを見張って、決まった対応を自動で走らせる軽量エンジン。

## なにをするもの

- ローカルのログファイルを定期ポーリング（tail相当）。新規行が正規表現にマッチしたらランブック起動
- cron 式で時刻ベースの定期実行も可能（HTTP合成監視は `bash` + `curl` で書く）
- ランブックは `bash` ステップのみ
- ファイル位置（オフセット）/ cron 発火時刻を state に保存して、次回起動時の重複・取りこぼしを抑える

## なにをしないもの

- Webhookサーバ
- Datadog / Slack 連携
- AI（Claude）連携
- 承認フロー
- リモートストレージ連携

これらは将来の拡張余地として置いておくが、MVPでは**含めない**。

## クイックスタート

```bash
npm install
npm run build

# ランブックを書く（runbooks/*.yaml）
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

# 1回だけポーリング（cron向け）
npx mihari poll
```

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [doc/architecture.md](./doc/architecture.md) | 実行アーキテクチャ |
| [doc/cli.md](./doc/cli.md) | CLIコマンドリファレンス |
| [doc/runbook-spec.md](./doc/runbook-spec.md) | ランブックYAML仕様 |

## チェック

リポジトリ構造の検証は [monban](https://github.com/Mulyu/monban) を使う。設定は `monban.yml`。

```bash
npx @mulyu/monban all
```

## ステータス

MVP開発中。
