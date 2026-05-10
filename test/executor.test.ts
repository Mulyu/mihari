import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Runbook, TriggerEvent } from "../src/types/index.js";
import { fakeAgent } from "./_fixtures.js";

const mockRunAgent = vi.fn();
vi.mock("../src/agent/runner.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

const { createExecutor } = await import("../src/engine/executor.js");
const { StateStore } = await import("../src/state/store.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-exec-"));
  mockRunAgent.mockReset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const event: TriggerEvent = {
  type: "manual",
  timestamp: "2026-04-26T00:00:00Z",
};

function rb(id = "test-rb"): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule: "* * * * *" },
    agent: fakeAgent(),
    sourcePath: "/tmp/test.yaml",
  };
}

describe("Executor", () => {
  it("returns ok=true when the agent succeeds", async () => {
    mockRunAgent.mockResolvedValueOnce({
      ok: true,
      exit_code: 0,
      stdout: "done",
      duration_ms: 5,
      timed_out: false,
      error: null,
    });
    const exec = createExecutor(new StateStore({ baseDir: dir }));
    const r = await exec.execute(rb(), event);
    expect(r.ok).toBe(true);
    expect(r.agent.stdout).toBe("done");
    expect(r.run_id).toMatch(/^run_[0-9a-f]{8}$/);
  });

  it("returns ok=false and propagates the agent failure into RunResult", async () => {
    mockRunAgent.mockResolvedValueOnce({
      ok: false,
      exit_code: 1,
      stdout: "",
      duration_ms: 5,
      timed_out: false,
      error: "agent error_max_turns: num_turns=30",
    });
    const exec = createExecutor(new StateStore({ baseDir: dir }));
    const r = await exec.execute(rb(), event);
    expect(r.ok).toBe(false);
    expect(r.agent.error).toContain("error_max_turns");
  });

  it("forwards trigger event into agent context and run result", async () => {
    mockRunAgent.mockResolvedValueOnce({
      ok: true,
      exit_code: 0,
      stdout: "",
      duration_ms: 1,
      timed_out: false,
      error: null,
    });
    const exec = createExecutor(new StateStore({ baseDir: dir }));
    const r = await exec.execute(rb(), event);
    expect(r.trigger_event.type).toBe("manual");
    const agentCall = mockRunAgent.mock.calls[0];
    expect(agentCall?.[1]).toMatchObject({
      event,
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });
});
