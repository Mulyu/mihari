import { describe, expect, it } from "vitest";
import { match, uniqueTriggerPaths } from "../src/core/matcher.js";
import type { LogLine, Runbook } from "../src/types.js";

function rb(id: string, path: string, pattern: RegExp): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {} }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function line(path: string, content: string): LogLine {
  return { path, content, timestamp: "2026-04-26T00:00:00Z" };
}

describe("match", () => {
  it("returns runbooks whose trigger.path and pattern match", () => {
    const rbs = [
      rb("a", "/var/log/app.log", /ERROR/),
      rb("b", "/var/log/app.log", /WARN/),
      rb("c", "/var/log/other.log", /ERROR/),
    ];
    const m = match(line("/var/log/app.log", "ERROR: foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a"]);
  });

  it("returns multiple matches when several runbooks apply", () => {
    const rbs = [
      rb("a", "/var/log/app.log", /ERROR/),
      rb("b", "/var/log/app.log", /foo/),
    ];
    const m = match(line("/var/log/app.log", "ERROR foo"), rbs);
    expect(m.map((x) => x.runbook.id)).toEqual(["a", "b"]);
  });

  it("normalizes paths", () => {
    const rbs = [rb("a", "/var/log/app.log", /x/)];
    const m = match(line("/var/log/./app.log", "x"), rbs);
    expect(m).toHaveLength(1);
  });
});

describe("uniqueTriggerPaths", () => {
  it("deduplicates and resolves", () => {
    const rbs = [
      rb("a", "/var/log/app.log", /x/),
      rb("b", "/var/log/./app.log", /y/),
      rb("c", "/var/log/other.log", /z/),
    ];
    expect(uniqueTriggerPaths(rbs).sort()).toEqual([
      "/var/log/app.log",
      "/var/log/other.log",
    ]);
  });
});
