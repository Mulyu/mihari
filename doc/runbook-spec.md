# Runbook Spec

> [日本語](./runbook-spec.ja.md) | **English**

Runbooks live at `runbooks/*.yaml`. On startup the directory is read non-recursively (top level only).

## Schema

```yaml
id: kebab-case-id          # Required. Must match `[a-z0-9][a-z0-9-]*`.
description: ...           # Optional.
enabled: true              # Optional. When false, daemon/poll skips firing (default true).
cooldown_sec: 300          # Optional. Suppress refiring within N seconds of the last fire.
trigger: ...               # Required. file, cron, aws_cloudwatch_logs, or datadog_monitors.
agent: ...                 # Required. Single Claude agent block.
```

A 1.0 runbook has exactly one `agent:`. The `steps:` list from 0.x has been removed; the loader rejects any runbook that still defines it.

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

Authentication is delegated entirely to the AWS SDK default credential chain (env vars / `~/.aws/credentials` / IAM role). mihari exposes no auth fields. The SDK is dynamically imported only when at least one runbook uses this trigger. If two runbooks subscribe to the same `(region, log_group)` they share one poller; the effective `interval_sec` is the minimum of the subscribers.

### `datadog_monitors`

```yaml
trigger:
  source: datadog_monitors
  site: datadoghq.com
  monitor_tags:                # optional, AND filter passed to Datadog SDK monitorTags
    - "env:prod"
  transitions:                 # optional, "to" states to fire on. Default ["alert"]
    - alert
    - warn
  interval_sec: 60
```

Authentication: mihari reads `DD_API_KEY` and `DD_APP_KEY` from the environment and passes them straight to the SDK. If two runbooks subscribe to the same `(site, monitor_tags)` they share one poller; different `transitions` filters across those subscribers are honored independently in the matcher.

## Agent

```yaml
agent:
  prompt: |
    Investigate {{ event.line }} and decide what to do.
  prompt_file: prompts/investigate.md     # mutually exclusive with prompt
  system: You are an on-call agent.       # optional
  system_file: prompts/system.md          # optional, mutually exclusive with system
  model: claude-opus-4-7                  # default claude-opus-4-7

  allowed_tools:                          # required, non-empty
    - Read
    - "Bash(curl:*)"
    - "Bash(jq:*)"
    - "Bash(git status:*)"

  permission_mode: strict                 # strict (default) | bypass
  max_turns: 30                           # default 30
  timeout_sec: 600                        # default 600
  conventions: false                      # default. opt-in for the PR-idempotency preamble
  cwd: /home/user/work                    # absolute path. default: process.cwd()
```

| Field | Purpose |
|----------|------|
| `prompt` / `prompt_file` | Prompt text or file (mutually exclusive; one is required) |
| `system` / `system_file` | System prompt text or file (optional; mutually exclusive) |
| `model` | Model id (default `claude-opus-4-7`) |
| `allowed_tools` | Tool allow-list. Plain names (`Read`, `Edit`, `Write`) and `Bash(<command>:*)` / `Bash(<exact>)` patterns. Anything not listed is denied without prompting. Must be non-empty. |
| `permission_mode` | `strict` (every tool call goes through `canUseTool`) or `bypass` (sets `allowDangerouslySkipPermissions`). |
| `max_turns` | Maximum agentic turns. mihari default `30`. |
| `timeout_sec` | Wall-clock timeout for the whole agent run. mihari default `600`. |
| `cwd` | Absolute path the agent operates in. Defaults to mihari's startup directory. |
| `conventions` | When `true`, mihari prepends an idempotency preamble instructing the agent to use `claude/fix-$MIHARI_IDEMPOTENCY_KEY` as the branch name and to skip when an existing branch / open PR / dirty tree is detected. The preamble references `git status:*`, `git ls-remote:*`, and `gh pr list:*`; allow those in `allowed_tools` if you turn it on. Default `false`. |

The composed system prompt order is `[conventions preamble (if true)] → [user system]`.

## SaaS integration

mihari itself injects no SaaS-specific call patterns. Auth env var names, endpoints, curl examples, and idempotency patterns are the runbook author's responsibility — write them directly in `agent.prompt` or `agent.system`.

See `runbooks/examples/dd-monitor-jira.yaml` for a concrete example. `MIHARI_IDEMPOTENCY_KEY` is always injected into the agent's environment, so the author can use it for duplicate detection (issue search / branch name / message tag, etc.) without any framework support.

## Variables

Templates are expanded with `{{ ... }}` inside `agent.prompt` and `agent.system` (and the corresponding `_file` variants).

| Variable | `file` | `cron` | `aws_cloudwatch_logs` | `datadog_monitors` |
|------|--------|--------|---|---|
| `{{ event.line }}` | The matched line | Empty string | The event message | Empty string |
| `{{ event.path }}` | Path to the log file | Empty string | The log group name | Empty string |
| `{{ event.timestamp }}` | Time the line was read (ISO 8601) | Time of firing | Event timestamp | Time the transition was observed |
| `{{ event.log_stream }}` | Empty string | Empty string | The log stream name | Empty string |
| `{{ event.monitor_id }}` | Empty string | Empty string | Empty string | Datadog monitor id |
| `{{ event.monitor_name }}` | Empty string | Empty string | Empty string | Datadog monitor name |
| `{{ event.from_state }}` | Empty string | Empty string | Empty string | Previous monitor state |
| `{{ event.to_state }}` | Empty string | Empty string | Empty string | Current monitor state |
| `{{ env.<NAME> }}` | `process.env[NAME]` | same | same | same |

Inside the agent's Bash tool, mihari additionally injects:

- `MIHARI_IDEMPOTENCY_KEY` — a 12-char sha1 hex deterministic for the (runbook id, trigger event) pair. Same trigger observed twice → same key. Use it to detect duplicate work in Jira issue searches, branch names, etc.

## Validation

```bash
mihari validate runbooks/dd-monitor-jira.yaml
mihari validate runbooks/                # Pass a directory to validate everything inside
```

## Examples

See `runbooks/examples/`:

- `dd-monitor-jira.yaml` — Datadog monitor transitions → Jira create/close
- `file-slack-alert.yaml` — Application log ERROR → Slack triage
- `cron-health-agent.yaml` — Periodic health check → Slack on failure
- `cw-error-triage.yaml` — CloudWatch Logs ERROR → Slack triage
