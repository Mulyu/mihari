import { describe, expect, it, vi } from "vitest";
import {
  CloudWatchLogsPoller,
  computeNextState,
  decidePoll,
  uniqueCloudWatchLogsTriggers,
  type CloudWatchLogsApi,
  type FilterLogEventsInput,
  type FilterLogEventsOutput,
} from "../src/triggers/cloudwatch-logs.js";
import type {
  CloudWatchLogsPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";

function fakeApi(
  responses: FilterLogEventsOutput[],
): CloudWatchLogsApi & { calls: FilterLogEventsInput[] } {
  const calls: FilterLogEventsInput[] = [];
  let i = 0;
  return {
    calls,
    async filterLogEvents(input) {
      calls.push(input);
      const r = responses[i] ?? { events: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: CloudWatchLogsPollerState | null = null): StateStore & {
  saved: CloudWatchLogsPollerState[];
} {
  let cur = initial;
  const saved: CloudWatchLogsPollerState[] = [];
  return {
    saved,
    loadCloudWatchLogsState: vi.fn(() => cur),
    saveCloudWatchLogsState: vi.fn(async (s: CloudWatchLogsPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: CloudWatchLogsPollerState[] };
}

const KEY = { region: "us-east-1", logGroup: "/aws/lambda/x" };

describe("decidePoll", () => {
  it("seeds on first observation (no fire)", () => {
    const now = new Date("2026-05-06T12:00:00Z");
    expect(decidePoll(null, 60, now)).toEqual({
      action: "seed",
      startTimeMs: now.getTime(),
    });
  });

  it("skips when interval has not elapsed yet", () => {
    const now = new Date("2026-05-06T12:00:30Z");
    const prev: CloudWatchLogsPollerState = {
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: [],
      last_polled_at: "2026-05-06T12:00:00Z",
    };
    expect(decidePoll(prev, 60, now)).toEqual({
      action: "skip",
      startTimeMs: 100,
    });
  });

  it("polls when interval has elapsed (start at last_event_timestamp_ms inclusive)", () => {
    const now = new Date("2026-05-06T12:01:00Z");
    const prev: CloudWatchLogsPollerState = {
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 1234,
      last_event_ids: ["a", "b"],
      last_polled_at: "2026-05-06T12:00:00Z",
    };
    expect(decidePoll(prev, 60, now)).toEqual({
      action: "poll",
      startTimeMs: 1234,
    });
  });
});

describe("computeNextState", () => {
  it("when max timestamp advances, last_event_ids resets to ids at new max", () => {
    const prev: CloudWatchLogsPollerState = {
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: ["old1", "old2"],
      last_polled_at: "2026-05-06T12:00:00Z",
    };
    const events = [
      { eventId: "n1", timestamp: 200, message: "m1", logStreamName: "s" },
      { eventId: "n2", timestamp: 200, message: "m2", logStreamName: "s" },
      { eventId: "n3", timestamp: 150, message: "m3", logStreamName: "s" },
    ];
    const now = new Date("2026-05-06T12:01:00Z");
    const next = computeNextState(prev, KEY, events, now);
    expect(next.last_event_timestamp_ms).toBe(200);
    expect(next.last_event_ids.sort()).toEqual(["n1", "n2"]);
    expect(next.last_polled_at).toBe(now.toISOString());
  });

  it("when no new events seen, retains prev cursor and ids and updates last_polled_at", () => {
    const prev: CloudWatchLogsPollerState = {
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-06T12:00:00Z",
    };
    const now = new Date("2026-05-06T12:01:00Z");
    const next = computeNextState(prev, KEY, [], now);
    expect(next.last_event_timestamp_ms).toBe(100);
    expect(next.last_event_ids).toEqual(["a"]);
    expect(next.last_polled_at).toBe(now.toISOString());
  });

  it("when new events all sit on the same boundary as prev max, ids merge with prev", () => {
    const prev: CloudWatchLogsPollerState = {
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: ["a"],
      last_polled_at: "2026-05-06T12:00:00Z",
    };
    const events = [
      { eventId: "b", timestamp: 100, message: "m", logStreamName: "s" },
      { eventId: "c", timestamp: 100, message: "m", logStreamName: "s" },
    ];
    const now = new Date("2026-05-06T12:01:00Z");
    const next = computeNextState(prev, KEY, events, now);
    expect(next.last_event_timestamp_ms).toBe(100);
    expect(next.last_event_ids.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("CloudWatchLogsPoller.tick", () => {
  it("first tick seeds cursor and does not call API", async () => {
    const state = fakeState(null);
    const api = fakeApi([]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-06T12:00:00Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]?.last_event_timestamp_ms).toBe(
      new Date("2026-05-06T12:00:00Z").getTime(),
    );
    expect(state.saved[0]?.last_event_ids).toEqual([]);
  });

  it("skips API call when interval has not elapsed", async () => {
    const state = fakeState({
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: [],
      last_polled_at: "2026-05-06T12:00:00Z",
    });
    const api = fakeApi([]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-06T12:00:30Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved).toHaveLength(0);
  });

  it("returns events as CloudWatchLogsEvent objects after interval elapses", async () => {
    const state = fakeState({
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 100,
      last_event_ids: [],
      last_polled_at: "2026-05-06T12:00:00Z",
    });
    const api = fakeApi([
      {
        events: [
          {
            eventId: "e1",
            timestamp: 200,
            message: "ERROR something",
            logStreamName: "s1",
          },
          {
            eventId: "e2",
            timestamp: 250,
            message: "ERROR another",
            logStreamName: "s2",
          },
        ],
      },
    ]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-06T12:01:30Z"));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "cloudwatch_logs",
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      message: "ERROR something",
      log_stream: "s1",
      event_id: "e1",
      timestamp_ms: 200,
    });
    expect(api.calls[0]).toEqual({
      logGroupName: "/aws/lambda/x",
      startTime: 100,
    });
    expect(state.saved[0]?.last_event_timestamp_ms).toBe(250);
    expect(state.saved[0]?.last_event_ids).toEqual(["e2"]);
  });

  it("filters out boundary-event duplicates using last_event_ids", async () => {
    const state = fakeState({
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 200,
      last_event_ids: ["seen-already"],
      last_polled_at: "2026-05-06T12:00:00Z",
    });
    const api = fakeApi([
      {
        events: [
          {
            eventId: "seen-already",
            timestamp: 200,
            message: "old",
            logStreamName: "s",
          },
          {
            eventId: "new-one",
            timestamp: 200,
            message: "new",
            logStreamName: "s",
          },
        ],
      },
    ]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-06T12:01:30Z"));
    expect(events.map((e) => e.event_id)).toEqual(["new-one"]);
    expect(state.saved[0]?.last_event_ids.sort()).toEqual(
      ["new-one", "seen-already"].sort(),
    );
  });

  it("paginates with nextToken until exhausted", async () => {
    const state = fakeState({
      region: "us-east-1",
      log_group: "/aws/lambda/x",
      last_event_timestamp_ms: 0,
      last_event_ids: [],
      last_polled_at: "2026-05-06T12:00:00Z",
    });
    const api = fakeApi([
      {
        events: [
          { eventId: "a", timestamp: 100, message: "m", logStreamName: "s" },
        ],
        nextToken: "tok1",
      },
      {
        events: [
          { eventId: "b", timestamp: 200, message: "m", logStreamName: "s" },
        ],
      },
    ]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-06T12:01:30Z"));
    expect(events.map((e) => e.event_id)).toEqual(["a", "b"]);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.nextToken).toBe("tok1");
  });

  it("dryRun does not write state", async () => {
    const state = fakeState(null);
    const api = fakeApi([]);
    const poller = new CloudWatchLogsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-06T12:00:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("uniqueCloudWatchLogsTriggers", () => {
  function rb(id: string, region: string, group: string, intervalSec: number): Runbook {
    return {
      id,
      trigger: {
        source: "cloudwatch_logs",
        region,
        log_group: group,
        interval_sec: intervalSec,
      },
      steps: [
        { id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false },
      ],
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (region, log_group)", () => {
    const out = uniqueCloudWatchLogsTriggers([
      rb("a", "us-east-1", "/g", 60),
      rb("b", "us-east-1", "/g", 60),
      rb("c", "us-west-2", "/g", 60),
      rb("d", "us-east-1", "/h", 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers of the same key", () => {
    const out = uniqueCloudWatchLogsTriggers([
      rb("a", "us-east-1", "/g", 60),
      rb("b", "us-east-1", "/g", 30),
      rb("c", "us-east-1", "/g", 120),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-cloudwatch_logs runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      steps: [
        { id: "x", bash: "true", timeout_sec: 60, on_error: "stop", env: {}, capture: false },
      ],
      sourcePath: "/tmp/x.yaml",
    };
    const out = uniqueCloudWatchLogsTriggers([fileRb]);
    expect(out).toEqual([]);
  });
});
