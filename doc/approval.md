# Approval Flow

write系ランブックの承認フロー。Webhookを使わずポーリングで倒す。

## 全体の流れ

```
ランブック起動
  ↓
permissions=write 検知
  ↓
Slackで承認カード投稿（Block Kit）
  ↓
スレッドの :white_check_mark: リアクションを N分間ポーリング
  ↓
あれば実行、なければ timeout (ランブック失敗)
```

mihari は Webhookサーバを持たない方針なので、Slack interactive endpoint は使えない。**承認もリアクションポーリング**で実装する。

## YAML定義

```yaml
- id: confirm_restart
  approval:
    channel: "#ops-approvals"
    message: |
      ECSタスクを再起動します。承認してください。
      対象: {{ steps.identify.output }}
    timeout_sec: 1800                 # 30分
    poll_interval_sec: 30             # 30秒間隔でリアクション取得
    require_reactions: ["white_check_mark"]
    require_count: 1                  # 必要リアクション数
    deny_reactions: ["x", "no_entry"] # 付いたら即deny
    approvers: ["U123", "U456"]       # 任意。指定すればこのユーザーのみ有効
  on_error: stop
```

| フィールド | 内容 |
|----------|------|
| `channel` | 投稿先（`#name` または `Cxxxx`） |
| `message` | 承認カード本文。テンプレ展開可 |
| `timeout_sec` | タイムアウト秒数 |
| `poll_interval_sec` | リアクション取得間隔（デフォ 30） |
| `require_reactions` | これらのいずれかが付くと承認 |
| `require_count` | 必要なリアクション数（デフォ 1） |
| `deny_reactions` | これらが付くと即deny |
| `approvers` | 承認可能なSlackユーザーID（任意） |

## 承認カードのフォーマット（Block Kit）

```json
{
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "🚨 Runbook Approval Required" } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "ランブック: `ecs-task-failure-restart`\n対象: ..." } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "承認: :white_check_mark: / 拒否: :x: / Timeout: 30分" }] }
  ]
}
```

## ポーリング実装

```ts
async function waitForApproval(opts: ApprovalOpts): Promise<boolean> {
  const deadline = Date.now() + opts.timeout_sec * 1000;
  const ts = await postApprovalCard(opts);

  while (Date.now() < deadline) {
    const reactions = await slack.reactions.get({ channel: opts.channel, timestamp: ts });

    if (hasDeny(reactions, opts.deny_reactions)) return false;
    if (hasApprove(reactions, opts.require_reactions, opts.require_count, opts.approvers)) return true;

    await sleep(opts.poll_interval_sec * 1000);
  }
  return false; // timeout
}
```

`approvers` が指定されている場合、リアクションをつけたユーザーIDが含まれているかも検証する。

## 実行モード別の挙動

### `daemon` モード

ポーリングは自然に動く。ランブック実行スレッドが `approval` ステップでブロックされる間、他のPollerは別スレッド/別Pollerループで動き続ける。

### `runbook run` モード

CLIプロセスがブロックして待つ。`Ctrl+C` で中断（runbookはfailで終わる）。

### GHA `poll` モード

GHA jobの最大時間（6h）以内なら `--wait-approval` フラグで動かせる。ただし数十分以上ブロックするのはGHA分単価的に微妙なので、**writeランブックはGHAで動かさず `daemon` か手動 `run` 推奨**。

```yaml
- run: npx runbook poll datadog --since 6m --wait-approval
```

## ログと観測性

- 承認カード投稿時 / リアクション検知時 / timeout時に `pino` で構造化ログ
- `runs/<date>/<run_id>.jsonl` に `approval` ステップの結果（approved/denied/timeout、approver_user_id）を残す

## 既知の制約

- Slackの `reactions.get` レート制限は Tier 3（50req/min/workspace）。`poll_interval_sec: 30` で安全
- リアクションの取り消しは検知できない（一度つけば承認扱い）
- 承認カードを編集するとtsが変わる可能性があり、新しいtsを追跡する必要がある（v1では編集しない前提）
