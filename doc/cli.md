# CLI Reference

mihari の CLI コマンド一覧。

## 共通

```
mihari <command> [options]
```

| グローバルオプション | 内容 |
|------|------|
| `--config <path>` | 設定ファイルパス（デフォ `~/.mihari/config.yaml`） |
| `--state-dir <path>` | stateディレクトリ（デフォ `~/.mihari/state`） |
| `--runbooks-dir <path>` | ランブックディレクトリ（デフォ `./runbooks`） |
| `--log-level <level>` | `debug` / `info` / `warn` / `error`（デフォ `info`） |

## `mihari daemon`

常駐モード。設定済みの全ログファイルを定期間隔でポーリングする。

```bash
mihari daemon
```

| オプション | 内容 |
|------|------|
| `--interval <sec>` | ポーリング間隔（デフォ 10） |

`Ctrl+C` (SIGINT) で graceful shutdown。実行中のランブックは完走を待つ。

## `mihari poll`

設定済みの全ログファイルを1回だけポーリングする。cron向け。

```bash
mihari poll
```

| オプション | 内容 |
|------|------|
| `--dry-run` | マッチング結果を表示するだけで実行しない |

state（ファイルオフセット）を起点に新規行を読む。stateが無ければ「ファイル末尾」からスタート（過去ログを巻き戻して実行しない）。

## `mihari run <runbook-id>`

ランブックをトリガーなしで直接実行する。テスト・手動運用用。

```bash
mihari run disk-full-cleanup
```

| オプション | 内容 |
|------|------|
| `--input <key=value>` | 変数を渡す（複数可） |

## `mihari list`

ランブック一覧を表示する。

```bash
mihari list
```

## `mihari validate <path>`

ランブックYAMLの構文・スキーマを検証する。

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/                       # ディレクトリ指定で全件
```

エラーがあれば終了コード 1 で詳細を出力。

## 終了コード

| Code | 意味 |
|------|------|
| 0 | 成功 |
| 1 | ランブック実行失敗 / バリデーションエラー |
| 2 | 設定エラー |
| 130 | SIGINT による中断 |
