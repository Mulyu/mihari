# CLAUDE.md

このリポジトリで作業するときの設計方針・運用ルール。Claude Code が読む前提で書いている。

## プロジェクト概要

**mihari** は Slack / Datadog をポーリングして、検知したイベントに対応するAIランブックを実行するCLIツール。

- ランブックは YAML で書く（`runbooks/*.yaml`）
- ステップは `bash` / `claude` / `approval` の混在
- `claude` ステップは [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) を呼ぶ
- 実行モードは `daemon`（常駐）と `poll`（GHA向けワンショット）

## 設計原則

### 1. ポーリング一本足、Webhookは作らない

Webhookサーバを持たない。受信エンドポイントを公開する責務・運用コストを避ける。**全部ポーリングで倒す**：

- Datadog: `GET /api/v1/events`
- Slack: `conversations.history`
- 承認: スレッドのリアクションを定期取得

cronジッタによる取りこぼしは `--since` のバッファ（cron間隔 + 1分）で吸収。

### 2. 重複実行は許容、冪等性はランブック側責務

「絶対に1回だけ実行」は捨てる。代わりに：

- 処理済みイベントIDを ring buffer で保持して**ベストエフォートで防ぐ**（トークン代と副作用が重いので入れる価値はある）
- それでも漏れたら、ランブック側で副作用を冪等に書く

state破損で全ポーリングが止まるほうがリスクが大きいので、**state書き込み失敗は fail-open**（ログのみ残して処理続行）。

### 3. read-only と write を明確に分ける

- `permissions: read-only` → `Bash(read)` `Read` `WebFetch` など読み取り系のみ。自動実行。
- `permissions: write` → 全ツール解放。**承認必須**（Slackリアクションでポーリング待ち）。

`read-only` の `Bash` 制限はv1では信用ベース。v2でwhitelistラッパを入れる。

### 4. bash と claude を混ぜる「接着剤」は変数システム

```yaml
- id: collect
  bash: aws rds describe-db-clusters --output json
  capture: clusters_json
- id: analyze
  claude:
    prompt: "対象: {{ steps.collect.output }}"
```

- `{{ inputs.* }}` トリガーから抽出
- `{{ event.* }}` Pollerが返した生フィールド
- `{{ steps.<id>.output }}` 直前ステップのcapture
- `{{ env.* }}` 環境変数

決定論的な処理（データ収集、外部CLI起動）は `bash`、判断・要約・調査は `claude` に任せる。

### 5. ローカルとGHAで同じバイナリ

- ローカル常駐 → `runbook daemon`
- GHA cron → `runbook poll <source> --since 6m`

stateは：
- ローカル: `~/.runbook/state/` に直接 I/O
- GHA: 起動時にS3からpull、終了時にpush（`concurrency.group` で直列化）

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
│   │   ├── template.ts         # {{ }} 展開
│   │   └── state.ts            # ローカルstate I/O
│   ├── steps/
│   │   ├── bash-step.ts
│   │   ├── claude-step.ts      # @anthropic-ai/claude-agent-sdk
│   │   └── approval-step.ts
│   ├── pollers/
│   │   ├── datadog.ts
│   │   └── slack.ts
│   └── types.ts
├── runbooks/                   # ユーザーランブック置き場
│   └── examples/
└── .github/workflows/
    └── runbook-poll.yaml
```

## 主要ライブラリ

| 用途 | 採用 |
|------|------|
| Claude実行 | `@anthropic-ai/claude-agent-sdk` |
| CLI | `commander` |
| YAML | `yaml` |
| Slack | `@slack/web-api` |
| Datadog | `@datadog/datadog-api-client` |
| テンプレ | `mustache`（または手書き軽量実装） |
| ファイルロック | `proper-lockfile` |
| ロギング | `pino` |

## コーディング規約

- TypeScript strict
- I/O境界（外部API、ファイル、ユーザー入力）でのみバリデーション。内部関数では信頼する
- エラー処理は「state書き込み」など fail-open が妥当な箇所と、それ以外を区別する。デフォルトは投げる
- 短いコメントは禁止しないが、**WHATは書かない、WHYのみ**
- ログは `pino` で構造化JSON

## テスト方針

- ユニットテスト: `template.ts` `matcher.ts` `state.ts` の純粋ロジックは必須
- 統合テスト: ランブック実行の golden path をモックイベントで検証（v2で `runbook run --dry-run`）
- E2E: 手動。Datadogのテストモニターを叩いて流す

## やらないこと（Non-Goals）

- Webhookサーバ
- 取りこぼしゼロ保証
- GUI
- ランブックのバージョニング・差分管理（git管理で十分）
- マルチテナント

## 参考

- 設計の元ネタは PR/Issue 上の設計ドキュメント
- 詳細仕様は `doc/` を参照、コマンドリファレンスは `doc/cli.md`
