# ランブック仕様

> **日本語** | [English](./runbook-spec.md)

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

### `claude`

```yaml
- id: analyze-error
  claude:
    prompt: |
      Error: {{ event.line }}
    system: You are a DevOps expert.   # optional
    model: claude-opus-4-7             # デフォ claude-opus-4-7
    max_tokens: 1024                   # デフォ 1024。agent: true の場合は無視
  timeout_sec: 60
  on_error: stop
  capture: true
```

| フィールド | 内容 |
|----------|------|
| `claude.prompt` / `prompt_file` | プロンプト本文 / ファイル（相対パス、起動時読み込み）。どちらか必須 |
| `claude.system` / `system_file` | システムプロンプト本文 / ファイル（任意） |
| `claude.model` | モデル名（デフォ `claude-opus-4-7`） |
| `claude.max_tokens` | 出力トークン上限（単発モードのみ） |

`ANTHROPIC_API_KEY` を環境変数で設定。`stop_reason: max_tokens` は失敗扱い。

### `claude_agent`

Claude Agent SDK でエージェントループを回す独立ステップ種別。`Read` / `Edit` / `Write` / `Bash` などが使え、コード変更・コミット・PR 作成のような副作用を伴う処理に使う。capture される値は最終アシスタントメッセージ。副作用なしの単発質問は `claude:` を使うこと。

```yaml
- id: fix-and-pr
  claude_agent:
    prompt: |
      An error occurred: {{ event.line }}
      Investigate, fix it on a new branch, push, and open a PR.
    system: You are working on the repository at the given cwd.   # optional
    model: claude-opus-4-7                                          # デフォ
    allowed_tools:
      - Read
      - Edit
      - Write
      - "Bash(git status)"
      - "Bash(git diff:*)"
      - "Bash(git switch:*)"
      - "Bash(git add:*)"
      - "Bash(git commit:*)"
      - "Bash(git push:*)"
      - "Bash(gh pr create:*)"
    permission_mode: strict       # strict（デフォ） | bypass
    max_turns: 30
    cwd: /home/user/myrepo
  timeout_sec: 600
  on_error: stop
  capture: true
```

| フィールド | 内容 |
|---|---|
| `claude_agent.prompt` / `prompt_file` | プロンプト本文 / ファイル（相対パス、起動時読み込み）。どちらか必須 |
| `claude_agent.system` / `system_file` | システムプロンプト本文 / ファイル（任意） |
| `claude_agent.model` | モデル名（デフォ `claude-opus-4-7`） |
| `claude_agent.allowed_tools` | **必須**。ツール許可リスト。素のツール名（`Read` 等）と `Bash(<command>:*)` / `Bash(<exact>)` パターン。リスト外は prompt なしで deny。空配列は不可 |
| `claude_agent.permission_mode` | `strict`（デフォ。全 tool 呼び出しを `canUseTool` で判定し、`allowed_tools` に無いものは deny） / `bypass`（全ツール許可。`allowDangerouslySkipPermissions` を立てる） |
| `claude_agent.max_turns` | エージェント最大ターン数（デフォなし＝SDK のデフォルト） |
| `claude_agent.cwd` | エージェントの作業ディレクトリ（絶対パス）。省略時は mihari の起動ディレクトリ |
| `claude_agent.conventions` | `true` のとき、`claude/fix-$MIHARI_IDEMPOTENCY_KEY` を branch 名に使い、既存 branch / open PR / dirty tree を検知した場合はスキップする運用規約を system prompt に自動 append する。**デフォルトは `false`** — PR を開くタスクで、かつ後述の必要ツールを `allowed_tools` で許可している runbook が明示的に opt-in する形 |

#### 組み込み idempotency 規約

`MIHARI_IDEMPOTENCY_KEY` は **常に** export される。runbook id とトリガーイベント（file の場合はパス + 行、cron の場合は発火スロット、manual の場合は timestamp）から決定的に sha1 で計算した 12 文字 hex。同じトリガーが再観測されたら同じ値になる。`bash` ステップの env としても、`claude_agent` の Bash ツールにも自動的に渡す。

`conventions: true` のときは **運用規約の preamble** を利用者の `system` プロンプトの**前に**固定パラグラフとして挟む。「PR を開く類のタスクなら `git status` が dirty なら中止 / `claude/fix-$MIHARI_IDEMPOTENCY_KEY` の branch がリモートにあれば中止 / そのキーがタイトルに含まれる open PR があれば中止 / すべて通ったら同名 branch を作って PR タイトルにキーを含める」と指示する。PR を開かないタスク（ファイル出力やマイグレーション等）は preamble を無視するよう書いてある。

preamble は `git status:*` / `git ls-remote:*` / `gh pr list:*` を agent に要求する。`true` にする場合は `allowed_tools` でこれらを許可しないと `canUseTool` に弾かれる。デフォルトを `false` にしているのは、必要ツールを許可していない runbook で preamble が一律に要求を追加すると壊れるため。

段階制御は `allowed_tools` の中身だけで決まる：

| 範囲 | 追加するエントリ |
|---|---|
| 編集のみ | `Read` `Edit` `Write` |
| + ローカルコミット | + `Bash(git status)` `Bash(git diff:*)` `Bash(git switch:*)` `Bash(git add:*)` `Bash(git commit:*)` |
| + push | + `Bash(git push:*)` |
| + PR | + `Bash(gh pr create:*)` |

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

`bash` ステップには下記の env も渡される（`{{ ... }}` は使わない）:

| Env | 内容 |
|---|---|
| `MIHARI_EVENT_LINE` / `MIHARI_EVENT_PATH` / `MIHARI_EVENT_TIMESTAMP` | `event.*` テンプレと同じ値 |
| `MIHARI_STEP_<ID>` | `capture: true` の前段ステップの stdout（id を大文字化、`-` は `_` に） |
| `MIHARI_IDEMPOTENCY_KEY` | (runbook id, トリガーイベント) ペアに対して決定的な 12 文字 sha1 hex。`claude_agent` の組み込み規約も同じ値を使う |

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
- `error-fix-pr.yaml` — Claude にバグ修正・push・PR 作成までやらせる（file + claude agent ステップ）
