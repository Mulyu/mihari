# Changelog

## [0.1.0](https://github.com/Mulyu/mihari/releases/tag/v0.1.0) (2026-06-02)

### Features

* `file` trigger: tail log files and fire on regex match
* `cron` trigger: fire on 5-field cron expression
* `aws_cloudwatch_logs` trigger: poll CloudWatch Logs per event
* `aws_cloudwatch_alarms` trigger: poll CloudWatch Alarms on state transition
* `datadog_monitors` trigger: poll Datadog Monitor on state transition
* `datadog_logs` trigger: poll Datadog Logs Search per entry
* `jira_search` trigger: poll Jira JQL results with cursor management
* `github_workflow_runs` trigger: poll GitHub Actions completed runs
* `sentry_issues` trigger: poll Sentry new/regression issues
* Single `agent:` block execution via Claude Agent SDK
* Local state persistence under `~/.mihari/state/`
* Idempotency key injection (`MIHARI_IDEMPOTENCY_KEY`) into agent env
