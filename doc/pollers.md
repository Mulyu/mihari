# Pollers

外部サービスから新規イベントを取得するコンポーネント。

## 共通仕様

- 各Pollerは `~/.runbook/state/pollers/<source>.json` に `last_seen_at` などのカーソルを保存する
- `daemon` モードでは設定済みインターバルでループ、`poll` モードでは1回だけ実行
- 取得したイベントは Matcher に渡し、マッチしたランブックを Executor が実行

各Pollerは以下のインターフェースを実装する：

```ts
interface Poller {
  source: string;                                    // "datadog" | "slack"
  poll(opts: { since: Date; until: Date }): Promise<Event[]>;
}

interface Event {
  source: string;
  id: string;                  // 重複検知に使うユニークID
  timestamp: Date;
  raw: any;                    // 生レスポンス（{{ event.* }} で参照可能）
  // 抽出済みフィールド（matcher用）
  title?: string;
  tags?: string[];
  channel?: string;
  user?: string;
  text?: string;
}
```

## Datadog Poller

### 取得対象

```
GET /api/v1/events?priority=normal&start=<unix>&end=<unix>&tags=...
```

- `alert_type` が `error` / `warning` のものをフィルタ
- レスポンスから `monitor_id`, `title`, `tags`, `alert_transition` を抽出

### マッチングロジック

```ts
function matches(event: DatadogEvent, trigger: DatadogTrigger): boolean {
  if (trigger.source !== 'datadog') return false;
  const m = trigger.match;
  if (m.monitor_tags && !hasAllTags(event.tags, m.monitor_tags)) return false;
  if (m.title_pattern && !new RegExp(m.title_pattern).test(event.title)) return false;
  if (m.alert_type && !m.alert_type.includes(event.alert_type)) return false;
  return true;
}
```

### 必要な環境変数

```
DD_API_KEY=...
DD_APP_KEY=...
DD_SITE=datadoghq.com           # 任意。デフォ datadoghq.com
```

### レート制限

Datadog Events API は 100req/min 程度。`daemon` で60秒間隔なら問題なし。GHA `*/5 * * * *` でも問題なし。

### 既知の制約

- イベントAPIは多少の遅延がある（数十秒〜1分）。`--since` のバッファで吸収する想定
- アラート以外のイベントも含まれるので `alert_type` フィルタが必須

## Slack Poller

### ユースケース

1. **メンション検知**: `@runbook xxx` を検知してランブック起動
2. **bot投稿の二次トリガー**: Datadogが既にSlackに投げている場合に、Slack側でパターン検知してランブック起動

### 取得方法

```
conversations.history?channel=<id>&oldest=<ts>
```

`oldest` に `last_seen_ts` を渡し、新規メッセージのみ走査。

### マッチングロジック

```yaml
trigger:
  source: slack
  match:
    channel: "C01234567"
    user_pattern: "^U.*BOT.*$"           # bot投稿のみ
    text_pattern: "P1 alert"
```

### 必要な環境変数

```
SLACK_BOT_TOKEN=xoxb-...
```

### 必要なBot Scopes

- `channels:history`
- `groups:history`（プライベートチャンネル）
- `chat:write`（承認カード投稿）
- `reactions:read`（承認リアクション読み取り）

### 既知の制約

- `conversations.history` のレート制限は Tier 3（50req/min/workspace）
- 監視対象チャンネルが多い場合は Pollerをチャンネル単位で並列化
- メッセージ編集は検知できない（新規メッセージのみ）

## v2で予定

- **Datadog Eventへの処理済みタグ書き戻し**: 観測性向上、外部から「mihariが処理した」が見えるように
- **Slack新規API（`conversations.history` cursor）対応**
- **PagerDuty Poller**
