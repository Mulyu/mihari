import { describe, expect, it, vi } from "vitest";
import {
  SentryIssuesPoller,
  decidePoll,
  normalizeSentryLevel,
  parseSentryNextCursor,
  uniqueSentryIssuesTriggers,
  type ListIssuesInput,
  type ListIssuesOutput,
  type RawIssue,
  type SentryIssuesApi,
} from "../src/triggers/sentry-issues.js";
import type {
  Runbook,
  SentryIssueLevel,
  SentryIssuesPollerState,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: ListIssuesOutput[],
): SentryIssuesApi & { calls: ListIssuesInput[] } {
  const calls: ListIssuesInput[] = [];
  let i = 0;
  return {
    calls,
    async listUnresolvedIssues(input) {
      calls.push(input);
      const r = responses[i] ?? { issues: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: SentryIssuesPollerState | null = null): StateStore & {
  saved: SentryIssuesPollerState[];
} {
  let cur = initial;
  const saved: SentryIssuesPollerState[] = [];
  return {
    saved,
    loadSentryIssuesState: vi.fn(() => cur),
    saveSentryIssuesState: vi.fn(async (s: SentryIssuesPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: SentryIssuesPollerState[] };
}

const KEY = { base: "https://sentry.io", organization: "my-org", project: "my-project" };

function rawIssue(
  over: Partial<RawIssue> & Pick<RawIssue, "id" | "last_seen_ms">,
): RawIssue {
  const lastSeen = new Date(over.last_seen_ms).toISOString();
  return {
    short_id: over.id,
    title: "Boom",
    level: "error" as SentryIssueLevel,
    status: "unresolved",
    permalink: `https://sentry.io/${over.id}`,
    first_seen: lastSeen,
    first_seen_ms: over.last_seen_ms,
    last_seen: lastSeen,
    ...over,
  };
}

describe("normalizeSentryLevel", () => {
  it("passes valid levels through", () => {
    expect(normalizeSentryLevel("error")).toBe("error");
    expect(normalizeSentryLevel("fatal")).toBe("fatal");
  });
  it("falls back to info for unknown", () => {
    expect(normalizeSentryLevel("bogus")).toBe("info");
    expect(normalizeSentryLevel(undefined)).toBe("info");
  });
});

describe("parseSentryNextCursor", () => {
  it("extracts cursor when rel=next and results=true", () => {
    const link =
      '<https://sentry.io/api/0/x/?cursor=A:1:0>; rel="next"; results="true"; cursor="A:1:0"';
    expect(parseSentryNextCursor(link)).toBe("A:1:0");
  });

  it("returns undefined when rel=next but results=false", () => {
    const link = '<https://x>; rel="next"; results="false"; cursor="A:1:0"';
    expect(parseSentryNextCursor(link)).toBeUndefined();
  });

  it("returns undefined when link header is null", () => {
    expect(parseSentryNextCursor(null)).toBeUndefined();
  });

  it("handles a multi-rel Link header", () => {
    const link =
      '<https://sentry.io/prev>; rel="previous"; results="false"; cursor="P:0:1", <https://sentry.io/next>; rel="next"; results="true"; cursor="N:1:0"';
    expect(parseSentryNextCursor(link)).toBe("N:1:0");
  });
});

describe("decidePoll", () => {
  it("seeds on first observation", () => {
    expect(decidePoll(null, 60, new Date()).action).toBe("seed");
  });

  it("skips when interval has not elapsed", () => {
    const prev: SentryIssuesPollerState = {
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z")).action).toBe("skip");
  });

  it("polls when interval has elapsed", () => {
    const prev: SentryIssuesPollerState = {
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z")).action).toBe("poll");
  });
});

describe("SentryIssuesPoller.tick", () => {
  it("first tick seeds state and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([
      { issues: [rawIssue({ id: "1", last_seen_ms: 1_000 })] },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(state.saved[0]?.issue_last_seen_ms).toEqual({ "1": 1_000 });
  });

  it("emits is_new=true for issues never seen before", async () => {
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: { "1": 1_000 },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        issues: [
          rawIssue({ id: "1", last_seen_ms: 1_000 }),
          rawIssue({ id: "2", last_seen_ms: 2_000 }),
        ],
      },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]?.issue_id).toBe("2");
    expect(events[0]?.is_new).toBe(true);
  });

  it("emits is_new=false when last_seen advances for a known issue", async () => {
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: { "1": 1_000 },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { issues: [rawIssue({ id: "1", last_seen_ms: 1_500 })] },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]?.is_new).toBe(false);
  });

  it("does not emit when last_seen has not changed", async () => {
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: { "1": 1_000 },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { issues: [rawIssue({ id: "1", last_seen_ms: 1_000 })] },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    expect(await poller.tick(new Date("2026-05-09T12:01:00Z"))).toEqual([]);
  });

  it("paginates while cursor is returned", async () => {
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { issues: [rawIssue({ id: "1", last_seen_ms: 1 })], cursor: "C1" },
      { issues: [rawIssue({ id: "2", last_seen_ms: 2 })] },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.cursor).toBe("C1");
    expect(events.map((e) => e.issue_id).sort()).toEqual(["1", "2"]);
  });

  it("merges prev state with newly fetched issues", async () => {
    // 既知 issue が今回 fetch されなかった場合に drop しない (datadog_monitors と同じ)
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: { "1": 100, "2": 100 },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      { issues: [rawIssue({ id: "1", last_seen_ms: 200 })] },
    ]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(state.saved[0]?.issue_last_seen_ms).toEqual({ "1": 200, "2": 100 });
  });

  it("dryRun does not write state", async () => {
    const state = fakeState({
      base: KEY.base,
      organization: KEY.organization,
      project: KEY.project,
      issue_last_seen_ms: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ issues: [rawIssue({ id: "1", last_seen_ms: 100 })] }]);
    const poller = new SentryIssuesPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("uniqueSentryIssuesTriggers", () => {
  function rb(
    id: string,
    base: string,
    organization: string,
    project: string,
    intervalSec: number,
  ): Runbook {
    return {
      id,
      trigger: {
        source: "sentry_issues",
        base,
        organization,
        project,
        levels: ["error", "fatal"],
        interval_sec: intervalSec,
      },
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (base, organization, project)", () => {
    const out = uniqueSentryIssuesTriggers([
      rb("a", "https://sentry.io", "o", "p", 60),
      rb("b", "https://sentry.io", "o", "p", 60),
      rb("c", "https://sentry.io", "o", "q", 60),
      rb("d", "https://sentry.io", "p", "p", 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers", () => {
    const out = uniqueSentryIssuesTriggers([
      rb("a", "https://x", "o", "p", 60),
      rb("b", "https://x", "o", "p", 30),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });
});
