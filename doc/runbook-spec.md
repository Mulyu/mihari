# Runbook Specification

ランブックYAMLの仕様。

## ファイル配置

```
runbooks/
├── disk-full.yaml
└── oom.yaml
```

`runbooks/` 配下の `*.yaml` を起動時に全部ロードする。

## 全体構造

```yaml
id: disk-full-cleanup                 # ユニークID（必須、kebab-case推奨）
description: ディスクフル時のtmpクリーンアップ

trigger:                              # 必須
  source: file                        # MVPでは file のみ
  path: /var/log/myapp.log            # 監視対象ファイル
  pattern: "ERROR.*disk full"         # 正規表現。マッチした行で発火

steps:                                # 必須
  - id: cleanup
    bash: /usr/local/bin/cleanup-tmp.sh
```

## トリガー

`source` に `file` または `cron` を指定する。

### `file`

```yaml
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
```

| フィールド | 内容 |
|----------|------|
| `source` | `file` |
| `path` | 監視するログファイルの絶対パス |
| `pattern` | 行に対する正規表現。マッチで発火 |

複数ランブックが同一行にマッチしたら **全て順次実行**（並列ではない、シンプルさ優先）。

### `cron`

```yaml
trigger:
  source: cron
  schedule: "*/5 * * * *"
```

| フィールド | 内容 |
|----------|------|
| `source` | `cron` |
| `schedule` | 5フィールドのcron式（`croner` で解釈） |

時刻ベースの定期実行。HTTP合成監視は `bash` ステップで `curl` を呼ぶことで実現する：

```yaml
id: api-health
trigger:
  source: cron
  schedule: "*/5 * * * *"
steps:
  - id: probe
    bash: |
      curl -fsS --max-time 5 https://api.example.com/health > /tmp/last.json
      grep -q '"status":"ok"' /tmp/last.json
    timeout_sec: 10
```

**起動時挙動**: stateが無いとき（初回観測）は発火せず、次のスロットを待つ。手動テストは `mihari run <id>` を使う。

**重複・取りこぼし**: cron発火中にプロセスが落ちても、再起動後は次のスロットで発火する。1ティックで複数スロットが過ぎていても**発火は1回**（catch-upしない）。

## ステップ

### `bash` ステップ

```yaml
- id: cleanup
  bash: |
    df -h /var
    /usr/local/bin/cleanup-tmp.sh
  timeout_sec: 60                     # デフォ 60
  on_error: stop                      # stop | continue（デフォ stop）
  env:
    APP_ENV: prod
```

| フィールド | 内容 |
|----------|------|
| `bash` | シェルスクリプト本文（複数行可） |
| `timeout_sec` | タイムアウト秒数 |
| `on_error` | 失敗時の挙動（`stop` でランブック停止、`continue` で次へ） |
| `env` | 環境変数追加 |

stdoutとstderrはmihariのログに記録される。

## 変数

トリガーから変数を渡せる：

| 変数 | `file` | `cron` |
|------|--------|--------|
| `{{ event.line }}` | マッチした行の全文 | 空文字 |
| `{{ event.path }}` | ログファイルのパス | 空文字 |
| `{{ event.timestamp }}` | mihariが行を読んだ時刻 | 発火時刻 |
| `{{ env.<NAME> }}` | 環境変数 | 環境変数 |

時刻は ISO8601。`{{ event.* }}` はシェル展開時に**環境変数経由**で渡されるため、ログ行に注入文字列が混ざっても安全。

例：

```yaml
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
steps:
  - id: log_event
    bash: |
      echo "matched: {{ event.line }}" >> /var/log/mihari-actions.log
```

## バリデーション

```bash
mihari validate runbooks/disk-full.yaml
```

CIで全ランブックを検証することを推奨。

## 完全なサンプル

```yaml
id: disk-full-cleanup
description: ディスクフル時のtmpクリーンアップ

trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"

steps:
  - id: snapshot_disk
    bash: df -h > /tmp/mihari-disk-$(date +%s).txt
    timeout_sec: 10

  - id: cleanup
    bash: /usr/local/bin/cleanup-tmp.sh
    timeout_sec: 120
    on_error: stop
```
