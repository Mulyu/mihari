export type Trigger =
  | FileTrigger
  | CronTrigger
  | AwsCloudWatchLogsTrigger
  | AwsCloudWatchAlarmsTrigger
  | DatadogMonitorsTrigger;

export interface Runbook {
  id: string;
  description?: string;
  trigger: Trigger;
  agent: Agent;
  sourcePath: string;
  enabled?: boolean;
  cooldown_sec?: number;
}

export interface FileTrigger {
  source: "file";
  path: string;
  pattern: RegExp;
}

export interface CronTrigger {
  source: "cron";
  schedule: string;
}

export interface AwsCloudWatchLogsTrigger {
  source: "aws_cloudwatch_logs";
  region: string;
  log_group: string;
  pattern?: RegExp;
  interval_sec: number;
}

export type AwsCloudWatchAlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA";

export interface AwsCloudWatchAlarmsTrigger {
  source: "aws_cloudwatch_alarms";
  region: string;
  alarm_names?: string[];
  transitions: AwsCloudWatchAlarmState[];
  interval_sec: number;
}

export type DatadogMonitorState =
  | "alert"
  | "warn"
  | "no_data"
  | "ok"
  | "skipped"
  | "ignored"
  | "unknown";

export interface DatadogMonitorsTrigger {
  source: "datadog_monitors";
  site: string;
  monitor_tags?: string[];
  transitions: DatadogMonitorState[];
  interval_sec: number;
}

export interface Agent {
  prompt: string;
  system?: string;
  model: string;
  allowed_tools: string[];
  permission_mode: "strict" | "bypass";
  max_turns: number;
  timeout_sec: number;
  conventions: boolean;
  cwd?: string;
}

export type TriggerEvent =
  | { type: "file"; path: string; content: string; timestamp: string }
  | { type: "cron"; timestamp: string }
  | { type: "manual"; timestamp: string }
  | {
      type: "aws_cloudwatch_logs";
      region: string;
      log_group: string;
      log_stream: string;
      message: string;
      event_id: string;
      timestamp: string;
      timestamp_ms: number;
    }
  | {
      type: "aws_cloudwatch_alarm";
      region: string;
      alarm_names: string[];
      alarm_name: string;
      alarm_arn: string;
      from_state: AwsCloudWatchAlarmState;
      to_state: AwsCloudWatchAlarmState;
      timestamp: string;
    }
  | {
      type: "datadog_monitor";
      site: string;
      monitor_tags: string[];
      monitor_id: string;
      monitor_name: string;
      from_state: DatadogMonitorState;
      to_state: DatadogMonitorState;
      timestamp: string;
    };

export interface AgentContext {
  event: TriggerEvent;
  idempotencyKey: string;
}

export interface Match {
  runbook: Runbook;
  event: TriggerEvent;
}

export interface PollerState {
  path: string;
  inode: number;
  size: number;
  offset: number;
  updated_at: string;
}

export interface TriggerState {
  runbook_id: string;
  last_fired_at: string;
}

export interface AwsCloudWatchLogsPollerState {
  region: string;
  log_group: string;
  last_event_timestamp_ms: number;
  last_event_ids: string[];
  last_polled_at: string;
}

export interface AwsCloudWatchAlarmsPollerState {
  region: string;
  alarm_names: string[];
  alarm_states: Record<string, AwsCloudWatchAlarmState>;
  last_polled_at: string;
}

export interface DatadogMonitorsPollerState {
  site: string;
  monitor_tags: string[];
  monitor_states: Record<string, DatadogMonitorState>;
  last_polled_at: string;
}

export interface AgentResult {
  ok: boolean;
  exit_code: 0 | 1;
  stdout: string;
  duration_ms: number;
  timed_out: boolean;
  error: string | null;
}

export interface RunResult {
  run_id: string;
  runbook_id: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  agent: AgentResult;
  trigger_event: TriggerEvent;
}
