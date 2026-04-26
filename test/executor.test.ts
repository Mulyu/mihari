import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutor } from "../src/core/executor.js";
import { StateStore } from "../src/core/state.js";
import type { BashStep, Runbook, TriggerEvent } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-exec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const event: TriggerEvent = {
  type: "manual",
  timestamp: "2026-04-26T00:00:00Z",
};

const step = (over: Partial<BashStep> = {}): BashStep => ({
  id: "s",
  bash: "true",
  timeout_sec: 5,
  on_error: "stop",
  env: {},
  ...over,
});

function rb(steps: BashStep[]): Runbook {
  return {
    id: "test-rb",
    trigger: { source: "cron", schedule: "* * * * *" },
    steps,
    sourcePath: "/tmp/test.yaml",
  };
}

describe("Executor", () => {
  it("runs all steps when each succeeds", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([step({ id: "a", bash: "true" }), step({ id: "b", bash: "true" })]),
      event,
    );
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(2);
  });

  it("stops on first failure when on_error=stop", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "a", bash: "exit 1", on_error: "stop" }),
        step({ id: "b", bash: "true" }),
      ]),
      event,
    );
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.stepId).toBe("a");
  });

  it("continues past failures when on_error=continue", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "a", bash: "exit 1", on_error: "continue" }),
        step({ id: "b", bash: "true" }),
      ]),
      event,
    );
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.ok).toBe(false);
    expect(r.steps[1]?.ok).toBe(true);
  });

  it("records the trigger event in the run result", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(rb([step()]), event);
    expect(r.trigger_event.type).toBe("manual");
    expect(r.trigger_event.timestamp).toBe(event.timestamp);
  });

  it("emits a run_id with the run_ prefix", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(rb([step()]), event);
    expect(r.run_id).toMatch(/^run_[0-9a-f]{8}$/);
  });
});
