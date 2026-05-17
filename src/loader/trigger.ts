import { Cron } from "croner";
import type {
  AwsCloudWatchAlarmState,
  DatadogMonitorState,
  Trigger,
} from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import { isObject, mustString, optionalNumber, optionalString } from "./primitives.js";

const AWS_CLOUDWATCH_ALARM_STATES: readonly AwsCloudWatchAlarmState[] = [
  "OK",
  "ALARM",
  "INSUFFICIENT_DATA",
];

const DATADOG_MONITOR_STATES: readonly DatadogMonitorState[] = [
  "alert",
  "warn",
  "no_data",
  "ok",
  "skipped",
  "ignored",
  "unknown",
];

export function validateTrigger(raw: unknown, file: string): Trigger {
  if (!isObject(raw)) throw new RunbookValidationError(file, "trigger must be a mapping");
  const source = mustString(raw, "source", file, "trigger.source");
  if (source === "file") {
    const path = mustString(raw, "path", file, "trigger.path");
    const patternStr = mustString(raw, "pattern", file, "trigger.pattern");
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternStr);
    } catch (e) {
      throw new RunbookValidationError(
        file,
        `trigger.pattern is not a valid regex: ${(e as Error).message}`,
      );
    }
    return { source: "file", path, pattern };
  }
  if (source === "cron") {
    const schedule = mustString(raw, "schedule", file, "trigger.schedule");
    try {
      // Validate by constructing — Cron throws synchronously on bad expressions.
      new Cron(schedule);
    } catch (e) {
      throw new RunbookValidationError(
        file,
        `trigger.schedule is not a valid cron expression: ${(e as Error).message}`,
      );
    }
    return { source: "cron", schedule };
  }
  if (source === "aws_cloudwatch_logs") {
    const region = mustString(raw, "region", file, "trigger.region");
    const log_group = mustString(raw, "log_group", file, "trigger.log_group");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    const patternStr = optionalString(raw, "pattern", file, "trigger.pattern");
    let pattern: RegExp | undefined;
    if (patternStr !== undefined) {
      try {
        pattern = new RegExp(patternStr);
      } catch (e) {
        throw new RunbookValidationError(
          file,
          `trigger.pattern is not a valid regex: ${(e as Error).message}`,
        );
      }
    }
    const t: Trigger = {
      source: "aws_cloudwatch_logs",
      region,
      log_group,
      interval_sec,
    };
    if (pattern !== undefined) t.pattern = pattern;
    return t;
  }
  if (source === "aws_cloudwatch_alarms") {
    const region = mustString(raw, "region", file, "trigger.region");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    const alarm_names = parseStringArray(raw, "alarm_names", file, "trigger.alarm_names");
    const transitions = parseAwsCloudWatchAlarmTransitions(raw, file);
    const t: Trigger = {
      source: "aws_cloudwatch_alarms",
      region,
      transitions,
      interval_sec,
    };
    if (alarm_names !== undefined) t.alarm_names = alarm_names;
    return t;
  }
  if (source === "datadog_monitors") {
    const site = mustString(raw, "site", file, "trigger.site");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    const monitor_tags = parseStringArray(raw, "monitor_tags", file, "trigger.monitor_tags");
    const transitions = parseTransitions(raw, file);
    const t: Trigger = {
      source: "datadog_monitors",
      site,
      transitions,
      interval_sec,
    };
    if (monitor_tags !== undefined) t.monitor_tags = monitor_tags;
    return t;
  }
  if (source === "datadog_logs") {
    const site = mustString(raw, "site", file, "trigger.site");
    const query = mustString(raw, "query", file, "trigger.query");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    return {
      source: "datadog_logs",
      site,
      query,
      interval_sec,
    };
  }
  if (source === "jira_search") {
    const base = mustString(raw, "base", file, "trigger.base");
    if (!/^https?:\/\//.test(base))
      throw new RunbookValidationError(file, "trigger.base must be a http(s) URL");
    const jql = mustString(raw, "jql", file, "trigger.jql");
    if (/order\s+by/i.test(jql))
      throw new RunbookValidationError(
        file,
        'trigger.jql must not include "ORDER BY" (the poller orders by updated)',
      );
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    return {
      source: "jira_search",
      base: base.replace(/\/+$/, ""),
      jql,
      interval_sec,
    };
  }
  if (source === "gcp_cloud_logging") {
    const project_id = mustString(raw, "project_id", file, "trigger.project_id");
    const filter = mustString(raw, "filter", file, "trigger.filter");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    return {
      source: "gcp_cloud_logging",
      project_id,
      filter,
      interval_sec,
    };
  }
  throw new RunbookValidationError(
    file,
    `trigger.source must be one of: file, cron, aws_cloudwatch_logs, aws_cloudwatch_alarms, datadog_monitors, datadog_logs, jira_search, gcp_cloud_logging (got: ${source})`,
  );
}

function parseAwsCloudWatchAlarmTransitions(
  raw: Record<string, unknown>,
  file: string,
): AwsCloudWatchAlarmState[] {
  const v = raw["transitions"];
  if (v === undefined) return ["ALARM"];
  if (!Array.isArray(v) || v.length === 0) {
    throw new RunbookValidationError(
      file,
      "trigger.transitions must be a non-empty array of state literals",
    );
  }
  const out: AwsCloudWatchAlarmState[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !isAwsCloudWatchAlarmState(item)) {
      throw new RunbookValidationError(
        file,
        `trigger.transitions entries must be one of: ${AWS_CLOUDWATCH_ALARM_STATES.join(", ")} (got: ${String(item)})`,
      );
    }
    out.push(item);
  }
  return out;
}

function isAwsCloudWatchAlarmState(s: string): s is AwsCloudWatchAlarmState {
  return (AWS_CLOUDWATCH_ALARM_STATES as readonly string[]).includes(s);
}

function parseStringArray(
  raw: Record<string, unknown>,
  key: string,
  file: string,
  ctx: string,
): string[] | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new RunbookValidationError(file, `${ctx} must be an array of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      throw new RunbookValidationError(file, `${ctx} entries must be non-empty strings`);
    }
  }
  return v.map((s) => s as string);
}

function parseTransitions(raw: Record<string, unknown>, file: string): DatadogMonitorState[] {
  const v = raw["transitions"];
  if (v === undefined) return ["alert"];
  if (!Array.isArray(v) || v.length === 0) {
    throw new RunbookValidationError(
      file,
      "trigger.transitions must be a non-empty array of state literals",
    );
  }
  const out: DatadogMonitorState[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !isDatadogMonitorState(item)) {
      throw new RunbookValidationError(
        file,
        `trigger.transitions entries must be one of: ${DATADOG_MONITOR_STATES.join(", ")} (got: ${String(
          item,
        )})`,
      );
    }
    out.push(item);
  }
  return out;
}

function isDatadogMonitorState(s: string): s is DatadogMonitorState {
  return (DATADOG_MONITOR_STATES as readonly string[]).includes(s);
}
