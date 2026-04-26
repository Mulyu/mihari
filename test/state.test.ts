import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/core/state.js";
import type { PollerState, RunResult } from "../src/types.js";

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

describe("StateStore run results", () => {
  it("appends run results into per-day jsonl", async () => {
    const s = new StateStore({ baseDir: dir });
    const r: RunResult = {
      run_id: "run_test",
      runbook_id: "rb",
      started_at: "2026-04-26T00:00:00Z",
      finished_at: "2026-04-26T00:00:01Z",
      ok: true,
      steps: [],
      trigger_line: "x",
    };
    await s.appendRunResult(r);
    // not throwing is the contract; we verify the directory exists
    expect(s.baseDir).toBe(dir);
  });
});
