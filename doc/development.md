# Development & Roadmap

開発スコープ、MVP範囲、ロードマップ、残論点。

## MVPスコープ（Phase 1）

**動かす範囲**:

- ✅ Datadog Pollerのみ（Slack Pollerはv2）
- ✅ `bash` / `claude` ステップ
- ✅ `read-only` 自動実行 / `write` は手動 `runbook run` のみ
- ✅ `daemon` と `poll --since`
- ✅ ローカルstate（処理済みID + ポーラーカーソル、`proper-lockfile` でロック）
- ✅ S3 state sync（GHA向け）
- ✅ サンプルランブック1つ（Aurora調査系）

**含めない**:

- Slack Poller
- 承認フロー（write系は手動runのみ）
- Bash whitelist
- ランブック実行履歴UI

## v2以降

- Slack Poller（メンション検知 / bot投稿二次トリガー）
- 承認フロー（リアクションポーリング、[approval.md](./approval.md)）
- Bash whitelist ラッパ（[permissions.md](./permissions.md)）
- ランブック実行履歴UI（`runbook history`）
- Datadog Eventへの処理済みタグ書き戻し（観測性向上）
- `runbook run --dry-run` でモックイベントを流すテスト機構
- ステップへの `on_error: retry(N)` `continue` サポート

## 開発環境セットアップ

```bash
# Node 20+ 推奨
nvm use 20

git clone https://github.com/<org>/mihari.git
cd mihari
npm install

# TypeScriptビルド
npm run build

# 開発時
npm run dev -- daemon

# テスト
npm test
npm run test:watch
```

## ディレクトリ構造

```
mihari/
├── README.md
├── CLAUDE.md
├── doc/                        # 詳細マニュアル
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts
│   ├── core/
│   │   ├── runbook-loader.ts
│   │   ├── executor.ts
│   │   ├── matcher.ts
│   │   ├── template.ts
│   │   └── state.ts
│   ├── steps/
│   │   ├── bash-step.ts
│   │   ├── claude-step.ts
│   │   └── approval-step.ts
│   ├── pollers/
│   │   ├── datadog.ts
│   │   └── slack.ts
│   └── types.ts
├── test/
├── runbooks/
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
| テンプレ | `mustache` または手書き軽量実装 |
| ファイルロック | `proper-lockfile` |
| ロギング | `pino` |
| テスト | `vitest` |

## ログ・観測性

- 全ランブック実行を JSON Lines で `~/.runbook/logs/{date}/{run_id}.jsonl` に記録
- 各ステップの input / output / duration / status を記録
- Datadog Logs にも投げる（オプション、tag: `service:runbook`）
- `runbook history` コマンドで過去の実行をレビュー（v2）

## テスト方針

| レイヤ | 方針 |
|--------|------|
| 純粋ロジック (`template.ts` `matcher.ts` `state.ts`) | ユニットテスト必須 |
| Step 実装 | `bash-step` は実コマンド、`claude-step` はSDKモックでスタブ化 |
| 統合 | モックイベントを流して executor を end-to-end で検証 |
| E2E | 手動。Datadogのテストモニターを叩いて流す |

## コーディング規約

- TypeScript strict
- I/O境界（外部API、ファイル、ユーザー入力）でのみバリデーション
- エラー処理は `state` 書き込みなど fail-open が妥当な箇所と、それ以外を区別。デフォルトは投げる
- コメントは **WHY** のみ。WHAT は識別子で表現
- 構造化ログは `pino`、`console.log` は使わない

## 残論点

- [ ] Bash whitelist の具体ルール（v2で詰める）
- [ ] Claude Agent SDK のセッション継続を使うか（デフォ新規でOKだが、明示オプトインの構文）
- [ ] ランブックのテストフレームワーク（`runbook run --dry-run` でモックイベント流す？）
- [ ] エラー時の挙動: `on_error: continue | stop | retry(N)` をステップに足すか
- [ ] 並列実行ランブックの上限・キュー管理
- [ ] ランブックのバージョニング戦略（git管理で十分か、IDにバージョン埋めるか）

## リリース戦略

- v0.x: MVP内部利用
- v1.0: Slack Poller + 承認フロー入り
- v2.0: Bash whitelist、履歴UI

セマンティックバージョニング。ランブックYAMLスキーマは `version: 1` で管理し、破壊的変更時にメジャー上げる。
