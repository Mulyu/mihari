import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";
import type { PollerState, RunResult } from "../src/types/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore poller state", () => {
  it("returns null for never-seen file", () => {
    const s = new StateStore({ baseDir: dir });
    expect(s.loadPollerState("/var/log/x.log")).toBeNull();
  });

  it("round-trips poller state", async () => {
    const s = new StateStore({ baseDir: dir });
    const state: PollerState = {
      path: "/var/log/x.log",
      inode: 42,
      size: 1234,
      offset: 1000,
      updated_at: "2026-04-26T00:00:00Z",
    };
    await s.savePollerState(state);
    const loaded = s.loadPollerState("/var/log/x.log");
    expect(loaded).toEqual(state);
  });

  it("uses path-derived filenames so different paths don't collide", async () => {
    const s = new StateStore({ baseDir: dir });
    const fa = s.pollerStateFile("/var/log/a.log");
    const fb = s.pollerStateFile("/var/log/b.log");
    expect(fa).not.toBe(fb);
  });
});

function makeRun(id: string, runbookId: string, startedAt: string, ok = true): RunResult {
  return {
    run_id: id,
    runbook_id: runbookId,
    started_at: startedAt,
    finished_at: startedAt,
    ok,
    agent: {
      ok,
      exit_code: ok ? 0 : 1,
      stdout: "",
      duration_ms: 1,
      timed_out: false,
      error: null,
    },
    trigger_event: { type: "manual", timestamp: startedAt },
  };
}

describe("StateStore run results", () => {
  it("appends run results into per-day jsonl", async () => {
    const s = new StateStore({ baseDir: dir });
    await s.appendRunResult(makeRun("run_test", "rb", "2026-04-26T00:00:00Z"));
    expect(s.baseDir).toBe(dir);
  });

  it("listRuns returns empty when no records exist", () => {
    const s = new StateStore({ baseDir: dir });
    expect(s.listRuns()).toEqual([]);
  });

  it("listRuns returns most recent first across days", async () => {
    const s = new StateStore({ baseDir: dir });
    await s.appendRunResult(makeRun("run_a", "rb1", "2026-04-25T10:00:00Z"));
    await s.appendRunResult(makeRun("run_b", "rb1", "2026-04-26T08:00:00Z"));
    await s.appendRunResult(makeRun("run_c", "rb2", "2026-04-26T09:00:00Z"));
    const got = s.listRuns();
    expect(got.map((r) => r.run_id)).toEqual(["run_c", "run_b", "run_a"]);
  });

  it("listRuns honors --runbook filter", async () => {
    const s = new StateStore({ baseDir: dir });
    await s.appendRunResult(makeRun("run_a", "rb1", "2026-04-25T10:00:00Z"));
    await s.appendRunResult(makeRun("run_b", "rb2", "2026-04-26T10:00:00Z"));
    expect(s.listRuns({ runbookId: "rb1" }).map((r) => r.run_id)).toEqual(["run_a"]);
  });

  it("listRuns honors --since filter", async () => {
    const s = new StateStore({ baseDir: dir });
    await s.appendRunResult(makeRun("run_a", "rb", "2026-04-25T10:00:00Z"));
    await s.appendRunResult(makeRun("run_b", "rb", "2026-04-26T10:00:00Z"));
    expect(s.listRuns({ since: "2026-04-26" }).map((r) => r.run_id)).toEqual(["run_b"]);
  });

  it("listRuns honors --limit", async () => {
    const s = new StateStore({ baseDir: dir });
    for (let i = 0; i < 5; i++) {
      await s.appendRunResult(makeRun(`run_${i}`, "rb", `2026-04-26T0${i}:00:00Z`));
    }
    expect(s.listRuns({ limit: 2 })).toHaveLength(2);
  });

  it("getRun finds the run regardless of date dir", async () => {
    const s = new StateStore({ baseDir: dir });
    await s.appendRunResult(makeRun("run_target", "rb", "2026-04-20T10:00:00Z"));
    await s.appendRunResult(makeRun("run_other", "rb", "2026-04-26T10:00:00Z"));
    const got = s.getRun("run_target");
    expect(got?.run_id).toBe("run_target");
  });

  it("skips pre-1.0 run records (steps[] without agent) instead of crashing", async () => {
    const s = new StateStore({ baseDir: dir });
    const date = "2026-04-26";
    const dayDir = join(dir, "runs", date);
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "run_legacy.jsonl"),
      JSON.stringify({
        run_id: "run_legacy",
        runbook_id: "rb",
        started_at: `${date}T00:00:00Z`,
        finished_at: `${date}T00:00:01Z`,
        ok: true,
        steps: [{ stepId: "x", ok: true }],
        trigger_event: { type: "manual", timestamp: `${date}T00:00:00Z` },
      }) + "\n",
    );
    await s.appendRunResult(makeRun("run_new", "rb", `${date}T01:00:00Z`));
    expect(s.listRuns().map((r) => r.run_id)).toEqual(["run_new"]);
    expect(s.getRun("run_legacy")).toBeNull();
  });

  it("getRun returns null for unknown ids", () => {
    const s = new StateStore({ baseDir: dir });
    expect(s.getRun("nope")).toBeNull();
  });
});
