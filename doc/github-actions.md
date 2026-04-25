# GitHub Actions Operations

GHAでmihariをcron実行するための設定。

## 全体方針

- `runbook poll <source> --since 6m` を `*/5 * * * *` で起動
- stateは S3 にpull/pushして永続化
- `concurrency.group` で同時実行を直列化
- AWS認証は OIDC（永続クレデンシャル不要）

## Workflow YAML

```yaml
# .github/workflows/runbook-poll.yaml
name: Runbook Poll
on:
  schedule:
    - cron: '*/5 * * * *'   # 5分ごと
  workflow_dispatch:

jobs:
  poll-datadog:
    runs-on: ubuntu-latest
    permissions:
      id-token: write       # AWS OIDC
      contents: read
    concurrency:
      group: runbook-poll-datadog
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-northeast-1

      - name: Pull state from S3
        run: |
          mkdir -p ~/.runbook/state
          aws s3 sync s3://tokium-runbook-state/ ~/.runbook/state/ \
            --exclude "runs/*" || true

      - run: npx runbook poll datadog --since 6m
        env:
          DD_API_KEY: ${{ secrets.DD_API_KEY }}
          DD_APP_KEY: ${{ secrets.DD_APP_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

      - name: Push state to S3
        if: always()
        run: |
          aws s3 sync ~/.runbook/state/ s3://tokium-runbook-state/ \
            --exclude "runs/*" --delete
```

## 設計上のポイント

### `--since 6m` のバッファ

- cron間隔は 5分
- ジッタ・遅延を考慮して `--since 6m` で **1分のオーバーラップ**を取る
- 重複は state（処理済みID）と冪等性で吸収

### `concurrency.group` で直列化

```yaml
concurrency:
  group: runbook-poll-datadog
  cancel-in-progress: false
```

- cron + workflow_dispatch の重なりを防ぐ
- `cancel-in-progress: false` で**前のjobの完了を待つ**（途中で殺さない）
- これにより state の lost update を防ぐ

### S3 sync 戦略

```bash
# pull: runs/* は除外（実行履歴は引きずらない）
aws s3 sync s3://tokium-runbook-state/ ~/.runbook/state/ --exclude "runs/*"

# push: runs/* は除外、削除も同期
aws s3 sync ~/.runbook/state/ s3://tokium-runbook-state/ --exclude "runs/*" --delete
```

- `--exclude "runs/*"` で実行履歴をS3に上げない（GHA Logsで参照）
- `--delete` でローカルから消えたファイルをS3からも消す（GCを反映）

### `if: always()` で必ずpush

state破損や `markProcessed` 漏れを防ぐため、ランブック実行が失敗しても push は走らせる。

## S3バケット準備

```bash
aws s3 mb s3://tokium-runbook-state --region ap-northeast-1

# バージョニング有効化（state破損時の復旧用）
aws s3api put-bucket-versioning \
  --bucket tokium-runbook-state \
  --versioning-configuration Status=Enabled

# ライフサイクル: 古いバージョンを30日で削除
aws s3api put-bucket-lifecycle-configuration \
  --bucket tokium-runbook-state \
  --lifecycle-configuration file://lifecycle.json
```

## OIDC IAM Role 設定

GHAから assume させるロールを作成。trust policy 例：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:ref:refs/heads/main"
      }
    }
  }]
}
```

ロールにアタッチする最小ポリシー：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::tokium-runbook-state",
      "arn:aws:s3:::tokium-runbook-state/*"
    ]
  }]
}
```

ランブック内で AWS リソースを操作する場合、その操作分の権限もロールに追加するか、ランブック側で `assume-role` する設計を選ぶ。

## Secrets 一覧

リポジトリ Secrets に登録：

| Secret | 用途 |
|--------|------|
| `AWS_ROLE_ARN` | OIDC assume先 |
| `DD_API_KEY` | Datadog Poller |
| `DD_APP_KEY` | Datadog Poller |
| `ANTHROPIC_API_KEY` | Claude Agent SDK |
| `SLACK_BOT_TOKEN` | Slack Poller / 承認 |

## 監視

GHA workflow失敗時のSlack通知を設定推奨：

```yaml
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      { "text": "Runbook poll failed: ${{ github.run_id }}" }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

mihari自体の死活監視は GHA Run の成否で見る。

## 既知の制約・注意

- GHA cronは公式に**遅延がある**（数分〜十数分）。クリティカルなアラートには `daemon` モードを併用する
- GHAのfree minuteを食う（5分間隔 × ~30秒/run = 月に数百分）。プライベートリポでは課金が必要
- write系ランブックはGHAで動かさない（[approval.md](./approval.md) 参照）
