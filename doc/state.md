# State Management

ステートの保存内容、競合対策、GHAでのS3同期について。

## 目的

**重複実行を防ぐ**のが主目的。AIランブックはトークン代と副作用が重いので、ベストエフォートでも入れる価値が高い。

「絶対1回」は捨てる。漏れたらランブック側で冪等に書く前提。

## 保存内容

```
~/.runbook/state/
├── pollers/
│   ├── datadog.json        # last_seen_at, cursor等
│   └── slack.json
├── processed/
│   ├── datadog/
│   │   └── events.json     # 処理済みevent IDのring buffer
│   └── slack/
│       └── messages.json
└── runs/
    └── 2026-04-25/         # 日付別の実行履歴（古いものは自動削除）
        └── <run_id>.jsonl
```

## スキーマ

### `pollers/<source>.json`

```json
{
  "last_seen_at": "2026-04-25T01:23:45Z",
  "last_run_id": "run_abc123",
  "updated_at": "2026-04-25T01:24:00Z"
}
```

次回ポーリングの起点として `last_seen_at` を使う。

### `processed/<source>/events.json`

```json
{
  "max_size": 10000,
  "ttl_hours": 168,
  "events": [
    {
      "id": "6789012345",
      "processed_at": "2026-04-25T01:23:50Z",
      "runbook_id": "aurora-pgsql-tmp-investigate",
      "run_id": "run_abc123",
      "status": "success"
    }
  ]
}
```

ring buffer形式。`max_size` 超過分は古いものから捨てる。`ttl_hours` 経過したものは GC で削除。

### `runs/<date>/<run_id>.jsonl`

実行履歴。各ステップの input / output / duration / status を JSON Lines で記録。

## 読み書き戦略

```ts
class StateStore {
  async load(): Promise<void>;

  isProcessed(source: string, eventId: string): boolean;

  // 同期的に永続化、失敗時はログのみ（fail-open）
  async markProcessed(source: string, eventId: string, meta: ProcessedMeta): Promise<void>;

  async updatePollerCursor(poller: string, cursor: PollerCursor): Promise<void>;

  // 起動時 + 1日1回
  async gc(): Promise<void>;
}
```

書き込みは `proper-lockfile` でファイルロックし、`tmp + rename` のatomic write で行う。

## 失敗時の挙動

| 失敗 | 対応 |
|------|------|
| state書き込み失敗 | ログだけ残し処理続行（**fail-open**） |
| `markProcessed` が呼ばれずプロセス落ち | 次回そのイベントは重複実行される（許容） |
| state破損 | 新規 state として再生成、ログに warn 出力 |

state破損で全ポーリングが止まるほうが運用上のリスクが大きいので、書き込み失敗は致命にしない。

## 同時実行と競合

| 環境 | 同時実行の発生源 | 対策 |
|------|-----------------|------|
| ローカル `daemon` | 複数Pollerが同じstate fileに書く | `proper-lockfile` でファイルロック |
| ローカル `run` 並走 | ユーザーが複数CLIを叩く | 同上 |
| GHA `poll` | cron + workflow_dispatch の重なり | `concurrency.group` で直列化 |
| GHA + ローカル混在 | 両方走ってるとき | **諦める** → 重複実行は許容 |

## GHAでの永続化（S3同期）

ステートのread/writeを起動時/終了時のフックで実装：

```yaml
jobs:
  poll-datadog:
    concurrency:
      group: runbook-poll-datadog
      cancel-in-progress: false
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-northeast-1

      # 起動時: pull
      - name: Pull state from S3
        run: |
          mkdir -p ~/.runbook/state
          aws s3 sync s3://tokium-runbook-state/ ~/.runbook/state/ \
            --exclude "runs/*"

      - run: npx runbook poll datadog --since 6m

      # 終了時: push（成否問わず）
      - name: Push state to S3
        if: always()
        run: |
          aws s3 sync ~/.runbook/state/ s3://tokium-runbook-state/ \
            --exclude "runs/*" --delete
```

### ポイント

- `concurrency.group` でGHA上の並列実行を直列化
- `runs/*` はpullしない（実行履歴はGHA Logsで参照）
- `--delete` で削除も同期（GCを反映するため）
- AWS認証は OIDC（`id-token: write` permission）を推奨

## GC（ガベージコレクション）

起動時 + 1日1回（`runs/<date>/` の日付ベース）に以下を実行：

1. `processed/<source>/events.json` の `ttl_hours` 超過エントリを削除
2. `processed/<source>/events.json` のサイズが `max_size` 超過なら古いものから削除
3. `runs/<date>/` のうち `ttl_hours` 超過のディレクトリを削除

GC失敗もログのみで処理続行。

## サイズ感

- 1イベント `processed` レコード: ~200B
- `max_size: 10000` で約 2MB
- `runs/<date>/` 1日分: ランブック数 × 平均ステップ数 × ~1KB（数百KB〜数MB）

S3同期で問題になる規模ではない。
