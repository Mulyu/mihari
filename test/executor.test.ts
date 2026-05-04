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
  capture: false,
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

  it("stops on first failure when on_error=stop, records skipped for subsequent steps", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "a", bash: "exit 1", on_error: "stop" }),
        step({ id: "b", bash: "true" }),
      ]),
      event,
    );
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.stepId).toBe("a");
    expect(r.steps[0]?.skipped).toBe(false);
    expect(r.steps[1]?.stepId).toBe("b");
    expect(r.steps[1]?.skipped).toBe(true);
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

  it("passes captured stdout from one step to the next via {{ steps.<id>.output }}", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "producer", bash: "echo hello", capture: true }),
        step({
          id: "consumer",
          bash: 'echo "got={{ steps.producer.output }}"',
          capture: true,
        }),
      ]),
      event,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[0]?.captured).toBe("hello");
    expect(r.steps[1]?.stdout.trim()).toBe("got=hello");
    expect(r.steps[1]?.captured).toBe("got=hello");
  });

  it("does not propagate capture to later steps when capture is false", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "producer", bash: "echo silent", capture: false }),
        step({
          id: "consumer",
          bash: 'echo "got=[{{ steps.producer.output }}]"',
        }),
      ]),
      event,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[1]?.stdout.trim()).toBe("got=[]");
  });

  it("preserves embedded newlines in captured output across steps", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "producer", bash: "printf 'a\\nb'", capture: true }),
        step({
          id: "consumer",
          bash: 'echo "{{ steps.producer.output }}" | wc -l',
        }),
      ]),
      event,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[1]?.stdout.trim()).toBe("2");
  });
});

describe("Executor: condition", () => {
  it("condition: on_failure runs only when a previous step failed", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "main", bash: "exit 1", on_error: "continue" }),
        step({ id: "notify", bash: "echo notified", condition: "on_failure" }),
      ]),
      event,
    );
    expect(r.ok).toBe(false);
    expect(r.steps[1]?.skipped).toBe(false);
    expect(r.steps[1]?.stdout.trim()).toBe("notified");
  });

  it("condition: on_failure is skipped when all previous steps succeed", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "main", bash: "true" }),
        step({ id: "notify", bash: "echo notified", condition: "on_failure" }),
      ]),
      event,
    );
    expect(r.ok).toBe(true);
    expect(r.steps[1]?.skipped).toBe(true);
  });

  it("condition: on_failure runs after on_error:stop failure", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "main", bash: "exit 1", on_error: "stop" }),
        step({ id: "notify", bash: "echo notified", condition: "on_failure" }),
      ]),
      event,
    );
    expect(r.ok).toBe(false);
    expect(r.steps[1]?.skipped).toBe(false);
    expect(r.steps[1]?.stdout.trim()).toBe("notified");
  });

  it("condition: always runs even after on_error:stop failure", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "a", bash: "exit 1", on_error: "stop" }),
        step({ id: "b", bash: "true", condition: "always" }),
        step({ id: "c", bash: "true" }),
      ]),
      event,
    );
    expect(r.steps[1]?.skipped).toBe(false);
    expect(r.steps[1]?.ok).toBe(true);
    expect(r.steps[2]?.skipped).toBe(true);
  });

  it("condition: on_success skips when any previous step failed", async () => {
    const executor = createExecutor(new StateStore({ baseDir: dir }));
    const r = await executor.execute(
      rb([
        step({ id: "a", bash: "exit 1", on_error: "continue" }),
        step({ id: "b", bash: "true", condition: "on_success" }),
      ]),
      event,
    );
    expect(r.steps[1]?.skipped).toBe(true);
  });
});
