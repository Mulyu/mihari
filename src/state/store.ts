import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { logger } from "../lib/logger.js";
import type {
  AwsCloudWatchAlarmState,
  AwsCloudWatchAlarmsPollerState,
  AwsCloudWatchLogsPollerState,
  DatadogLogsPollerState,
  DatadogMonitorState,
  DatadogMonitorsPollerState,
  JiraSearchPollerState,
  PollerState,
  RunResult,
  TriggerState,
} from "../types/index.js";

const log = logger("state");

export interface StateStoreOptions {
  baseDir?: string;
}

export class StateStore {
  readonly baseDir: string;

  constructor(opts: StateStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultStateDir();
    mkdirSync(join(this.baseDir, "pollers"), { recursive: true });
    mkdirSync(join(this.baseDir, "triggers"), { recursive: true });
    mkdirSync(join(this.baseDir, "aws-cloudwatch-logs"), { recursive: true });
    mkdirSync(join(this.baseDir, "aws-cloudwatch-alarms"), { recursive: true });
    mkdirSync(join(this.baseDir, "datadog-monitors"), { recursive: true });
    mkdirSync(join(this.baseDir, "datadog-logs"), { recursive: true });
    mkdirSync(join(this.baseDir, "jira-search"), { recursive: true });
    mkdirSync(join(this.baseDir, "runs"), { recursive: true });
  }

  pollerStateFile(filePath: string): string {
    const hash = createHash("sha1").update(resolve(filePath)).digest("hex").slice(0, 16);
    return join(this.baseDir, "pollers", `${hash}.json`);
  }

  loadPollerState(filePath: string): PollerState | null {
    const file = this.pollerStateFile(filePath);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validatePollerState(obj)) {
        log.warn({ file }, "poller state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn({ file, err: err.message }, "poller state read failed, treating as empty");
      return null;
    }
  }

  async savePollerState(state: PollerState): Promise<void> {
    const file = this.pollerStateFile(state.path);
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      // fail-open: state破損で全ポーリングが止まるほうが運用上のリスクが大きい
      log.warn({ file, err: (e as Error).message }, "poller state write failed");
    }
  }

  triggerStateFile(runbookId: string): string {
    const hash = createHash("sha1").update(runbookId).digest("hex").slice(0, 16);
    return join(this.baseDir, "triggers", `${hash}.json`);
  }

  loadTriggerState(runbookId: string): TriggerState | null {
    const file = this.triggerStateFile(runbookId);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateTriggerState(obj)) {
        log.warn({ file }, "trigger state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn({ file, err: err.message }, "trigger state read failed, treating as empty");
      return null;
    }
  }

  async saveTriggerState(state: TriggerState): Promise<void> {
    const file = this.triggerStateFile(state.runbook_id);
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn({ file, err: (e as Error).message }, "trigger state write failed");
    }
  }

  awsCloudWatchLogsStateFile(key: { region: string; logGroup: string }): string {
    const hash = createHash("sha1")
      .update(`${key.region}|${key.logGroup}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.baseDir, "aws-cloudwatch-logs", `${hash}.json`);
  }

  loadAwsCloudWatchLogsState(key: {
    region: string;
    logGroup: string;
  }): AwsCloudWatchLogsPollerState | null {
    const file = this.awsCloudWatchLogsStateFile(key);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateAwsCloudWatchLogsState(obj)) {
        log.warn({ file }, "aws-cloudwatch-logs state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn(
        { file, err: err.message },
        "aws-cloudwatch-logs state read failed, treating as empty",
      );
      return null;
    }
  }

  async saveAwsCloudWatchLogsState(state: AwsCloudWatchLogsPollerState): Promise<void> {
    const file = this.awsCloudWatchLogsStateFile({
      region: state.region,
      logGroup: state.log_group,
    });
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn(
        { file, err: (e as Error).message },
        "aws-cloudwatch-logs state write failed",
      );
    }
  }

  awsCloudWatchAlarmsStateFile(key: { region: string; alarmNames: string[] }): string {
    const namesPart = [...key.alarmNames].sort().join(",");
    const hash = createHash("sha1")
      .update(`${key.region}|${namesPart}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.baseDir, "aws-cloudwatch-alarms", `${hash}.json`);
  }

  loadAwsCloudWatchAlarmsState(key: {
    region: string;
    alarmNames: string[];
  }): AwsCloudWatchAlarmsPollerState | null {
    const file = this.awsCloudWatchAlarmsStateFile(key);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateAwsCloudWatchAlarmsState(obj)) {
        log.warn({ file }, "aws-cloudwatch-alarms state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn(
        { file, err: err.message },
        "aws-cloudwatch-alarms state read failed, treating as empty",
      );
      return null;
    }
  }

  async saveAwsCloudWatchAlarmsState(state: AwsCloudWatchAlarmsPollerState): Promise<void> {
    const file = this.awsCloudWatchAlarmsStateFile({
      region: state.region,
      alarmNames: state.alarm_names,
    });
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn(
        { file, err: (e as Error).message },
        "aws-cloudwatch-alarms state write failed",
      );
    }
  }

  datadogMonitorsStateFile(key: { site: string; monitorTags: string[] }): string {
    const tagsPart = [...key.monitorTags].sort().join(",");
    const hash = createHash("sha1")
      .update(`${key.site}|${tagsPart}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.baseDir, "datadog-monitors", `${hash}.json`);
  }

  loadDatadogMonitorsState(key: {
    site: string;
    monitorTags: string[];
  }): DatadogMonitorsPollerState | null {
    const file = this.datadogMonitorsStateFile(key);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateDatadogMonitorsState(obj)) {
        log.warn({ file }, "datadog-monitors state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn(
        { file, err: err.message },
        "datadog-monitors state read failed, treating as empty",
      );
      return null;
    }
  }

  async saveDatadogMonitorsState(state: DatadogMonitorsPollerState): Promise<void> {
    const file = this.datadogMonitorsStateFile({
      site: state.site,
      monitorTags: state.monitor_tags,
    });
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn(
        { file, err: (e as Error).message },
        "datadog-monitors state write failed",
      );
    }
  }

  datadogLogsStateFile(key: { site: string; query: string }): string {
    const hash = createHash("sha1")
      .update(`${key.site}|${key.query}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.baseDir, "datadog-logs", `${hash}.json`);
  }

  loadDatadogLogsState(key: {
    site: string;
    query: string;
  }): DatadogLogsPollerState | null {
    const file = this.datadogLogsStateFile(key);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateDatadogLogsState(obj)) {
        log.warn({ file }, "datadog-logs state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn({ file, err: err.message }, "datadog-logs state read failed, treating as empty");
      return null;
    }
  }

  async saveDatadogLogsState(state: DatadogLogsPollerState): Promise<void> {
    const file = this.datadogLogsStateFile({ site: state.site, query: state.query });
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn({ file, err: (e as Error).message }, "datadog-logs state write failed");
    }
  }

  jiraSearchStateFile(key: { base: string; jql: string }): string {
    const hash = createHash("sha1")
      .update(`${key.base}|${key.jql}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.baseDir, "jira-search", `${hash}.json`);
  }

  loadJiraSearchState(key: { base: string; jql: string }): JiraSearchPollerState | null {
    const file = this.jiraSearchStateFile(key);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validateJiraSearchState(obj)) {
        log.warn({ file }, "jira-search state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn({ file, err: err.message }, "jira-search state read failed, treating as empty");
      return null;
    }
  }

  async saveJiraSearchState(state: JiraSearchPollerState): Promise<void> {
    const file = this.jiraSearchStateFile({ base: state.base, jql: state.jql });
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log.warn({ file, err: (e as Error).message }, "jira-search state write failed");
    }
  }

  async appendRunResult(result: RunResult): Promise<void> {
    const date = result.started_at.slice(0, 10);
    const dir = join(this.baseDir, "runs", date);
    const file = join(dir, `${result.run_id}.jsonl`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(result) + "\n", { flag: "a" });
    } catch (e) {
      log.warn({ file, err: (e as Error).message }, "run result write failed");
    }
  }

  listRuns(opts: ListRunsOptions = {}): RunResult[] {
    const limit = opts.limit ?? 20;
    const since = opts.since ? opts.since.slice(0, 10) : null;
    const dates = listRunDates(this.baseDir);
    const out: RunResult[] = [];
    for (const date of dates) {
      if (since && date < since) break;
      for (const r of readDateDir(join(this.baseDir, "runs", date))) {
        if (opts.runbookId && r.runbook_id !== opts.runbookId) continue;
        out.push(r);
      }
    }
    out.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return out.slice(0, limit);
  }

  getRun(runId: string): RunResult | null {
    const dates = listRunDates(this.baseDir);
    for (const date of dates) {
      const file = join(this.baseDir, "runs", date, `${runId}.jsonl`);
      if (!existsSync(file)) continue;
      const records = readJsonlFile(file);
      // 同一 run_id に複数行があっても、最終行を最新とみなす（append 想定）
      return records[records.length - 1] ?? null;
    }
    return null;
  }
}

export interface ListRunsOptions {
  limit?: number;
  runbookId?: string;
  // ISO date string YYYY-MM-DD or full ISO timestamp; only YYYY-MM-DD prefix is used.
  since?: string;
}

function listRunDates(baseDir: string): string[] {
  const runsDir = join(baseDir, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

function readDateDir(dir: string): RunResult[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"));
  const out: RunResult[] = [];
  for (const f of files) {
    out.push(...readJsonlFile(join(dir, f.name)));
  }
  return out;
}

function readJsonlFile(file: string): RunResult[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    log.warn({ file, err: (e as Error).message }, "run record read failed");
    return [];
  }
  const out: RunResult[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      log.warn({ file }, "skipping malformed run record line");
      continue;
    }
    if (!isRunResultShape(obj)) {
      log.warn({ file }, "skipping run record from a pre-1.0 schema (no agent field)");
      continue;
    }
    out.push(obj);
  }
  return out;
}

function isRunResultShape(v: unknown): v is RunResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["run_id"] === "string" &&
    typeof o["runbook_id"] === "string" &&
    typeof o["agent"] === "object" &&
    o["agent"] !== null
  );
}

export function defaultStateDir(): string {
  return process.env["MIHARI_STATE_DIR"] ?? join(homedir(), ".mihari", "state");
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  // Pre-create the file so proper-lockfile can lock on it.
  writeFileSync(file, "", { flag: "a" });
  const release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } });
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  } finally {
    await release();
  }
}

function validatePollerState(v: unknown): v is PollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["path"] === "string" &&
    typeof o["inode"] === "number" &&
    typeof o["size"] === "number" &&
    typeof o["offset"] === "number" &&
    typeof o["updated_at"] === "string"
  );
}

function validateTriggerState(v: unknown): v is TriggerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["runbook_id"] === "string" && typeof o["last_fired_at"] === "string";
}

function validateAwsCloudWatchLogsState(v: unknown): v is AwsCloudWatchLogsPollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o["region"] !== "string" ||
    typeof o["log_group"] !== "string" ||
    typeof o["last_event_timestamp_ms"] !== "number" ||
    typeof o["last_polled_at"] !== "string"
  ) {
    return false;
  }
  const ids = o["last_event_ids"];
  if (!Array.isArray(ids)) return false;
  return ids.every((x) => typeof x === "string");
}

function validateJiraSearchState(v: unknown): v is JiraSearchPollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o["base"] !== "string" ||
    typeof o["jql"] !== "string" ||
    typeof o["last_updated_ms"] !== "number" ||
    typeof o["last_polled_at"] !== "string"
  ) {
    return false;
  }
  const ks = o["last_issue_keys"];
  if (!Array.isArray(ks)) return false;
  return ks.every((x) => typeof x === "string");
}

function validateDatadogLogsState(v: unknown): v is DatadogLogsPollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o["site"] !== "string" ||
    typeof o["query"] !== "string" ||
    typeof o["last_event_timestamp_ms"] !== "number" ||
    typeof o["last_polled_at"] !== "string"
  ) {
    return false;
  }
  const ids = o["last_event_ids"];
  if (!Array.isArray(ids)) return false;
  return ids.every((x) => typeof x === "string");
}

const AWS_CLOUDWATCH_ALARM_STATE_VALUES: readonly AwsCloudWatchAlarmState[] = [
  "OK",
  "ALARM",
  "INSUFFICIENT_DATA",
];

function validateAwsCloudWatchAlarmsState(v: unknown): v is AwsCloudWatchAlarmsPollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["region"] !== "string" || typeof o["last_polled_at"] !== "string") return false;
  const names = o["alarm_names"];
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) return false;
  const states = o["alarm_states"];
  if (typeof states !== "object" || states === null || Array.isArray(states)) return false;
  for (const value of Object.values(states as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
    if (!(AWS_CLOUDWATCH_ALARM_STATE_VALUES as readonly string[]).includes(value)) return false;
  }
  return true;
}

const DATADOG_MONITOR_STATE_VALUES: readonly DatadogMonitorState[] = [
  "alert",
  "warn",
  "no_data",
  "ok",
  "skipped",
  "ignored",
  "unknown",
];

function validateDatadogMonitorsState(v: unknown): v is DatadogMonitorsPollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["site"] !== "string" || typeof o["last_polled_at"] !== "string") return false;
  const tags = o["monitor_tags"];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) return false;
  const states = o["monitor_states"];
  if (typeof states !== "object" || states === null || Array.isArray(states)) return false;
  for (const value of Object.values(states as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
    if (!(DATADOG_MONITOR_STATE_VALUES as readonly string[]).includes(value)) return false;
  }
  return true;
}
