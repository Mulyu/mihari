import { describe, expect, it } from "vitest";
import { match, uniqueTriggerPaths } from "../src/engine/matcher.js";
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
