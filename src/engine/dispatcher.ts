import {
  match,
  matchAwsCloudWatchAlarm,
  matchAwsCloudWatchLogs,
  matchDatadogLog,
  matchDatadogMonitor,
} from "./matcher.js";
import type { Executor } from "./executor.js";
import type { CronScheduler } from "../triggers/cron.js";
import type { FilePoller } from "../triggers/file.js";
import type { AwsCloudWatchLogsPoller } from "../triggers/aws-cloudwatch-logs.js";
import type { AwsCloudWatchAlarmsPoller } from "../triggers/aws-cloudwatch-alarms.js";
import type { DatadogMonitorsPoller } from "../triggers/datadog-monitors.js";
import type { DatadogLogsPoller } from "../triggers/datadog-logs.js";
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
