# Runbook Spec

> [日本語](./runbook-spec.ja.md) | **English**

Runbooks live at `runbooks/*.yaml`. On startup the directory is read non-recursively (top level only).

## Schema

```yaml
id: kebab-case-id          # Required. Must match `[a-z0-9][a-z0-9-]*`.
description: ...           # Optional.
enabled: true              # Optional. When false, daemon/poll skips firing (default true).
cooldown_sec: 300          # Optional. Suppress refiring within N seconds of the last fire.
trigger: ...               # Required. file, cron, or aws_cloudwatch_logs.
steps: [ ... ]             # Required. At least one entry.
```

## Triggers

### `file`

```yaml
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
```

| Field | Purpose |
|----------|------|
| `path` | Absolute path of the log file to watch |
| `pattern` | Regular expression matched against each line |

If multiple runbooks match the same line, they all run sequentially. On first startup there is no state, so reading begins at the file's end (no rewind into historical lines).

### `cron`

```yaml
trigger:
  source: cron
  schedule: "*/5 * * * *"
```

| Field | Purpose |
|----------|------|
| `schedule` | A 5-field cron expression |

On first observation the trigger does not fire; it waits for the next slot. Manual testing: `mihari run <id>`. If multiple slots pass between ticks, only one fire is emitted (no catch-up).

### `aws_cloudwatch_logs`

```yaml
trigger:
  source: aws_cloudwatch_logs
  region: us-east-1
  log_group: /aws/lambda/myfunc
  pattern: "ERROR"             # optional regex on the message body
  interval_sec: 60
```

| Field | Purpose |
|----------|------|
| `region` | AWS region. Required for unambiguous SDK config and state-key uniqueness |
| `log_group` | CloudWatch Logs log group name |
| `pattern` | Optional regex applied client-side to each event's message. Omit to match every event |
| `interval_sec` | Polling interval in seconds. Required (AWS API calls cost money — make this explicit) |

Semantics mirror the `file` trigger: each matched event fires the runbook once, and on first observation no historical events are pulled (cursor seeds at "now").

State (cursor) lives at `~/.mihari/state/aws-cloudwatch-logs/<sha1(region|log_group)>.json`. Cursor write failure is fail-open (warn log, processing continues).

Authentication is delegated entirely to the AWS SDK default credential chain (env vars / `~/.aws/credentials` / IAM role). mihari exposes no auth fields. The SDK is dynamically imported only when at least one runbook uses this trigger.

If two runbooks subscribe to the same `(region, log_group)` they share one poller; the effective `interval_sec` is the minimum of the subscribers.

## Steps

### `bash`

```yaml
- id: cleanup
  bash: |
    df -h /var
    /usr/local/bin/cleanup-tmp.sh
  timeout_sec: 60          # default 60
  on_error: stop           # stop | continue (default stop)
  env:
    APP_ENV: prod
  capture: false           # true streams stdout to later steps (default false)
  condition: on_success    # always | on_success | on_failure (no default)
```

| Field | Purpose |
|----------|------|
| `bash` | Shell script body (multi-line supported) |
| `timeout_sec` | Timeout in seconds (SIGTERM on overrun, then SIGKILL 1 second later) |
| `on_error` | `stop`: abort the runbook on failure / `continue`: proceed to the next step |
| `env` | Additional environment variables |
| `capture` | When `true`, stdout is stored and is available to later steps as `{{ steps.<id>.output }}`. stdout from a failed step is not stored. |
| `condition` | Execution condition. `on_failure`: run when any prior step failed / `always`: always run / `on_success`: run only when all prior steps succeeded. When omitted, only the `on_error: stop` abort rule applies (previous behaviour). |

`condition: on_failure` runs even after an `on_error: stop` abort. Useful for failure-notification steps:

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

stdout / stderr are recorded in the logs and the history JSONL.

## Variables

Templates are expanded with `{{ ... }}`. Values are passed in as environment variables, so injection text mixed into log lines is safe.

| Variable | `file` | `cron` | `aws_cloudwatch_logs` |
|------|--------|--------|---|
| `{{ event.line }}` | The matched line | Empty string | The event message |
| `{{ event.path }}` | Path to the log file | Empty string | The log group name |
| `{{ event.timestamp }}` | Time the line was read (ISO 8601) | Time of firing (ISO 8601) | Event timestamp (ISO 8601) |
| `{{ event.log_stream }}` | Empty string | Empty string | The log stream name |
| `{{ env.<NAME> }}` | Environment variable | Environment variable | Environment variable |
| `{{ steps.<id>.output }}` | stdout of an earlier step with `capture: true` (trailing newline stripped) | same | same |

`{{ ... }}` simply expands to `${VAR}`, so values that may contain spaces or newlines **must be double-quoted**:

```yaml
bash: |
  echo "matched: {{ event.line }}"     # Good
  echo matched: {{ event.line }}       # Dangerous: IFS word-splits the value
```

`bash` steps additionally receive these env vars (no `{{ ... }}` form):

| Env var | Meaning |
|---|---|
| `MIHARI_EVENT_LINE` / `MIHARI_EVENT_PATH` / `MIHARI_EVENT_TIMESTAMP` / `MIHARI_EVENT_LOG_STREAM` | Same as the `event.*` template variables |
| `MIHARI_STEP_<ID>` | stdout of an earlier `capture: true` step (id uppercased, `-` → `_`) |
| `MIHARI_IDEMPOTENCY_KEY` | 12-char sha1 hex deterministic for the (runbook id, trigger event) pair. See `claude_agent` for how it is used by the built-in idempotency conventions. |

### `claude`

```yaml
- id: analyze-error
  claude:
    prompt: |
      Error: {{ event.line }}
      Context: {{ steps.get-context.output }}
    prompt_file: prompts/analyze.md    # mutually exclusive with prompt (path relative to runbook YAML)
    system: You are a DevOps expert.   # optional
    system_file: prompts/system.md     # mutually exclusive with system (optional)
    model: claude-opus-4-7             # default claude-opus-4-7
    max_tokens: 1024                   # default 1024
  timeout_sec: 60
  on_error: stop
  capture: true
  condition: on_failure
```

| Field | Purpose |
|----------|------|
| `claude.prompt` | Prompt text (`prompt_file` is mutually exclusive; one is required) |
| `claude.prompt_file` | Path to a prompt file (relative to the runbook YAML directory; read at startup) |
| `claude.system` | System prompt (optional; mutually exclusive with `system_file`) |
| `claude.system_file` | Path to a system-prompt file (optional; mutually exclusive with `system`) |
| `claude.model` | Model to use (default `claude-opus-4-7`) |
| `claude.max_tokens` | Maximum output tokens (default 1024). Single-shot mode only; ignored when `agent: true`. |
| `timeout_sec` | Timeout in seconds (default 60) |
| `on_error` | `stop` / `continue` (default `stop`) |
| `capture` | When `true`, the API response is available to later steps as `{{ steps.<id>.output }}` |
| `condition` | `always` / `on_success` / `on_failure` (same as bash steps) |

Template variables (`{{ event.line }}` etc.) are expanded via direct string substitution at runtime. `ANTHROPIC_API_KEY` must be set in the environment. A `stop_reason: max_tokens` response is treated as a step failure.

### `claude_agent`

A separate step type that runs the Claude Agent SDK with file edit tools (`Read`, `Edit`, `Write`) and `Bash`. Use this for code changes, commits, and PR creation. The captured output is the agent's final assistant message. Single-shot prompting belongs in `claude:`; this step is for runs with side effects.

```yaml
- id: fix-and-pr
  claude_agent:
    prompt: |
      An error occurred: {{ event.line }}
      Investigate, fix it on a new branch, push, and open a PR.
    system: You are working on the repository at the given cwd.   # optional
    model: claude-opus-4-7                                          # default
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
    permission_mode: strict       # strict (default) | bypass
    max_turns: 30
    cwd: /home/user/myrepo
  timeout_sec: 600
  on_error: stop
  capture: true
```

| Field | Purpose |
|----------|------|
| `claude_agent.prompt` / `prompt_file` | Prompt text or file (mutually exclusive; one is required) |
| `claude_agent.system` / `system_file` | System prompt text or file (optional; mutually exclusive) |
| `claude_agent.model` | Model to use (default `claude-opus-4-7`) |
| `claude_agent.allowed_tools` | **Required.** Tool allow-list. Plain names (`Read`, `Edit`, `Write`) and `Bash(<command>:*)` / `Bash(<exact>)` patterns. Anything not listed is denied without prompting. Must be non-empty. |
| `claude_agent.permission_mode` | `strict` (default; every tool call goes through `canUseTool` and is denied unless it matches `allowed_tools`) or `bypass` (every tool runs; sets `allowDangerouslySkipPermissions`) |
| `claude_agent.max_turns` | Maximum agentic turns before the SDK stops (no default — SDK default applies) |
| `claude_agent.cwd` | Absolute path the agent operates in. Defaults to the directory mihari was started in. |
| `claude_agent.conventions` | When `true`, mihari prepends an idempotency preamble to the system prompt instructing the agent to use `claude/fix-$MIHARI_IDEMPOTENCY_KEY` as the branch name and to skip when an existing branch / open PR / dirty tree is detected. **Default `false`** — opt in explicitly when the runbook opens PRs and is willing to grant the necessary tools (see below). |

#### Built-in idempotency conventions

`MIHARI_IDEMPOTENCY_KEY` — a 12-character sha1 hex computed deterministically from the runbook id and the trigger event (file path + line, cron slot, or manual timestamp) — is **always** exported as an env var to both bash steps and to the agent's Bash tool. The same trigger observed twice produces the same key.

Setting `conventions: true` additionally appends a fixed **operations preamble** ahead of the user-supplied `system` prompt. The preamble instructs the agent that, *if* its task involves opening a PR in a git repo, it must (a) abort on dirty tree, (b) skip when a branch named `claude/fix-$MIHARI_IDEMPOTENCY_KEY` already exists, (c) skip when an open PR mentions the key in its title, and (d) otherwise create the branch and PR using that exact name. For non-PR tasks (write a status file, run a migration, etc.) the agent is told to ignore the preamble.

The preamble references `git status:*`, `git ls-remote:*`, and `gh pr list:*`. If you turn it on, your `allowed_tools` must grant those patterns or `canUseTool` will deny the mandated checks. The default is `false` precisely because the preamble would otherwise demand tools the runbook may not have allowlisted.

Stage control is purely a function of `allowed_tools`:

| Range | Add to `allowed_tools` |
|---|---|
| Edit-only | `Read` `Edit` `Write` |
| + local commit | + `Bash(git status)` `Bash(git diff:*)` `Bash(git switch:*)` `Bash(git add:*)` `Bash(git commit:*)` |
| + push | + `Bash(git push:*)` |
| + PR | + `Bash(gh pr create:*)` |

## Validation

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/                # Pass a directory to validate everything inside
```

## Examples

See `runbooks/examples/`:

- `disk-full.yaml` — Cleans up tmp on disk-full alerts (file)
- `ssh-failed-login.yaml` — Detects SSH authentication failures (file)
- `api-health.yaml` — HTTP health check (cron + curl)
- `backup-freshness.yaml` — Backup-freshness check (cron)
- `k8s-pod-restart-summary.yaml` — Periodic Pod-restart aggregation (cron + capture)
- `error-analysis.yaml` — Analyzes error logs with Claude and suggests remediation (file + claude step)
- `error-fix-pr.yaml` — Lets Claude fix the bug, push a branch, and open a PR (file + claude agent step)
- `aws-cloudwatch-logs-error-alert.yaml` — Alerts on CloudWatch Logs ERROR events (aws_cloudwatch_logs)
