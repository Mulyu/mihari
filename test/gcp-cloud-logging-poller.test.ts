import { describe, expect, it, vi } from "vitest";
import {
  GcpCloudLoggingPoller,
  PAGINATION_HOP_CAP,
  computeNextState,
  decidePoll,
  parseGcpTimestamp,
  uniqueGcpCloudLoggingTriggers,
  type GcpCloudLoggingApi,
  type GetEntriesInput,
  type GetEntriesOutput,
  type RawLogEntry,
} from "../src/triggers/gcp-cloud-logging.js";
import type {
  GcpCloudLoggingPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: GetEntriesOutput[],
): GcpCloudLoggingApi & { calls: GetEntriesInput[] } {
  const calls: GetEntriesInput[] = [];
  let i = 0;
  return {
    calls,
    async getEntries(input) {
      calls.push(input);
      const r = responses[i] ?? { entries: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: GcpCloudLoggingPollerState | null = null): StateStore & {
  saved: GcpCloudLoggingPollerState[];
} {
  let cur = initial;
  const saved: GcpCloudLoggingPollerState[] = [];
  return {
    saved,
    loadGcpCloudLoggingState: vi.fn(() => cur),
    saveGcpCloudLoggingState: vi.fn(async (s: GcpCloudLoggingPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: GcpCloudLoggingPollerState[] };
}

const KEY = { projectId: "my-project", filter: "severity>=ERROR" };

function rawEntry(
  over: Partial<RawLogEntry> & Pick<RawLogEntry, "insert_id" | "timestamp_ms">,
): RawLogEntry {
  return {
    log_name: "projects/my-project/logs/cloudfunctions.googleapis.com%2Fcloud-functions",
    severity: "ERROR",
    resource_type: "cloud_function",
    message: "boom",
    ...over,
  };
}

describe("parseGcpTimestamp", () => {
  it("parses ISO strings", () => {
    expect(parseGcpTimestamp("2026-05-09T12:00:00.000Z")).toBe(
      Date.parse("2026-05-09T12:00:00.000Z"),
    );
  });
  it("parses { seconds, nanos } protobuf shape", () => {
    expect(parseGcpTimestamp({ seconds: 1, nanos: 500_000_000 })).toBe(1500);
    expect(parseGcpTimestamp({ seconds: "100", nanos: 0 })).toBe(100_000);
  });
  it("returns 0 for unparseable", () => {
    expect(parseGcpTimestamp(undefined)).toBe(0);
    expect(parseGcpTimestamp({ nanos: 1 })).toBe(0);
  });
});

describe("decidePoll", () => {
  it("seeds on first observation", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z")).action).toBe("seed");
  });

  it("skips when interval has not elapsed", () => {
    const prev: GcpCloudLoggingPollerState = {
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 1_000,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z")).action).toBe("skip");
  });

  it("polls when interval has elapsed", () => {
    const prev: GcpCloudLoggingPollerState = {
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 1_000,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const d = decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"));
    expect(d.action).toBe("poll");
    expect(d.fromMs).toBe(1_000);
  });
});

describe("GcpCloudLoggingPoller.tick", () => {
  it("first tick seeds state and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([]);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved[0]?.last_event_timestamp_ms).toBe(
      Date.parse("2026-05-09T12:00:00Z"),
    );
  });

  it("emits entries newer than cursor and advances it", async () => {
    const state = fakeState({
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 100,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        entries: [
          rawEntry({ insert_id: "a", timestamp_ms: 200 }),
          rawEntry({ insert_id: "b", timestamp_ms: 300 }),
        ],
      },
    ]);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.log_id)).toEqual(["a", "b"]);
    expect(state.saved[0]?.last_event_timestamp_ms).toBe(300);
    expect(state.saved[0]?.last_event_ids).toEqual(["b"]);
  });

  it("dedups entries whose insert_id is in last_event_ids", async () => {
    const state = fakeState({
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        entries: [
          rawEntry({ insert_id: "a", timestamp_ms: 200 }),
          rawEntry({ insert_id: "b", timestamp_ms: 200 }),
          rawEntry({ insert_id: "c", timestamp_ms: 250 }),
        ],
      },
    ]);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.log_id)).toEqual(["b", "c"]);
  });

  it("paginates while pageToken is returned", async () => {
    const state = fakeState({
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { entries: [rawEntry({ insert_id: "a", timestamp_ms: 100 })], pageToken: "T1" },
      { entries: [rawEntry({ insert_id: "b", timestamp_ms: 200 })] },
    ]);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.pageToken).toBe("T1");
    expect(events.map((e) => e.log_id)).toEqual(["a", "b"]);
  });

  it("respects PAGINATION_HOP_CAP", async () => {
    const state = fakeState({
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const responses: GetEntriesOutput[] = [];
    for (let i = 0; i < PAGINATION_HOP_CAP + 5; i++) {
      responses.push({
        entries: [rawEntry({ insert_id: `id${i}`, timestamp_ms: 100 + i })],
        pageToken: `T${i}`,
      });
    }
    const api = fakeApi(responses);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls.length).toBe(PAGINATION_HOP_CAP);
  });

  it("dryRun does not write state", async () => {
    const state = fakeState({
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ entries: [rawEntry({ insert_id: "a", timestamp_ms: 100 })] }]);
    const poller = new GcpCloudLoggingPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("computeNextState", () => {
  it("merges boundary ids when max did not advance", () => {
    const prev: GcpCloudLoggingPollerState = {
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawEntry({ insert_id: "b", timestamp_ms: 200 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_event_timestamp_ms).toBe(200);
    expect(next.last_event_ids.sort()).toEqual(["a", "b"]);
  });

  it("replaces boundary ids when max advanced", () => {
    const prev: GcpCloudLoggingPollerState = {
      project_id: KEY.projectId,
      filter: KEY.filter,
      last_event_timestamp_ms: 200,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawEntry({ insert_id: "b", timestamp_ms: 300 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_event_timestamp_ms).toBe(300);
    expect(next.last_event_ids).toEqual(["b"]);
  });
});

describe("uniqueGcpCloudLoggingTriggers", () => {
  function rb(id: string, projectId: string, filter: string, intervalSec: number): Runbook {
    return {
      id,
      trigger: {
        source: "gcp_cloud_logging",
        project_id: projectId,
        filter,
        interval_sec: intervalSec,
      },
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (project_id, filter)", () => {
    const out = uniqueGcpCloudLoggingTriggers([
      rb("a", "p1", "f", 60),
      rb("b", "p1", "f", 60),
      rb("c", "p1", "g", 60),
      rb("d", "p2", "f", 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers", () => {
    const out = uniqueGcpCloudLoggingTriggers([
      rb("a", "p", "f", 60),
      rb("b", "p", "f", 30),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-gcp_cloud_logging runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      agent: fakeAgent(),
      sourcePath: "/tmp/x.yaml",
    };
    expect(uniqueGcpCloudLoggingTriggers([fileRb])).toEqual([]);
  });
});
