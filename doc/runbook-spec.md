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

### `aws_cloudwatch_alarms`

```yaml
trigger:
  source: aws_cloudwatch_alarms
  region: us-east-1
  alarm_names:                 # optional. Omit to subscribe to every alarm in the region.
    - prod-checkout-5xx
  transitions:                 # optional. "to" states to fire on. Default ["ALARM"]
    - ALARM
    - OK
  interval_sec: 60
```

| Field | Purpose |
|---|---|
| `region` | AWS region |
| `alarm_names` | List of alarm names to subscribe to (omit = every alarm in the region) |
| `transitions` | "To" states that fire the runbook. One of `OK` / `ALARM` / `INSUFFICIENT_DATA` (CloudWatch literals, kept as-is) |
| `interval_sec` | Polling interval in seconds |

Authentication uses the AWS SDK default credential chain (same as `aws_cloudwatch_logs`). The SDK is dynamically imported only when this trigger is present. If multiple runbooks subscribe to the same `(region, alarm_names)` they share one poller and each runbook's `transitions` filter is applied independently in the matcher. Both MetricAlarm and CompositeAlarm are subscribed.

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

### `datadog_logs`

```yaml
trigger:
  source: datadog_logs
  site: datadoghq.com
  query: "service:checkout status:error"   # Datadog Logs Search query string
  interval_sec: 60
```

| Field | Purpose |
|---|---|
| `site` | Datadog site |
| `query` | Datadog Logs Search query string |
| `interval_sec` | Polling interval in seconds |

Authentication uses the same `DD_API_KEY` / `DD_APP_KEY` env vars as `datadog_monitors`. The SDK is dynamically imported only when this trigger is present (it shares the `@datadog/datadog-api-client` package). Multiple runbooks subscribing to the same `(site, query)` share one poller.

The cursor is timestamp-based, with event ids at the boundary kept for dedup (same shape as `aws_cloudwatch_logs`). If a tick cannot drain all results, the rest carries to the next tick.

### `jira_search`

```yaml
trigger:
  source: jira_search
  base: https://example.atlassian.net      # Jira base URL (trailing slashes are stripped)
  jql: project = OPS AND status = Open     # must NOT include ORDER BY
  interval_sec: 120
```

| Field | Purpose |
|---|---|
| `base` | Jira base URL (`http://` or `https://`) |
| `jql` | Search filter. Do not include `ORDER BY` (the poller orders by `updated ASC`) |
| `interval_sec` | Polling interval in seconds |

Authentication is basic auth built from env `JIRA_USER` / `JIRA_TOKEN`. No SDK is used — the poller calls Node's global `fetch`, so nothing is dynamically imported for this trigger. Multiple runbooks subscribing to the same `(base, jql)` share one poller.

The API endpoint is Jira Cloud's `/rest/api/3/search/jql` invoked as `POST`. The legacy `/rest/api/3/search` route has been removed in Jira Cloud and is not used. Pagination is `nextPageToken`-cursor based (capped at 50 hops per tick).

The cursor is the Jira issue `updated` time in ms, with the issue keys at the boundary ms kept for dedup. The JQL `updated >=` comparison is minute-granular, so the filter time is floored to a minute boundary.

### `github_workflow_runs`

```yaml
trigger:
  source: github_workflow_runs
  repo: example/app
  branch: main                 # optional, matcher-side filter on head_branch
  workflows:                   # optional. "ci.yml" / ".github/workflows/ci.yml" / workflow name
    - ci.yml
  conclusions:                 # optional. "to" conclusions that fire the runbook. Default ["failure"]
    - failure
    - cancelled
  interval_sec: 60
```

| Field | Purpose |
|---|---|
| `repo` | `owner/repo` |
| `branch` | Optional, filter on `head_branch` |
| `workflows` | Optional. Filter by workflow name / file path / slug |
| `conclusions` | Optional. `success` / `failure` / `cancelled` / `skipped` / `timed_out` / `action_required` / `neutral` / `startup_failure` / `stale` (GitHub literals, kept as-is). Default `["failure"]` |
| `interval_sec` | Polling interval in seconds |

Authentication uses env `GH_TOKEN` (Bearer). No SDK — Node's global `fetch` is used. Multiple runbooks subscribing to the same `repo` share one poller; `branch` / `workflows` / `conclusions` filters are applied per runbook in the matcher.

The cursor is the monotonic run id. The first observation seeds the cursor with the top run id (no history backfill). Each tick reads page 1 in DESC order and stops paginating the moment it sees a run with `id <= cursor`.

### `sentry_issues`

```yaml
trigger:
  source: sentry_issues
  base: https://sentry.io                # SaaS or self-hosted
  organization: my-org
  project: my-project
  levels:                                # optional. "To" levels that fire. Default ["error", "fatal"]
    - error
    - fatal
  interval_sec: 60
```

| Field | Purpose |
|---|---|
| `base` | Sentry base URL |
| `organization` | Sentry org slug |
| `project` | Sentry project slug |
| `levels` | Optional. `fatal` / `error` / `warning` / `info` / `debug` / `sample` (Sentry literals, kept as-is). Default `["error", "fatal"]` |
| `interval_sec` | Polling interval in seconds |

Authentication is env `SENTRY_AUTH_TOKEN` (Bearer). No SDK — Node's global `fetch` is used. Multiple runbooks subscribing to the same `(base, organization, project)` share one poller; the `levels` filter is applied per runbook in the matcher.

The cursor is a `{issue_id -> last_seen_ms}` map. `is:unresolved` issues are read over a 24h window; new issues fire with `is_new=true`, while known issues fire when their `last_seen` advances. The same prev-state-∪-newly-observed merge as `datadog_monitors` keeps known issues from being dropped on a partial fetch.

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

Per-trigger template variables (those whose value depends on the trigger source):

- `{{ event.line }}` — file: the matched line / aws_cloudwatch_logs: the message / datadog_log: the message
- `{{ event.path }}` — file: the log path / aws_cloudwatch_logs: the log_group / datadog_log: the query
- `{{ event.timestamp }}` — all triggers. Time of firing or transition observation (ISO 8601)
- `{{ event.log_stream }}` — aws_cloudwatch_logs only
- `{{ event.service }}` — datadog_log only
- `{{ event.host }}` — datadog_log only
- `{{ event.alarm_name }}` / `{{ event.alarm_arn }}` — aws_cloudwatch_alarm only
- `{{ event.monitor_id }}` / `{{ event.monitor_name }}` — datadog_monitor only
- `{{ event.issue_key }}` / `{{ event.summary }}` — jira_issue only
- `{{ event.status }}` — jira_issue / sentry_issue
- `{{ event.issue_id }}` / `{{ event.title }}` / `{{ event.level }}` / `{{ event.permalink }}` — sentry_issue only
- `{{ event.run_id }}` / `{{ event.workflow_name }}` / `{{ event.branch }}` / `{{ event.conclusion }}` / `{{ event.html_url }}` — github_workflow_run only
- `{{ event.from_state }}` / `{{ event.to_state }}` — aws_cloudwatch_alarm / datadog_monitor
- `{{ env.<NAME> }}` — `process.env[NAME]`

A template variable referenced for a trigger that does not produce it expands to the empty string.

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
- `cw-alarm-pagerduty.yaml` — CloudWatch alarm transitions → PagerDuty trigger/resolve
- `dd-logs-pagerduty.yaml` — Datadog Logs ERROR → PagerDuty trigger
- `jira-open-incident-slack.yaml` — Jira incident updated → Slack notification
- `github-ci-fix.yaml` — GitHub Actions CI failure → agent opens a fix PR
- `sentry-jira.yaml` — Sentry new-or-regressed issue → Jira ticket
