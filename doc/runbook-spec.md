# Runbook Spec

ランブックは `runbooks/*.yaml`。起動時にディレクトリを再帰せずに（直下のみ）読む。

## スキーマ

```yaml
id: kebab-case-id          # 必須。`[a-z0-9][a-z0-9-]*`
description: ...           # 任意
enabled: true              # 任意。false にすると daemon/poll で発火しない（デフォルト true）
cooldown_sec: 300          # 任意。前回発火から指定秒以内は再発火しない
trigger: ...               # 必須。file または cron
steps: [ ... ]             # 必須。1件以上
```

## トリガー

### `file`

```yaml
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
```

| フィールド | 内容 |
|----------|------|
| `path` | 監視するログファイルの絶対パス |
| `pattern` | 行に対する正規表現 |

複数ランブックが同一行にマッチしたら全て順次実行。初回起動時は state がないため、ファイル末尾から読み始める（過去ログは巻き戻さない）。

### `cron`

```yaml
trigger:
  source: cron
  schedule: "*/5 * * * *"
```

| フィールド | 内容 |
|----------|------|
| `schedule` | 5フィールドの cron 式 |

初回観測では発火せず、次のスロットを待つ。手動テストは `mihari run <id>`。1ティックで複数スロットが過ぎていても発火は1回（catch-up しない）。

## ステップ

### `bash`

```yaml
- id: cleanup
  bash: |
    df -h /var
    /usr/local/bin/cleanup-tmp.sh
  timeout_sec: 60          # デフォ 60
  on_error: stop           # stop | continue（デフォ stop）
  env:
    APP_ENV: prod
  capture: false           # true なら stdout を後続ステップに渡す（デフォ false）
  condition: on_success    # always | on_success | on_failure（デフォなし）
```

| フィールド | 内容 |
|----------|------|
| `bash` | シェルスクリプト本文（複数行可） |
| `timeout_sec` | タイムアウト秒数（超過時 SIGTERM → 1秒後 SIGKILL） |
| `on_error` | `stop`: 失敗で打ち切り / `continue`: 次ステップへ |
| `env` | 追加環境変数 |
| `capture` | `true` で stdout を保存し、後続ステップから `{{ steps.<id>.output }}` で参照可能。失敗ステップの stdout は保存しない |
| `condition` | 実行条件。`on_failure`: 前ステップが1つでも失敗したら実行 / `always`: 常に実行 / `on_success`: 前ステップが全て成功時のみ実行。省略時は `on_error: stop` による打ち切りのみ従う（既存の挙動） |

`condition: on_failure` は `on_error: stop` による打ち切り後でも実行される。失敗通知ステップに使う：

```yaml
steps:
  - id: main
    bash: /usr/local/bin/cleanup.sh
    on_error: stop

  - id: notify
    condition: on_failure
    bash: printf '%s\tfailed\n' "{{ event.timestamp }}" >> /var/log/mihari/alerts.log
    on_error: continue
```

stdout / stderr はログと履歴 JSONL に記録される。

## 変数

`{{ ... }}` でテンプレ展開。実体は環境変数経由で渡されるため、ログ行に注入文字列が混ざっても安全。

| 変数 | `file` | `cron` |
|------|--------|--------|
| `{{ event.line }}` | マッチした行 | 空文字 |
| `{{ event.path }}` | ログファイルパス | 空文字 |
| `{{ event.timestamp }}` | 行を読んだ時刻 (ISO8601) | 発火時刻 (ISO8601) |
| `{{ env.<NAME> }}` | 環境変数 | 環境変数 |
| `{{ steps.<id>.output }}` | `capture: true` の前段ステップの stdout（trailing newline 除去） | 同左 |

`{{ ... }}` は `${VAR}` に展開されるだけなので、空白や改行を含みうる値は **必ずダブルクオートで囲む**：

```yaml
bash: |
  echo "matched: {{ event.line }}"     # 良い
  echo matched: {{ event.line }}       # 危険：IFS で単語分割される
```

## バリデーション

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/                # ディレクトリ指定で全件
```

## サンプル

`runbooks/examples/` 参照：

- `disk-full.yaml` — ディスクフル時の tmp クリーンアップ（file）
- `ssh-failed-login.yaml` — SSH 認証失敗の検知（file）
- `api-health.yaml` — HTTP ヘルスチェック（cron + curl）
- `backup-freshness.yaml` — バックアップ鮮度チェック（cron）
- `k8s-pod-restart-summary.yaml` — Pod restart 数の定期集計（cron + capture）
