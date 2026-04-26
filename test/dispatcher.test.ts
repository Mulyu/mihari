import { describe, expect, it, vi } from "vitest";
import { tick } from "../src/core/dispatcher.js";
import type { Executor } from "../src/core/executor.js";
import type { CronScheduler } from "../src/pollers/cron.js";
import type { FilePoller } from "../src/pollers/file.js";
import type { Runbook, RunResult, TriggerEvent } from "../src/types.js";

function fileRb(id: string, path: string, pattern: RegExp): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {} }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function cronRb(id: string, schedule: string): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {} }],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function fakeExecutor(ok = true): Executor & {
  calls: Array<{ runbook: Runbook; event: TriggerEvent }>;
} {
  const calls: Array<{ runbook: Runbook; event: TriggerEvent }> = [];
  return {
    calls,
    async execute(runbook, event) {
      calls.push({ runbook, event });
      const r: RunResult = {
        run_id: "run_xxxxxxxx",
        runbook_id: runbook.id,
        started_at: "0",
        finished_at: "0",
        ok,
        steps: [],
        trigger_event: event,
      };
      return r;
    },
  };
}

function fakeFilePoller(events: TriggerEvent[]): FilePoller {
  return {
    path: "/tmp/x.log",
    tick: vi.fn().mockResolvedValue(events.filter((e) => e.type === "file")),
  } as unknown as FilePoller;
}

function fakeCronScheduler(runbook: Runbook, event: TriggerEvent | null): CronScheduler {
  return {
    runbook,
    tick: vi.fn().mockResolvedValue(event),
  } as unknown as CronScheduler;
}

describe("dispatcher tick", () => {
  it("passes file events through matcher to executor", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/);
    const event: TriggerEvent = {
      type: "file",
      path: "/var/log/app.log",
      content: "ERROR: bad",
      timestamp: "t",
    };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [fakeFilePoller([event])],
      cronSchedulers: [],
      executor: exec,
    });
    expect(r.ok).toBe(true);
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.runbook.id).toBe("a");
    expect(exec.calls[0]?.event).toBe(event);
  });

  it("skips file events that do not match", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/);
    const event: TriggerEvent = {
      type: "file",
      path: "/var/log/app.log",
      content: "INFO: ok",
      timestamp: "t",
    };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [fakeFilePoller([event])],
      cronSchedulers: [],
      executor: exec,
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("delivers cron events directly to executor (bypassing matcher)", async () => {
    const rb = cronRb("c", "* * * * *");
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
    });
    expect(r.ok).toBe(true);
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.event).toBe(event);
  });

  it("aggregates ok=false when any runbook fails", async () => {
    const rb = cronRb("c", "* * * * *");
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor(false);
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
    });
    expect(r.ok).toBe(false);
  });

  it("dryRun does not call executor and emits onDryRun messages", async () => {
    const rb = cronRb("c", "* * * * *");
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    const seen: string[] = [];
    const r = await tick(
      {
        runbooks: [rb],
        pollers: [],
        cronSchedulers: [fakeCronScheduler(rb, event)],
        executor: exec,
      },
      { dryRun: true, onDryRun: (m) => seen.push(m) },
    );
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("c <- cron@t");
  });
});
