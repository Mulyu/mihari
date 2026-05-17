import { resolve } from "node:path";
import type {
  AwsCloudWatchAlarmsTrigger,
  AwsCloudWatchLogsTrigger,
  DatadogLogsTrigger,
  DatadogMonitorsTrigger,
  FileTrigger,
  GcpCloudLoggingTrigger,
  JiraSearchTrigger,
  Match,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

type FileRunbook = Runbook & { trigger: FileTrigger };
type AwsCloudWatchLogsRunbook = Runbook & { trigger: AwsCloudWatchLogsTrigger };
type AwsCloudWatchAlarmsRunbook = Runbook & { trigger: AwsCloudWatchAlarmsTrigger };
type DatadogMonitorsRunbook = Runbook & { trigger: DatadogMonitorsTrigger };
type DatadogLogsRunbook = Runbook & { trigger: DatadogLogsTrigger };
type JiraSearchRunbook = Runbook & { trigger: JiraSearchTrigger };
type GcpCloudLoggingRunbook = Runbook & { trigger: GcpCloudLoggingTrigger };

function isFileRunbook(rb: Runbook): rb is FileRunbook {
  return rb.trigger.source === "file";
}

function isAwsCloudWatchLogsRunbook(rb: Runbook): rb is AwsCloudWatchLogsRunbook {
  return rb.trigger.source === "aws_cloudwatch_logs";
}

function isAwsCloudWatchAlarmsRunbook(rb: Runbook): rb is AwsCloudWatchAlarmsRunbook {
  return rb.trigger.source === "aws_cloudwatch_alarms";
}

function isDatadogMonitorsRunbook(rb: Runbook): rb is DatadogMonitorsRunbook {
  return rb.trigger.source === "datadog_monitors";
}

function isDatadogLogsRunbook(rb: Runbook): rb is DatadogLogsRunbook {
  return rb.trigger.source === "datadog_logs";
}

function isJiraSearchRunbook(rb: Runbook): rb is JiraSearchRunbook {
  return rb.trigger.source === "jira_search";
}

function isGcpCloudLoggingRunbook(rb: Runbook): rb is GcpCloudLoggingRunbook {
  return rb.trigger.source === "gcp_cloud_logging";
}

export function match(
  event: Extract<TriggerEvent, { type: "file" }>,
  runbooks: Runbook[],
): Match[] {
  const eventPath = resolve(event.path);
  return runbooks
    .filter(isFileRunbook)
    .filter(
      (r) =>
        resolve(r.trigger.path) === eventPath && r.trigger.pattern.test(event.content),
    )
    .map((r) => ({ runbook: r, event }));
}

export function matchAwsCloudWatchLogs(
  event: Extract<TriggerEvent, { type: "aws_cloudwatch_logs" }>,
  runbooks: Runbook[],
): Match[] {
  return runbooks
    .filter(isAwsCloudWatchLogsRunbook)
    .filter(
      (r) =>
        r.trigger.region === event.region &&
        r.trigger.log_group === event.log_group &&
        (r.trigger.pattern === undefined || r.trigger.pattern.test(event.message)),
    )
    .map((r) => ({ runbook: r, event }));
}

// CloudWatch Alarm の状態遷移は poller が全件 emit する。runbook 側は
// `(region, alarm_names)` の購読キーが一致し、かつ `transitions` に到達状態が
// 含まれる場合に発火する（datadog_monitors と同じパターン）。
export function matchAwsCloudWatchAlarm(
  event: Extract<TriggerEvent, { type: "aws_cloudwatch_alarm" }>,
  runbooks: Runbook[],
): Match[] {
  const eventNames = [...event.alarm_names].sort().join(",");
  return runbooks
    .filter(isAwsCloudWatchAlarmsRunbook)
    .filter((r) => {
      if (r.trigger.region !== event.region) return false;
      const triggerNames = [...(r.trigger.alarm_names ?? [])].sort().join(",");
      if (triggerNames !== eventNames) return false;
      return r.trigger.transitions.includes(event.to_state);
    })
    .map((r) => ({ runbook: r, event }));
}

// Datadog Monitor の状態遷移は poller が全件 emit する。runbook 側は
// `(site, monitor_tags)` の購読キーが一致し、かつ `transitions` に到達状態が
// 含まれる場合に発火する。同じ key を異なる transitions で複数 runbook が購読
// できるよう、フィルタは matcher 側で行う。
export function matchDatadogMonitor(
  event: Extract<TriggerEvent, { type: "datadog_monitor" }>,
  runbooks: Runbook[],
): Match[] {
  const eventTags = [...event.monitor_tags].sort().join(",");
  return runbooks
    .filter(isDatadogMonitorsRunbook)
    .filter((r) => {
      if (r.trigger.site !== event.site) return false;
      const triggerTags = [...(r.trigger.monitor_tags ?? [])].sort().join(",");
      if (triggerTags !== eventTags) return false;
      return r.trigger.transitions.includes(event.to_state);
    })
    .map((r) => ({ runbook: r, event }));
}

export function matchDatadogLog(
  event: Extract<TriggerEvent, { type: "datadog_log" }>,
  runbooks: Runbook[],
): Match[] {
  return runbooks
    .filter(isDatadogLogsRunbook)
    .filter((r) => r.trigger.site === event.site && r.trigger.query === event.query)
    .map((r) => ({ runbook: r, event }));
}

export function matchJiraIssue(
  event: Extract<TriggerEvent, { type: "jira_issue" }>,
  runbooks: Runbook[],
): Match[] {
  return runbooks
    .filter(isJiraSearchRunbook)
    .filter((r) => r.trigger.base === event.base && r.trigger.jql === event.jql)
    .map((r) => ({ runbook: r, event }));
}

export function matchGcpCloudLogging(
  event: Extract<TriggerEvent, { type: "gcp_cloud_logging" }>,
  runbooks: Runbook[],
): Match[] {
  return runbooks
    .filter(isGcpCloudLoggingRunbook)
    .filter(
      (r) => r.trigger.project_id === event.project_id && r.trigger.filter === event.filter,
    )
    .map((r) => ({ runbook: r, event }));
}

export function uniqueTriggerPaths(runbooks: Runbook[]): string[] {
  return Array.from(
    new Set(runbooks.filter(isFileRunbook).map((r) => resolve(r.trigger.path))),
  );
}
