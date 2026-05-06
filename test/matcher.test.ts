import { describe, expect, it } from "vitest";
import { match, matchCloudWatchLogs, uniqueTriggerPaths } from "../src/engine/matcher.js";
import type { Runbook, TriggerEvent } from "../src/types/index.js";

function fileRb(id: string, path: string, pattern: RegExp): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cronRb(id: string, schedule: string): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function fileEvent(path: string, content: string): Extract<TriggerEvent, { type: "file" }> {
  return { type: "file", path, content, timestamp: "2026-04-26T00:00:00Z" };
}

describe("match", () => {
  it("returns runbooks whose trigger.path and pattern match", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /ERROR/),
      fileRb("b", "/var/log/app.log", /WARN/),
      fileRb("c", "/var/log/other.log", /ERROR/),
    ];
    const m = match(fileEvent("/var/log/app.log", "ERROR: foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("returns multiple matches when several runbooks apply", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /ERROR/),
      fileRb("b", "/var/log/app.log", /foo/),
    ];
    const m = match(fileEvent("/var/log/app.log", "ERROR foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a", "b"]);
  });

  it("normalizes paths", () => {
    const rbs = [fileRb("a", "/var/log/app.log", /x/)];
    const m = match(fileEvent("/var/log/./app.log", "x"), rbs);
    expect(m).toHaveLength(1);
  });

  it("ignores cron runbooks", () => {
    const rbs = [cronRb("c", "* * * * *"), fileRb("a", "/var/log/app.log", /x/)];
    const m = match(fileEvent("/var/log/app.log", "x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function cwRb(
  id: string,
  region: string,
  group: string,
  pattern?: RegExp,
): Runbook {
  return {
    id,
    trigger: pattern
      ? { source: "cloudwatch_logs", region, log_group: group, interval_sec: 60, pattern }
      : { source: "cloudwatch_logs", region, log_group: group, interval_sec: 60 },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cwEvent(
  region: string,
  group: string,
  message: string,
): Extract<TriggerEvent, { type: "cloudwatch_logs" }> {
  return {
    type: "cloudwatch_logs",
    region,
    log_group: group,
    log_stream: "s",
    message,
    event_id: "id1",
    timestamp: "2026-04-26T00:00:00Z",
    timestamp_ms: 0,
  };
}

describe("matchCloudWatchLogs", () => {
  it("matches by region + log_group + pattern", () => {
    const rbs = [
      cwRb("a", "us-east-1", "/g", /ERROR/),
      cwRb("b", "us-east-1", "/g", /WARN/),
      cwRb("c", "us-east-1", "/h", /ERROR/),
      cwRb("d", "us-west-2", "/g", /ERROR/),
    ];
    const m = matchCloudWatchLogs(cwEvent("us-east-1", "/g", "ERROR x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("matches all events when pattern is omitted", () => {
    const rbs = [cwRb("a", "us-east-1", "/g")];
    const m = matchCloudWatchLogs(cwEvent("us-east-1", "/g", "anything"), rbs);
    expect(m).toHaveLength(1);
  });

  it("ignores file/cron runbooks", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwRb("a", "us-east-1", "/g"),
    ];
    const m = matchCloudWatchLogs(cwEvent("us-east-1", "/g", "x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

describe("uniqueTriggerPaths", () => {
  it("deduplicates and resolves, ignoring cron", () => {
    const rbs = [
      fileRb("a", "/var/log/app.log", /x/),
      fileRb("b", "/var/log/./app.log", /y/),
      fileRb("c", "/var/log/other.log", /z/),
      cronRb("d", "* * * * *"),
    ];
    expect(uniqueTriggerPaths(rbs).sort()).toEqual([
      "/var/log/app.log",
      "/var/log/other.log",
    ]);
  });
});
