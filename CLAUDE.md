# CLAUDE.md

このリポジトリで作業するときの設計方針。

## プロジェクト概要

**mihari** はローカルのログファイルをポーリングし、マッチした行に対してbashランブックを実行するCLIツール。

- ログファイルを定期ポーリング（tail相当）
- 新規行が正規表現にマッチしたらランブック実行
- ランブックは `bash` ステップのみ
- ファイル位置（オフセット）はstateに保存

## 設計原則

### 1. ポーリングのみ。Webhookは作らない

inotify や Webhook は使わない。**全部ポーリングで倒す**。シンプルさと移植性を優先。

### 2. 重複実行は許容、冪等性はランブック側責務

「絶対に1回だけ実行」は捨てる。代わりに：

- ファイルオフセットを永続化して**ベストエフォートで防ぐ**
- それでも漏れたら、ランブック側で副作用を冪等に書く

state破損で全ポーリングが止まるほうがリスクが大きいので、**state書き込み失敗は fail-open**（ログのみ残して処理続行）。

### 3. ステップは bash のみ

MVPでは `bash` ステップだけ。Claude や承認フローは将来拡張として残すが、コードもドキュメントもまだ書かない。

### 4. ローカル前提

state は `~/.mihari/state/` に直接I/O。リモート同期は無し。複数マシンで動かす想定もしない。

## ディレクトリ構造

```
mihari/
├── README.md
├── CLAUDE.md                   # ← これ
├── doc/                        # 詳細マニュアル
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts                  # コマンド分岐（commander）
│   ├── core/
│   │   ├── runbook-loader.ts   # YAML → 内部表現
│   │   ├── executor.ts         # ステップループ
│   │   ├── matcher.ts          # trigger評価
│   │   └── state.ts            # ローカルstate I/O
│   ├── steps/
│   │   └── bash-step.ts
│   ├── pollers/
│   │   └── file.ts             # ログファイル tail
│   └── types.ts
└── runbooks/                   # ユーザーランブック置き場
```

## 主要ライブラリ

| 用途 | 採用 |
|------|------|
| CLI | `commander` |
| YAML | `yaml` |
| ファイルロック | `proper-lockfile` |
| ロギング | `pino` |

## コーディング規約

- TypeScript strict
- I/O境界（外部ファイル、ユーザー入力）でのみバリデーション
- エラー処理は state書き込みなど fail-open が妥当な箇所と、それ以外を区別。デフォルトは投げる
- コメントは **WHY** のみ。WHATは識別子で表現
- ログは `pino` で構造化JSON

## やらないこと（Non-Goals）

- Webhookサーバ
- Datadog / Slack 連携
- Claude / AI 連携
- 承認フロー
- リモートステート同期（S3等）
- GUI
- マルチテナント
