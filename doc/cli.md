# CLI Reference

> [日本語](./cli.ja.md) | **English**

## Common

```
mihari <command> [options]
```

| Global option | Purpose |
|------|------|
| `--runbooks-dir <path>` | Runbook directory (default `./runbooks`) |
| `--state-dir <path>` | State directory (default `~/.mihari/state`) |
| `--log-level <level>` | `debug` / `info` / `warn` / `error` (default `info`) |

Logs are emitted as pino's structured JSON on stdout.

| Environment variable | Role |
|----------|------|
| `MIHARI_STATE_DIR` | Default for `--state-dir` |
| `MIHARI_LOG_LEVEL` | Default for `--log-level` |

## `mihari daemon`

Resident mode. Ticks file pollers, the cron scheduler, and CloudWatch Logs pollers at a fixed interval.

```bash
mihari daemon --interval 30
```

| Option | Purpose |
|------|------|
| `--interval <sec>` | Tick interval (default 10) |

`Ctrl+C` (SIGINT) / SIGTERM waits for the in-flight tick to finish before exiting.

## `mihari poll`

Evaluates every trigger once. Exit code is `1` if at least one runbook failed.

```bash
mihari poll
mihari poll --dry-run
```

| Option | Purpose |
|------|------|
| `--dry-run` | Print only the triggers that would fire (no execution) |

## `mihari run <runbook-id>`

Runs a runbook without a trigger. `event` is `{type: "manual", timestamp: now}`.

```bash
mihari run disk-full-cleanup
```

## `mihari list`

Lists runbooks. Each row is `<id>\t<trigger>\t<description>`.

```bash
mihari list
```

The trigger column is rendered as `file:<path>`, `cron:<schedule>`, or `aws_cloudwatch_logs:<region>|<log_group>`.

## `mihari status`

Lists each runbook's last-run timestamp, outcome, and next scheduled firing.

```bash
mihari status
```

Sample output (tab-separated):

```
disk-full-cleanup   file:/var/log/myapp.log                        2026-04-29T02:11Z   ok    -
api-health          cron:*/5 * * * *                               2026-04-29T03:05Z   FAIL  2026-04-29T03:10Z
backup-freshness    cron:0 9 * * *                                 2026-04-28T09:00Z   ok    2026-04-29T09:00Z
lambda-error-alert  aws_cloudwatch_logs:us-east-1|/aws/lambda/fn   2026-04-29T03:00Z   ok    -
```

Runbooks with `enabled: false` are prefixed with `[disabled]`. The `NEXT` column is always `-` for `file` and `aws_cloudwatch_logs` triggers.

## `mihari validate <path>`

Validates the syntax and schema of runbook YAML. Exits with code 1 on error.

```bash
mihari validate runbooks/disk-full.yaml
mihari validate runbooks/
```

## `mihari history [run_id]`

Shows execution history. Without arguments, lists recent runs; with a `run_id`, prints details as JSON.

```bash
mihari history                              # 20 most recent
mihari history --runbook api-health
mihari history --since 2026-04-25 --limit 5
mihari history --json
mihari history run_abc12345                 # detail of a single run
```

| Option | Purpose |
|------|------|
| `--runbook <id>` | Filter by runbook id |
| `--limit <n>` | Maximum entries (default 20) |
| `--since <date>` | Only entries on or after `YYYY-MM-DD` |
| `--json` | Emit JSON |

## Exit codes

| Code | Meaning |
|------|------|
| 0 | Success |
| 1 | Runbook failure / validation error / not found |
| 2 | Invalid option |
| 130 | Interrupted by SIGINT |
