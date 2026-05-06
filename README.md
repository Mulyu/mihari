# mihari

> [日本語](./README.ja.md) | **English**

A CLI that runs bash runbooks in response to local log files, cron schedules, or CloudWatch Logs.

> mihari (見張り, "watcher") — a lightweight engine that watches your logs and runs predetermined responses automatically.

## What it does

- Polls log files periodically (tail-equivalent). When a new line matches a regular expression, the runbook fires.
- Time-based scheduling via cron expressions (write HTTP checks as `bash` + `curl`).
- Polls CloudWatch Logs streams (parallel to local file tail; AWS SDK loaded only when used).
- Runbooks are made of `bash` steps.
- File offsets / firing timestamps are persisted under `~/.mihari/state/`.

## Quick start

```bash
npm install
npm run build

# Author a runbook
cat > runbooks/disk-full.yaml <<'YAML'
id: disk-full-cleanup
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
steps:
  - id: cleanup
    bash: /usr/local/bin/cleanup-tmp.sh
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
