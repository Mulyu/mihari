# Permissions

ランブックの権限モデルとデフォルトのツール解放。

## 二段階モデル

```yaml
permissions: read-only       # 自動実行
permissions: write           # 承認必須
```

| permissions | デフォルトの allowed_tools | 自動実行 |
|-------------|---------------------------|---------|
| `read-only` | `Bash(read)`, `Read`, `WebFetch`, MCP read系 | ✅ 自動 |
| `write`     | `Bash(*)`, `Edit`, `Write`, MCP write系 | ❌ 承認必須 |

## read-only

調査・診断系のランブック。Datadogアラートを受けて自動的に走らせる想定。

- 基本的に副作用ゼロ
- Slackへのサマリ投稿（外向き通知）は `mcp__slack__chat_postMessage` を別途許可する
- DBは `SELECT` のみ。`psql` ラッパで `BEGIN; ... ROLLBACK;` を強制してもよい

```yaml
permissions: read-only
steps:
  - id: investigate
    claude:
      allowed_tools:
        - Bash
        - Read
        - mcp__slack__chat_postMessage   # サマリ投稿は許可
```

### Bash whitelist（v2予定）

`read-only` の `Bash` 制限は v1 では信用ベース（プロンプトとallowed_toolsで縛る）。v2でラッパスクリプトを入れて以下のような whitelist を強制する想定：

- `aws ... describe-*` `aws ... list-*` `aws ... get-*`
- `kubectl get` `kubectl describe` `kubectl logs`
- `psql ... -c "SELECT ..."`
- `curl -X GET ...`

書き込み系（`aws ec2 terminate-*` `kubectl delete` `DELETE/UPDATE` SQL等）はマッチさせず拒否。

## write

副作用を伴うランブック。再起動、設定変更、リソース削除など。

- `require_approval: true` を必ず立てる
- `approval` ステップを実行直前に置く
- 承認は Slack リアクションでポーリング（[approval.md](./approval.md)）

```yaml
permissions: write
require_approval: true
steps:
  - id: identify
    claude:
      prompt: 再起動対象のタスクを特定してください
      allowed_tools: ["Bash", "Read"]
    capture: target_tasks

  - id: confirm
    approval:
      channel: "#ops-approvals"
      message: "再起動対象: {{ steps.identify.output }}"
      timeout_sec: 1800

  - id: restart
    claude:
      prompt: "{{ steps.identify.output }} を再起動してください"
      allowed_tools: ["Bash", "mcp__slack__*"]
```

`daemon` モード以外（GHA `poll`）では、`approval` ステップでポーリングが現実的でないため `write` ランブックは原則 `daemon` か `runbook run` で動かす。GHAから動かす場合は `--wait-approval` フラグで時間制限つきポーリング。

## allowed_tools の指定

Claude Agent SDK の慣習に合わせ、以下の形式：

| パターン | 意味 |
|---------|------|
| `Bash` | 全Bashコマンド許可（writeランブックでのみ） |
| `Bash(read)` | 読み取り系コマンドのみ（v2でwhitelist実装） |
| `Read` | ファイル読み取り |
| `Write` | ファイル書き込み |
| `Edit` | ファイル編集 |
| `WebFetch` | URL取得 |
| `mcp__slack__*` | Slack MCPの全ツール |
| `mcp__slack__chat_postMessage` | 個別ツール指定 |

`permissions: read-only` のとき、`allowed_tools` に `Write` `Edit` を書いていてもエンジン側で剥がす（v1では警告ログ、v2ではエラーで停止）。

## 環境変数の権限

Bashステップ・Claudeステップ内で参照可能な環境変数は、起動プロセスの環境をそのまま継承する。

- API key などは `env:` ブロックで明示渡しを推奨
- `read-only` ランブックでは破壊的な権限を持つトークンを渡さない（IAMロールを分ける）
