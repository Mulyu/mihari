# Runbook Spec

> [日本語](./runbook-spec.ja.md) | **English**

Runbooks live at `runbooks/*.yaml`. On startup the directory is read non-recursively (top level only).

## Schema

```yaml
id: kebab-case-id          # Required. Must match `[a-z0-9][a-z0-9-]*`.
description: ...           # Optional.
enabled: true              # Optional. When false, daemon/poll skips firing (default true).
cooldown_sec: 300          # Optional. Suppress refiring within N seconds of the last fire.
trigger: ...               # Required. file or cron.
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

| Variable | `file` | `cron` |
|------|--------|--------|
| `{{ event.line }}` | The matched line | Empty string |
| `{{ event.path }}` | Path to the log file | Empty string |
| `{{ event.timestamp }}` | Time the line was read (ISO 8601) | Time of firing (ISO 8601) |
| `{{ env.<NAME> }}` | Environment variable | Environment variable |
| `{{ steps.<id>.output }}` | stdout of an earlier step with `capture: true` (trailing newline stripped) | same |

`{{ ... }}` simply expands to `${VAR}`, so values that may contain spaces or newlines **must be double-quoted**:

```yaml
bash: |
  echo "matched: {{ event.line }}"     # Good
  echo matched: {{ event.line }}       # Dangerous: IFS word-splits the value
```

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

#### Agent mode

Setting `claude.agent: true` switches the step to the Claude Agent SDK, giving the model file edit tools (`Read`, `Edit`, `Write`) and `Bash`. Use this for code changes, commits, and PR creation. The captured output is the agent's final assistant message.

```yaml
- id: fix-and-pr
  claude:
    prompt: |
      An error occurred: {{ event.line }}
      Investigate, fix it on a new branch, push, and open a PR.
    agent: true
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
    permission_mode: accept-edits
    max_turns: 30
    cwd: /home/user/myrepo
  timeout_sec: 600
```

| Field | Purpose |
|----------|------|
| `claude.agent` | `true` enables agent mode (default `false`) |
| `claude.allowed_tools` | Tool allow-list. Plain names (`Read`, `Edit`, `Write`) and `Bash(<command>:*)` / `Bash(<exact>)` patterns. Anything not listed is denied without prompting. |
| `claude.permission_mode` | `accept-edits` (default; only `allowed_tools` entries run) or `bypass` (every tool runs; sets `allowDangerouslySkipPermissions`) |
| `claude.max_turns` | Maximum agentic turns before the SDK stops (no default — SDK default applies) |
| `claude.cwd` | Absolute path the agent operates in. Defaults to the directory mihari was started in. |

Stage control is purely a function of `allowed_tools`:

| Range | Add to `allowed_tools` |
|---|---|
| Edit-only | `Read` `Edit` `Write` |
| + local commit | + `Bash(git status)` `Bash(git diff:*)` `Bash(git switch:*)` `Bash(git add:*)` `Bash(git commit:*)` |
| + push | + `Bash(git push:*)` |
| + PR | + `Bash(gh pr create:*)` |

`agent`-only fields (`allowed_tools`, `permission_mode`, `max_turns`, `cwd`) are rejected when `agent` is unset/false.

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
