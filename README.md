# mihari

> [日本語](./README.ja.md) | **English**

A CLI that runs a Claude agent in response to local log files, cron schedules, CloudWatch Logs, or Datadog Monitors.

> mihari (見張り, "watcher") — a lightweight engine that watches your signals and lets a Claude agent decide what to do.

## What it does

- Polls log files periodically (tail-equivalent). When a new line matches a regular expression, the runbook fires.
- Time-based scheduling via cron expressions (write HTTP checks as `Bash(curl:*)` allowed for the agent).
- Polls CloudWatch Logs streams (parallel to local file tail; AWS SDK loaded only when used).
- Polls Datadog Monitors and fires on state transitions (e.g. `ok -> alert`); Datadog SDK loaded only when used.
- Each runbook runs a **single Claude agent** (Agent SDK loop with file-edit / Bash tools). External SaaS (Datadog / Jira / Slack) are wired in via opt-in `providers:` preambles — auth stays in env vars, never YAML.
- File offsets / firing timestamps are persisted under `~/.mihari/state/`.

## Quick start

```bash
npm install
npm run build

# Author a runbook
cat > runbooks/dd-monitor-jira.yaml <<'YAML'
id: dd-monitor-jira
trigger:
  source: datadog_monitors
  site: datadoghq.com
  monitor_tags: [env:prod]
  transitions: [alert, ok]
  interval_sec: 60
agent:
  prompt: |
    Datadog monitor "{{ event.monitor_name }}" went
    {{ event.from_state }} -> {{ event.to_state }}.
    Investigate and create or close a Jira ticket.
  providers: [datadog, jira]
  allowed_tools:
    - "Bash(curl:*)"
    - "Bash(jq:*)"
YAML

# Resident mode
npx mihari daemon

# One-shot poll (for cron)
npx mihari poll

# Inspect history
npx mihari history
```

## Documentation

| | |
|------------|------|
| [doc/cli.md](./doc/cli.md) | CLI command reference |
| [doc/runbook-spec.md](./doc/runbook-spec.md) | Runbook YAML specification |
| [runbooks/examples/](./runbooks/examples/) | Sample runbooks |

For design philosophy and internal architecture (developer-facing), see [CLAUDE.md](./CLAUDE.md).

## Checks

Repository structure is validated with [monban](https://github.com/Mulyu/monban).

```bash
npx @mulyu/monban all
```
