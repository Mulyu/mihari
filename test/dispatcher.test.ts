import { describe, expect, it, vi } from "vitest";
import { tick } from "../src/engine/dispatcher.js";
import type { Executor } from "../src/engine/executor.js";
import type { CronScheduler } from "../src/triggers/cron.js";
import type { FilePoller } from "../src/triggers/file.js";
import type { AwsCloudWatchLogsPoller } from "../src/triggers/aws-cloudwatch-logs.js";
import type { DatadogMonitorsPoller } from "../src/triggers/datadog-monitors.js";
import type { StateStore } from "../src/state/store.js";
import type {
  DatadogMonitorState,
  Runbook,
  RunResult,
  TriggerEvent,
} from "../src/types/index.js";

function fakeState(runs: RunResult[] = []): StateStore {
  return {
    listRuns: vi.fn().mockReturnValue(runs),
  } as unknown as StateStore;
}

function fileRb(id: string, path: string, pattern: RegExp, extra: Partial<Runbook> = {}): Runbook {
  return {
    id,
    trigger: { source: "file", path, pattern },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false }],
    sourcePath: `/tmp/${id}.yaml`,
    ...extra,
  };
}

function cronRb(id: string, schedule: string, extra: Partial<Runbook> = {}): Runbook {
  return {
    id,
    trigger: { source: "cron", schedule },
    steps: [{ id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false }],
    sourcePath: `/tmp/${id}.yaml`,
    ...extra,
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
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
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

function fakeAwsCloudWatchLogsPoller(events: TriggerEvent[]): AwsCloudWatchLogsPoller {
  return {
    key: { region: "us-east-1", logGroup: "/g" },
    intervalSec: 60,
    tick: vi.fn().mockResolvedValue(events.filter((e) => e.type === "aws_cloudwatch_logs")),
  } as unknown as AwsCloudWatchLogsPoller;
}

function cwRb(id: string, region: string, group: string, pattern?: RegExp): Runbook {
  return {
    id,
    trigger: pattern
      ? { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60, pattern }
      : { source: "aws_cloudwatch_logs", region, log_group: group, interval_sec: 60 },
    steps: [
      { id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false },
    ],
    sourcePath: `/tmp/${id}.yaml`,
  };
}

function fakeDatadogMonitorsPoller(events: TriggerEvent[]): DatadogMonitorsPoller {
  return {
    key: { site: "datadoghq.com", monitorTags: ["env:prod"] },
    intervalSec: 60,
    tick: vi.fn().mockResolvedValue(events.filter((e) => e.type === "datadog_monitor")),
  } as unknown as DatadogMonitorsPoller;
}

function ddRb(
  id: string,
  site: string,
  monitorTags: string[],
  transitions: DatadogMonitorState[],
  extra: Partial<Runbook> = {},
): Runbook {
  const trigger: Runbook["trigger"] = {
    source: "datadog_monitors",
    site,
    transitions,
    interval_sec: 60,
  };
  if (monitorTags.length > 0) trigger.monitor_tags = monitorTags;
  return {
    id,
    trigger,
    steps: [
      { id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false },
    ],
    sourcePath: `/tmp/${id}.yaml`,
    ...extra,
  };
}

function ddEvent(
  site: string,
  monitorTags: string[],
  fromState: DatadogMonitorState,
  toState: DatadogMonitorState,
): TriggerEvent {
  return {
    type: "datadog_monitor",
    site,
    monitor_tags: monitorTags,
    monitor_id: "1",
    monitor_name: "high-error-rate",
    from_state: fromState,
    to_state: toState,
    timestamp: "2026-05-09T12:00:00Z",
  };
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
      state: fakeState(),
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
      state: fakeState(),
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
      state: fakeState(),
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
      state: fakeState(),
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
        state: fakeState(),
      },
      { dryRun: true, onDryRun: (m) => seen.push(m) },
    );
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("c <- cron@t");
  });

  it("dryRun passes dryRun=true to file poller tick", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/);
    const event: TriggerEvent = {
      type: "file",
      path: "/var/log/app.log",
      content: "ERROR: bad",
      timestamp: "t",
    };
    const exec = fakeExecutor();
    const poller = fakeFilePoller([event]);
    await tick(
      { runbooks: [rb], pollers: [poller], cronSchedulers: [], executor: exec, state: fakeState() },
      { dryRun: true },
    );
    expect(poller.tick).toHaveBeenCalledWith(true);
  });

  it("dryRun passes dryRun=true to cron scheduler tick", async () => {
    const rb = cronRb("c", "* * * * *");
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    const scheduler = fakeCronScheduler(rb, event);
    await tick(
      { runbooks: [rb], pollers: [], cronSchedulers: [scheduler], executor: exec, state: fakeState() },
      { dryRun: true },
    );
    expect(scheduler.tick).toHaveBeenCalledWith(expect.any(Date), true);
  });

  it("normal tick passes dryRun=false to file poller tick", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/);
    const exec = fakeExecutor();
    const poller = fakeFilePoller([]);
    await tick({ runbooks: [rb], pollers: [poller], cronSchedulers: [], executor: exec, state: fakeState() });
    expect(poller.tick).toHaveBeenCalledWith(false);
  });
});

describe("dispatcher: aws_cloudwatch_logs", () => {
  it("passes aws_cloudwatch_logs events through matcher to executor", async () => {
    const rb = cwRb("a", "us-east-1", "/g", /ERROR/);
    const event: TriggerEvent = {
      type: "aws_cloudwatch_logs",
      region: "us-east-1",
      log_group: "/g",
      log_stream: "s",
      message: "ERROR boom",
      event_id: "e1",
      timestamp: "t",
      timestamp_ms: 0,
    };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      awsCloudWatchLogsPollers: [fakeAwsCloudWatchLogsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.runbook.id).toBe("a");
    expect(exec.calls[0]?.event).toBe(event);
  });

  it("skips aws_cloudwatch_logs events whose pattern does not match", async () => {
    const rb = cwRb("a", "us-east-1", "/g", /ERROR/);
    const event: TriggerEvent = {
      type: "aws_cloudwatch_logs",
      region: "us-east-1",
      log_group: "/g",
      log_stream: "s",
      message: "INFO ok",
      event_id: "e1",
      timestamp: "t",
      timestamp_ms: 0,
    };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      awsCloudWatchLogsPollers: [fakeAwsCloudWatchLogsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("dryRun passes dryRun=true and date to cloudwatch poller tick", async () => {
    const rb = cwRb("a", "us-east-1", "/g");
    const exec = fakeExecutor();
    const poller = fakeAwsCloudWatchLogsPoller([]);
    await tick(
      {
        runbooks: [rb],
        pollers: [],
        cronSchedulers: [],
        awsCloudWatchLogsPollers: [poller],
        executor: exec,
        state: fakeState(),
      },
      { dryRun: true },
    );
    expect(poller.tick).toHaveBeenCalledWith(expect.any(Date), true);
  });
});

describe("dispatcher: datadog_monitors", () => {
  it("passes datadog_monitor events through matcher to executor", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]);
    const event = ddEvent("datadoghq.com", ["env:prod"], "ok", "alert");
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      datadogMonitorsPollers: [fakeDatadogMonitorsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.runbook.id).toBe("a");
    expect(exec.calls[0]?.event).toBe(event);
  });

  it("skips datadog_monitor events whose to_state is not in transitions", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]);
    const event = ddEvent("datadoghq.com", ["env:prod"], "ok", "warn");
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      datadogMonitorsPollers: [fakeDatadogMonitorsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("emits a dryRun message including site / tags / monitor name / transition", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]);
    const event = ddEvent("datadoghq.com", ["env:prod"], "ok", "alert");
    const exec = fakeExecutor();
    const seen: string[] = [];
    const r = await tick(
      {
        runbooks: [rb],
        pollers: [],
        cronSchedulers: [],
        datadogMonitorsPollers: [fakeDatadogMonitorsPoller([event])],
        executor: exec,
        state: fakeState(),
      },
      { dryRun: true, onDryRun: (m) => seen.push(m) },
    );
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("a <- datadog_monitors:datadoghq.com|env:prod");
    expect(seen[0]).toContain("high-error-rate (ok -> alert)");
  });

  it("dryRun passes dryRun=true and Date to datadog poller tick", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"]);
    const exec = fakeExecutor();
    const poller = fakeDatadogMonitorsPoller([]);
    await tick(
      {
        runbooks: [rb],
        pollers: [],
        cronSchedulers: [],
        datadogMonitorsPollers: [poller],
        executor: exec,
        state: fakeState(),
      },
      { dryRun: true },
    );
    expect(poller.tick).toHaveBeenCalledWith(expect.any(Date), true);
  });
});

describe("dispatcher: enabled", () => {
  it("skips file runbook when enabled=false", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/, { enabled: false });
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
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("skips cron runbook when enabled=false", async () => {
    const rb = cronRb("c", "* * * * *", { enabled: false });
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("skips aws_cloudwatch_logs runbook when enabled=false", async () => {
    const rb: Runbook = { ...cwRb("a", "us-east-1", "/g", /ERROR/), enabled: false };
    const event: TriggerEvent = {
      type: "aws_cloudwatch_logs",
      region: "us-east-1",
      log_group: "/g",
      log_stream: "s",
      message: "ERROR boom",
      event_id: "e1",
      timestamp: "t",
      timestamp_ms: 0,
    };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      awsCloudWatchLogsPollers: [fakeAwsCloudWatchLogsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("skips datadog_monitors runbook when enabled=false", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"], { enabled: false });
    const event = ddEvent("datadoghq.com", ["env:prod"], "ok", "alert");
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      datadogMonitorsPollers: [fakeDatadogMonitorsPoller([event])],
      executor: exec,
      state: fakeState(),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });
});

describe("dispatcher: cooldown_sec", () => {
  it("skips execution when within cooldown window", async () => {
    const rb = cronRb("c", "* * * * *", { cooldown_sec: 300 });
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    // last run was 10 seconds ago — within 300s cooldown
    const recentRun: RunResult = {
      run_id: "run_x",
      runbook_id: "c",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      finished_at: new Date(Date.now() - 9_000).toISOString(),
      ok: true,
      steps: [],
      trigger_event: event,
    };
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
      state: fakeState([recentRun]),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("fires when cooldown window has elapsed", async () => {
    const rb = cronRb("c", "* * * * *", { cooldown_sec: 300 });
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    // last run was 400 seconds ago — cooldown has elapsed
    const oldRun: RunResult = {
      run_id: "run_x",
      runbook_id: "c",
      started_at: new Date(Date.now() - 400_000).toISOString(),
      finished_at: new Date(Date.now() - 399_000).toISOString(),
      ok: true,
      steps: [],
      trigger_event: event,
    };
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
      state: fakeState([oldRun]),
    });
    expect(r.fired).toBe(1);
    expect(exec.calls).toHaveLength(1);
  });

  it("fires when there is no previous run (first time)", async () => {
    const rb = cronRb("c", "* * * * *", { cooldown_sec: 300 });
    const event: TriggerEvent = { type: "cron", timestamp: "t" };
    const exec = fakeExecutor();
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [fakeCronScheduler(rb, event)],
      executor: exec,
      state: fakeState([]),  // no previous runs
    });
    expect(r.fired).toBe(1);
  });

  it("applies cooldown_sec to file events as well", async () => {
    const rb = fileRb("a", "/var/log/app.log", /ERROR/, { cooldown_sec: 300 });
    const event: TriggerEvent = {
      type: "file",
      path: "/var/log/app.log",
      content: "ERROR: bad",
      timestamp: "t",
    };
    const exec = fakeExecutor();
    const recentRun: RunResult = {
      run_id: "run_x",
      runbook_id: "a",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      finished_at: new Date(Date.now() - 9_000).toISOString(),
      ok: true,
      steps: [],
      trigger_event: event,
    };
    const r = await tick({
      runbooks: [rb],
      pollers: [fakeFilePoller([event])],
      cronSchedulers: [],
      executor: exec,
      state: fakeState([recentRun]),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("applies cooldown_sec to aws_cloudwatch_logs events as well", async () => {
    const rb: Runbook = { ...cwRb("a", "us-east-1", "/g"), cooldown_sec: 300 };
    const event: TriggerEvent = {
      type: "aws_cloudwatch_logs",
      region: "us-east-1",
      log_group: "/g",
      log_stream: "s",
      message: "ERROR boom",
      event_id: "e1",
      timestamp: "t",
      timestamp_ms: 0,
    };
    const exec = fakeExecutor();
    const recentRun: RunResult = {
      run_id: "run_x",
      runbook_id: "a",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      finished_at: new Date(Date.now() - 9_000).toISOString(),
      ok: true,
      steps: [],
      trigger_event: event,
    };
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      awsCloudWatchLogsPollers: [fakeAwsCloudWatchLogsPoller([event])],
      executor: exec,
      state: fakeState([recentRun]),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });

  it("applies cooldown_sec to datadog_monitor events as well", async () => {
    const rb = ddRb("a", "datadoghq.com", ["env:prod"], ["alert"], { cooldown_sec: 300 });
    const event = ddEvent("datadoghq.com", ["env:prod"], "ok", "alert");
    const exec = fakeExecutor();
    const recentRun: RunResult = {
      run_id: "run_x",
      runbook_id: "a",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      finished_at: new Date(Date.now() - 9_000).toISOString(),
      ok: true,
      steps: [],
      trigger_event: event,
    };
    const r = await tick({
      runbooks: [rb],
      pollers: [],
      cronSchedulers: [],
      datadogMonitorsPollers: [fakeDatadogMonitorsPoller([event])],
      executor: exec,
      state: fakeState([recentRun]),
    });
    expect(r.fired).toBe(0);
    expect(exec.calls).toHaveLength(0);
  });
});
