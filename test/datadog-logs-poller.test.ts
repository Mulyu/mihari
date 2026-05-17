import { describe, expect, it, vi } from "vitest";
import {
  DatadogLogsPoller,
  PAGINATION_HOP_CAP,
  computeNextState,
  decidePoll,
  uniqueDatadogLogsTriggers,
  type DatadogLogsApi,
  type RawLog,
  type SearchLogsInput,
  type SearchLogsOutput,
} from "../src/triggers/datadog-logs.js";
import type {
  DatadogLogsPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: SearchLogsOutput[],
): DatadogLogsApi & { calls: SearchLogsInput[] } {
  const calls: SearchLogsInput[] = [];
  let i = 0;
  return {
    calls,
    async searchLogs(input) {
      calls.push(input);
      const r = responses[i] ?? { logs: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: DatadogLogsPollerState | null = null): StateStore & {
  saved: DatadogLogsPollerState[];
} {
  let cur = initial;
  const saved: DatadogLogsPollerState[] = [];
  return {
    saved,
    loadDatadogLogsState: vi.fn(() => cur),
    saveDatadogLogsState: vi.fn(async (s: DatadogLogsPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: DatadogLogsPollerState[] };
}

const KEY = { site: "datadoghq.com", query: "service:checkout status:error" };

function rawLog(over: Partial<RawLog> & Pick<RawLog, "id" | "timestamp_ms">): RawLog {
  return {
    service: "checkout",
    host: "h1",
    message: "boom",
    ...over,
  };
}

describe("decidePoll", () => {
  it("seeds on first observation (no fire)", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z"))).toMatchObject({
      action: "seed",
    });
  });

  it("skips when interval has not elapsed", () => {
    const prev: DatadogLogsPollerState = {
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 1_000,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z")).action).toBe("skip");
  });

  it("polls when interval has elapsed", () => {
    const prev: DatadogLogsPollerState = {
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 1_000,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const d = decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"));
    expect(d.action).toBe("poll");
    expect(d.startTimeMs).toBe(1_000);
  });
});

describe("DatadogLogsPoller.tick", () => {
  it("first tick seeds state and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([
      { logs: [rawLog({ id: "a", timestamp_ms: 1 })] },
    ]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved[0]?.last_event_ids).toEqual([]);
  });

  it("skips API call when interval has not elapsed", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 1_000,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:30Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("emits new log events and advances cursor", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 100,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        logs: [
          rawLog({ id: "a", timestamp_ms: 200, message: "boom-a" }),
          rawLog({ id: "b", timestamp_ms: 300, message: "boom-b" }),
        ],
      },
    ]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.log_id)).toEqual(["a", "b"]);
    expect(events[0]?.timestamp).toBe(new Date(200).toISOString());
    expect(state.saved[0]?.last_event_timestamp_ms).toBe(300);
    expect(state.saved[0]?.last_event_ids).toEqual(["b"]);
  });

  it("dedups events whose id is in last_event_ids", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        logs: [
          rawLog({ id: "a", timestamp_ms: 200 }),
          rawLog({ id: "b", timestamp_ms: 200 }),
          rawLog({ id: "c", timestamp_ms: 250 }),
        ],
      },
    ]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.log_id)).toEqual(["b", "c"]);
  });

  it("paginates while cursor is returned", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { logs: [rawLog({ id: "a", timestamp_ms: 100 })], cursor: "C1" },
      { logs: [rawLog({ id: "b", timestamp_ms: 200 })] },
    ]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.cursor).toBe("C1");
    expect(events.map((e) => e.log_id)).toEqual(["a", "b"]);
  });

  it("respects PAGINATION_HOP_CAP", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const responses: SearchLogsOutput[] = [];
    for (let i = 0; i < PAGINATION_HOP_CAP + 5; i++) {
      responses.push({
        logs: [rawLog({ id: `id${i}`, timestamp_ms: 100 + i })],
        cursor: `C${i}`,
      });
    }
    const api = fakeApi(responses);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls.length).toBe(PAGINATION_HOP_CAP);
  });

  it("dryRun does not write state", async () => {
    const state = fakeState({
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ logs: [rawLog({ id: "a", timestamp_ms: 100 })] }]);
    const poller = new DatadogLogsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("computeNextState", () => {
  it("merges ids at the max timestamp when max did not advance", () => {
    const prev: DatadogLogsPollerState = {
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawLog({ id: "b", timestamp_ms: 200 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_event_timestamp_ms).toBe(200);
    expect(next.last_event_ids.sort()).toEqual(["a", "b"]);
  });

  it("replaces ids when max advanced", () => {
    const prev: DatadogLogsPollerState = {
      site: KEY.site,
      query: KEY.query,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawLog({ id: "b", timestamp_ms: 300 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_event_timestamp_ms).toBe(300);
    expect(next.last_event_ids).toEqual(["b"]);
  });
});

describe("uniqueDatadogLogsTriggers", () => {
  function rb(id: string, site: string, query: string, intervalSec: number): Runbook {
    return {
      id,
      trigger: { source: "datadog_logs", site, query, interval_sec: intervalSec },
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (site, query)", () => {
    const out = uniqueDatadogLogsTriggers([
      rb("a", "datadoghq.com", "service:x", 60),
      rb("b", "datadoghq.com", "service:x", 60),
      rb("c", "datadoghq.com", "service:y", 60),
      rb("d", "datadoghq.eu", "service:x", 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers of the same key", () => {
    const out = uniqueDatadogLogsTriggers([
      rb("a", "datadoghq.com", "q", 60),
      rb("b", "datadoghq.com", "q", 30),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-datadog_logs runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      agent: fakeAgent(),
      sourcePath: "/tmp/x.yaml",
    };
    expect(uniqueDatadogLogsTriggers([fileRb])).toEqual([]);
  });
});
