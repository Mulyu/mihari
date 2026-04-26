# CLI Reference

mihari の CLI コマンド一覧。

## 共通

```
mihari <command> [options]
```

| グローバルオプション | 内容 |
|------|------|
| `--runbooks-dir <path>` | ランブックディレクトリ（デフォ `./runbooks`） |
| `--state-dir <path>` | stateディレクトリ（デフォ `~/.mihari/state`、`MIHARI_STATE_DIR` で上書き可） |
| `--log-level <level>` | `debug` / `info` / `warn` / `error`（デフォ `info`、`MIHARI_LOG_LEVEL` で上書き可） |

ログは `pino` の構造化JSONで stdout に出力される。

## `mihari daemon`

常駐モード。全ファイルポーラーと cron スケジューラを定期間隔でティックする。

```bash
mihari daemon
mihari daemon --interval 30
```

| オプション | 内容 |
|------|------|
| `--interval <sec>` | ティック間隔（デフォ 10） |

`Ctrl+C` (SIGINT) / SIGTERM で停止フラグを立て、現在のティックの完了を待ってから終了。

## `mihari poll`

すべてのトリガーを1回だけ評価する。cron や single-shot 実行向け。

```bash
mihari poll
mihari poll --dry-run
```

| オプション | 内容 |
|------|------|
| `--dry-run` | 発火対象だけ表示（実行はしない） |

state（ファイルオフセット / cron 最終発火時刻）を起点に判定する。state が無ければ：

- file: ファイル末尾から開始（過去ログを巻き戻さない）
- cron: スロットを発火させず、state だけ初期化

終了コード: 1件でもステップ失敗があれば `1`、それ以外は `0`。

## `mihari run <runbook-id>`

ランブックをトリガー無しで実行する。テスト・手動運用用。`event` は `{type: "manual", timestamp: now}` が渡される。

```bash
mihari run disk-full-cleanup
```

## `mihari list`

ランブック一覧を表示する。各行は `<id> <TAB> <trigger-summary> <TAB> <description>`。

```bash
mihari list
```

トリガーサマリは `file:<path>` または `cron:<schedule>`。

## `mihari validate <path>`

ランブックYAMLの構文・スキーマを検証する。

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/                       # ディレクトリ指定で全件
```

エラーがあれば終了コード 1 で詳細を出力。

## `mihari history [run_id]`

実行履歴を表示する。引数なしで一覧、`run_id` を渡すと詳細（フル JSON）。

```bash
mihari history                              # 直近20件
mihari history --runbook api-health         # ランブックID で絞り込み
mihari history --since 2026-04-25 --limit 5 # 日付以降、最大5件
mihari history --json                       # 一覧を JSON で出力
mihari history run_abc12345                 # 1件の詳細
```

| オプション | 内容 |
|------|------|
| `--runbook <id>` | runbook id で絞り込み |
| `--limit <n>` | 最大表示件数（デフォ 20） |
| `--since <date>` | `YYYY-MM-DD` 以降のみ |
| `--json` | JSON 出力 |

履歴は `~/.mihari/state/runs/<YYYY-MM-DD>/<run_id>.jsonl` から読む。日付ディレクトリ単位の reverse-sort 後、最終的に `started_at` desc で並べる。

## 環境変数

| 変数 | 内容 |
|------|------|
| `MIHARI_STATE_DIR` | state ディレクトリ（`--state-dir` の既定値） |
| `MIHARI_LOG_LEVEL` | ログレベル（`--log-level` の既定値） |

## 終了コード

| Code | 意味 |
|------|------|
| 0 | 成功 |
| 1 | ランブック実行失敗 / バリデーションエラー / ランブック未検出 |
| 2 | オプション不正（`--interval` が非数 など） |
| 130 | SIGINT による中断 |
