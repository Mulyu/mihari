import { describe, expect, it, vi } from "vitest";
import {
  DatadogMonitorsPoller,
  decidePoll,
  normalizeOverallState,
  uniqueDatadogMonitorsTriggers,
  type DatadogMonitorsApi,
  type ListMonitorsInput,
  type ListMonitorsOutput,
} from "../src/triggers/datadog-monitors.js";
import type {
  DatadogMonitorsPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: ListMonitorsOutput[],
): DatadogMonitorsApi & { calls: ListMonitorsInput[] } {
  const calls: ListMonitorsInput[] = [];
  let i = 0;
  return {
    calls,
    async listMonitors(input) {
      calls.push(input);
      const r = responses[i] ?? { monitors: [], hasMore: false };
      i++;
      return r;
    },
  };
}

function fakeState(initial: DatadogMonitorsPollerState | null = null): StateStore & {
  saved: DatadogMonitorsPollerState[];
} {
  let cur = initial;
  const saved: DatadogMonitorsPollerState[] = [];
  return {
    saved,
    loadDatadogMonitorsState: vi.fn(() => cur),
    saveDatadogMonitorsState: vi.fn(async (s: DatadogMonitorsPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: DatadogMonitorsPollerState[] };
}

const KEY = { site: "datadoghq.com", monitorTags: ["env:prod"] };

describe("decidePoll", () => {
  it("seeds on first observation (no fire)", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z"))).toEqual({ action: "seed" });
  });

  it("skips when interval has not elapsed", () => {
    const prev: DatadogMonitorsPollerState = {
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z"))).toEqual({ action: "skip" });
  });

  it("polls when interval has elapsed", () => {
    const prev: DatadogMonitorsPollerState = {
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"))).toEqual({ action: "poll" });
  });
});

describe("normalizeOverallState", () => {
  it("maps Datadog literals to lower-case mihari literals", () => {
    expect(normalizeOverallState("Alert")).toBe("alert");
    expect(normalizeOverallState("Warn")).toBe("warn");
    expect(normalizeOverallState("No Data")).toBe("no_data");
    expect(normalizeOverallState("OK")).toBe("ok");
    expect(normalizeOverallState("Skipped")).toBe("skipped");
    expect(normalizeOverallState("Ignored")).toBe("ignored");
    expect(normalizeOverallState("Unknown")).toBe("unknown");
  });

  it("falls back to 'unknown' for unexpected input", () => {
    expect(normalizeOverallState(undefined)).toBe("unknown");
    expect(normalizeOverallState(42)).toBe("unknown");
    expect(normalizeOverallState("Bogus")).toBe("unknown");
  });
});

describe("DatadogMonitorsPoller.tick", () => {
  it("first tick seeds state and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([
      {
        monitors: [
          { id: "1", name: "m1", overall_state: "ok" },
          { id: "2", name: "m2", overall_state: "alert" },
        ],
        hasMore: false,
      },
    ]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(1);
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]?.monitor_states).toEqual({ "1": "ok", "2": "alert" });
  });

  it("skips API call when interval has not elapsed", async () => {
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:30Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved).toHaveLength(0);
  });

  it("emits a transition event when overall_state changes", async () => {
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok", "2": "alert" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        monitors: [
          { id: "1", name: "high-error-rate", overall_state: "alert" },
          { id: "2", name: "p99-latency", overall_state: "alert" },
        ],
        hasMore: false,
      },
    ]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "datadog_monitor",
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_id: "1",
      monitor_name: "high-error-rate",
      from_state: "ok",
      to_state: "alert",
    });
    expect(state.saved[0]?.monitor_states).toEqual({ "1": "alert", "2": "alert" });
  });

  it("does not emit for monitors observed for the first time after seed", async () => {
    // 1: 既知 ok のまま、2: 新規追加（seed 以降に作られた monitor）
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        monitors: [
          { id: "1", name: "m1", overall_state: "ok" },
          { id: "2", name: "m2", overall_state: "alert" },
        ],
        hasMore: false,
      },
    ]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toEqual([]);
    expect(state.saved[0]?.monitor_states).toEqual({ "1": "ok", "2": "alert" });
  });

  it("paginates while hasMore is true", async () => {
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: [],
      monitor_states: { a: "ok", b: "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { monitors: [{ id: "a", name: "a", overall_state: "alert" }], hasMore: true },
      { monitors: [{ id: "b", name: "b", overall_state: "warn" }], hasMore: false },
    ]);
    const poller = new DatadogMonitorsPoller(
      { site: "datadoghq.com", monitorTags: [] },
      60,
      state,
      api,
    );
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.page).toBe(0);
    expect(api.calls[1]?.page).toBe(1);
    expect(events.map((e) => e.monitor_id).sort()).toEqual(["a", "b"]);
  });

  it("dryRun does not write state", async () => {
    const state = fakeState(null);
    const api = fakeApi([{ monitors: [], hasMore: false }]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:00:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });

  it("merges prev state with newly fetched monitors instead of overwriting", async () => {
    // 既知 monitor が今回 tick で fetch されなかった場合に drop されないこと（fail-open
    // 寄りで欠落より残す側に倒す）。
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: ["env:prod"],
      monitor_states: { "1": "ok", "2": "ok" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        monitors: [{ id: "1", name: "m1", overall_state: "alert" }],
        hasMore: false,
      },
    ]);
    const poller = new DatadogMonitorsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.monitor_id)).toEqual(["1"]);
    expect(state.saved[0]?.monitor_states).toEqual({ "1": "alert", "2": "ok" });
  });

  it("passes monitorTags to API as comma-separated string", async () => {
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: ["env:prod", "service:web"],
      monitor_states: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ monitors: [], hasMore: false }]);
    const poller = new DatadogMonitorsPoller(
      { site: "datadoghq.com", monitorTags: ["env:prod", "service:web"] },
      60,
      state,
      api,
    );
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls[0]?.monitorTags).toBe("env:prod,service:web");
  });

  it("omits monitorTags param when no tags configured", async () => {
    const state = fakeState({
      site: "datadoghq.com",
      monitor_tags: [],
      monitor_states: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ monitors: [], hasMore: false }]);
    const poller = new DatadogMonitorsPoller(
      { site: "datadoghq.com", monitorTags: [] },
      60,
      state,
      api,
    );
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls[0]?.monitorTags).toBeUndefined();
  });
});

describe("uniqueDatadogMonitorsTriggers", () => {
  function rb(
    id: string,
    site: string,
    tags: string[],
    intervalSec: number,
  ): Runbook {
    const trigger: Runbook["trigger"] = {
      source: "datadog_monitors",
      site,
      transitions: ["alert"],
      interval_sec: intervalSec,
    };
    if (tags.length > 0) trigger.monitor_tags = tags;
    return {
      id,
      trigger,
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (site, sorted monitor_tags)", () => {
    const out = uniqueDatadogMonitorsTriggers([
      rb("a", "datadoghq.com", ["env:prod"], 60),
      rb("b", "datadoghq.com", ["env:prod"], 60),
      rb("c", "datadoghq.com", ["env:staging"], 60),
      rb("d", "datadoghq.eu", ["env:prod"], 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("treats tag order as irrelevant", () => {
    const out = uniqueDatadogMonitorsTriggers([
      rb("a", "datadoghq.com", ["env:prod", "service:web"], 60),
      rb("b", "datadoghq.com", ["service:web", "env:prod"], 60),
    ]);
    expect(out).toHaveLength(1);
  });

  it("takes min interval_sec across subscribers of the same key", () => {
    const out = uniqueDatadogMonitorsTriggers([
      rb("a", "datadoghq.com", ["env:prod"], 60),
      rb("b", "datadoghq.com", ["env:prod"], 30),
      rb("c", "datadoghq.com", ["env:prod"], 120),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-datadog_monitors runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      agent: fakeAgent(),
      sourcePath: "/tmp/x.yaml",
    };
    expect(uniqueDatadogMonitorsTriggers([fileRb])).toEqual([]);
  });
});
