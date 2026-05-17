import {
  match,
  matchAwsCloudWatchAlarm,
  matchAwsCloudWatchLogs,
  matchDatadogLog,
  matchDatadogMonitor,
  matchGcpCloudLogging,
  matchGithubWorkflowRun,
  matchJiraIssue,
  matchSentryIssue,
} from "./matcher.js";
import type { Executor } from "./executor.js";
import type { CronScheduler } from "../triggers/cron.js";
import type { FilePoller } from "../triggers/file.js";
import type { AwsCloudWatchLogsPoller } from "../triggers/aws-cloudwatch-logs.js";
import type { AwsCloudWatchAlarmsPoller } from "../triggers/aws-cloudwatch-alarms.js";
import type { DatadogMonitorsPoller } from "../triggers/datadog-monitors.js";
import type { DatadogLogsPoller } from "../triggers/datadog-logs.js";
import type { JiraSearchPoller } from "../triggers/jira-search.js";
import type { GcpCloudLoggingPoller } from "../triggers/gcp-cloud-logging.js";
import type { GithubWorkflowRunsPoller } from "../triggers/github-workflow-runs.js";
import type { SentryIssuesPoller } from "../triggers/sentry-issues.js";
import type { StateStore } from "../state/store.js";
import type { Runbook } from "../types/index.js";

export interface DispatcherInput {
  runbooks: Runbook[];
  pollers: FilePoller[];
  cronSchedulers: CronScheduler[];
  // 配線していないテスト互換のため optional。本番 (CLI bootstrap) では必ず配列で渡す。
  awsCloudWatchLogsPollers?: AwsCloudWatchLogsPoller[];
  awsCloudWatchAlarmsPollers?: AwsCloudWatchAlarmsPoller[];
  datadogMonitorsPollers?: DatadogMonitorsPoller[];
  datadogLogsPollers?: DatadogLogsPoller[];
  jiraSearchPollers?: JiraSearchPoller[];
  gcpCloudLoggingPollers?: GcpCloudLoggingPoller[];
  githubWorkflowRunsPollers?: GithubWorkflowRunsPoller[];
  sentryIssuesPollers?: SentryIssuesPoller[];
  executor: Executor;
  state: StateStore;
}

export interface TickOptions {
  dryRun?: boolean;
  onDryRun?: (msg: string) => void;
}

export interface TickResult {
  ok: boolean;
  fired: number;
}

export async function tick(
  input: DispatcherInput,
  opts: TickOptions = {},
): Promise<TickResult> {
  let ok = true;
  let fired = 0;

  for (const poller of input.pollers) {
    const events = await poller.tick(opts.dryRun ?? false);
    for (const event of events) {
      const matches = match(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(`${m.runbook.id} <- ${event.path}: ${event.content}`);
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const cwPoller of input.awsCloudWatchLogsPollers ?? []) {
    const events = await cwPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchAwsCloudWatchLogs(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- aws_cloudwatch_logs:${event.log_group}/${event.log_stream}: ${event.message}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const alarmPoller of input.awsCloudWatchAlarmsPollers ?? []) {
    const events = await alarmPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchAwsCloudWatchAlarm(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- aws_cloudwatch_alarms:${event.region}|${event.alarm_names.join(",")}: ${event.alarm_name} (${event.from_state} -> ${event.to_state})`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const ddPoller of input.datadogMonitorsPollers ?? []) {
    const events = await ddPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchDatadogMonitor(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- datadog_monitors:${event.site}|${event.monitor_tags.join(",")}: ${event.monitor_name} (${event.from_state} -> ${event.to_state})`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const ddLogsPoller of input.datadogLogsPollers ?? []) {
    const events = await ddLogsPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchDatadogLog(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- datadog_logs:${event.site}|${event.query}: ${event.message}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const jiraPoller of input.jiraSearchPollers ?? []) {
    const events = await jiraPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchJiraIssue(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- jira_search:${event.base}|${event.jql}: ${event.issue_key} ${event.status}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const gcpPoller of input.gcpCloudLoggingPollers ?? []) {
    const events = await gcpPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchGcpCloudLogging(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- gcp_cloud_logging:${event.project_id}|${event.filter}: ${event.message}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const ghPoller of input.githubWorkflowRunsPollers ?? []) {
    const events = await ghPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchGithubWorkflowRun(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- github_workflow_runs:${event.repo}: ${event.workflow_name}#${event.run_number} ${event.conclusion}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const sentryPoller of input.sentryIssuesPollers ?? []) {
    const events = await sentryPoller.tick(new Date(), opts.dryRun ?? false);
    for (const event of events) {
      const matches = matchSentryIssue(event, input.runbooks);
      for (const m of matches) {
        if (m.runbook.enabled === false) continue;
        if (!isCooldownElapsed(m.runbook, input.state)) continue;
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(
            `${m.runbook.id} <- sentry_issues:${event.organization}/${event.project}: ${event.short_id} (${event.level}) ${event.title}`,
          );
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const scheduler of input.cronSchedulers) {
    if (scheduler.runbook.enabled === false) continue;
    const event = await scheduler.tick(new Date(), opts.dryRun ?? false);
    if (!event) continue;
    if (!isCooldownElapsed(scheduler.runbook, input.state)) continue;
    fired++;
    if (opts.dryRun) {
      opts.onDryRun?.(`${scheduler.runbook.id} <- cron@${event.timestamp}`);
      continue;
    }
    const result = await input.executor.execute(scheduler.runbook, event);
    if (!result.ok) ok = false;
  }

  return { ok, fired };
}

function isCooldownElapsed(runbook: Runbook, state: StateStore): boolean {
  if (!runbook.cooldown_sec) return true;
  const [lastRun] = state.listRuns({ limit: 1, runbookId: runbook.id });
  if (!lastRun) return true;
  const elapsed = (Date.now() - new Date(lastRun.started_at).getTime()) / 1000;
  return elapsed >= runbook.cooldown_sec;
}
