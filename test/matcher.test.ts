import { describe, expect, it } from "vitest";
import {
  match,
  matchAwsCloudWatchLogs,
  matchDatadogMonitor,
  uniqueTriggerPaths,
} from "../src/engine/matcher.js";
import type { DatadogMonitorState, Runbook, TriggerEvent } from "../src/types/index.js";
import { fakeAgent } from "./_fixtures.js";

function fileRb(id: string, path: string, pattern: RegExp): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cronRb(id: string, schedule: string): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule },
    agent: fakeAgent(),
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
      ? { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60, pattern }
      : { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60 },
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cwEvent(
  region: string,
  group: string,
  message: string,
): Extract<TriggerEvent, { type: "aws_cloudwatch_logs" }> {
  return {
    type: "aws_cloudwatch_logs",
    region,
    log_group: group,
    log_stream: "s",
    message,
    event_id: "id1",
    timestamp: "2026-04-26T00:00:00Z",
    timestamp_ms: 0,
  };
}

describe("matchAwsCloudWatchLogs", () => {
  it("matches by region + log_group + pattern", () => {
    const rbs = [
      cwRb("a", "us-east-1", "/g", /ERROR/),
      cwRb("b", "us-east-1", "/g", /WARN/),
      cwRb("c", "us-east-1", "/h", /ERROR/),
      cwRb("d", "us-west-2", "/g", /ERROR/),
    ];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "ERROR x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("matches all events when pattern is omitted", () => {
    const rbs = [cwRb("a", "us-east-1", "/g")];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "anything"), rbs);
    expect(m).toHaveLength(1);
  });

  it("ignores file/cron runbooks", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwRb("a", "us-east-1", "/g"),
    ];
    const m = matchAwsCloudWatchLogs(cwEvent("us-east-1", "/g", "x"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });
});

function ddRb(
  id: string,
  site: string,
  monitorTags: string[] | undefined,
  transitions: DatadogMonitorState[],
): Runbook {
  const trigger: Runbook["trigger"] = {
    source: "datadog_monitors",
    site,
    transitions,
    interval_sec: 60,
  };
  if (monitorTags !== undefined) trigger.monitor_tags = monitorTags;
  return {
    id,
    trigger,
    agent: fakeAgent(),
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function ddEvent(
  site: string,
  monitorTags: string[],
  fromState: DatadogMonitorState,
  toState: DatadogMonitorState,
): Extract<TriggerEvent, { type: "datadog_monitor" }> {
  return {
    type: "datadog_monitor",
    site,
    monitor_tags: monitorTags,
    monitor_id: "1",
    monitor_name: "m1",
    from_state: fromState,
    to_state: toState,
    timestamp: "2026-05-09T12:00:00Z",
  };
}

describe("matchDatadogMonitor", () => {
  it("matches when site, sorted monitor_tags, and to_state ∈ transitions all align", () => {
    const rbs = [ddRb("a", "datadoghq.com", ["env:prod"], ["alert"])];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose site differs", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.eu", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose monitor_tags differ", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.com", ["env:staging"], ["alert"]),
      ddRb("c", "datadoghq.com", undefined, ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats monitor_tags ordering as irrelevant", () => {
    const rbs = [ddRb("a", "datadoghq.com", ["service:web", "env:prod"], ["alert"])];
    const m = matchDatadogMonitor(
      ddEvent("datadoghq.com", ["env:prod", "service:web"], "ok", "alert"),
      rbs,
    );
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("treats undefined and [] monitor_tags as the same key", () => {
    const rbs = [ddRb("a", "datadoghq.com", undefined, ["alert"])];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", [], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("filters out runbooks whose transitions list does not include to_state", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]),
      ddRb("b", "datadoghq.com", ["env:prod"], ["warn"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("returns multiple matches when several runbooks subscribe to the same key with overlapping transitions", () => {
    const rbs = [
      ddRb("a", "datadoghq.com", ["env:prod"], ["alert", "warn"]),
      ddRb("b", "datadoghq.com", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores file / cron / aws_cloudwatch_logs runbooks", () => {
    const rbs: Runbook[] = [
      fileRb("f", "/var/log/x", /./),
      cronRb("c", "* * * * *"),
      cwRb("w", "us-east-1", "/g"),
      ddRb("d", "datadoghq.com", ["env:prod"], ["alert"]),
    ];
    const m = matchDatadogMonitor(ddEvent("datadoghq.com", ["env:prod"], "ok", "alert"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["d"]);
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
