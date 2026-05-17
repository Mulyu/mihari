import { describe, expect, it, vi } from "vitest";
import {
  JiraSearchPoller,
  SEARCH_PATH,
  buildSearchRequest,
  computeNextState,
  decidePoll,
  jiraJqlTimeString,
  parseJiraUpdated,
  uniqueJiraSearchTriggers,
  type JiraSearchApi,
  type RawIssue,
  type SearchIssuesInput,
  type SearchIssuesOutput,
} from "../src/triggers/jira-search.js";
import type {
  JiraSearchPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: SearchIssuesOutput[],
): JiraSearchApi & { calls: SearchIssuesInput[] } {
  const calls: SearchIssuesInput[] = [];
  let i = 0;
  return {
    calls,
    async searchIssues(input) {
      calls.push(input);
      const r = responses[i] ?? { issues: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: JiraSearchPollerState | null = null): StateStore & {
  saved: JiraSearchPollerState[];
} {
  let cur = initial;
  const saved: JiraSearchPollerState[] = [];
  return {
    saved,
    loadJiraSearchState: vi.fn(() => cur),
    saveJiraSearchState: vi.fn(async (s: JiraSearchPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: JiraSearchPollerState[] };
}

const KEY = { base: "https://example.atlassian.net", jql: "project = OPS" };

function rawIssue(over: Partial<RawIssue> & Pick<RawIssue, "key" | "updated_ms">): RawIssue {
  return {
    summary: "summary",
    status: "Open",
    updated: new Date(over.updated_ms).toISOString(),
    ...over,
  };
}

describe("parseJiraUpdated", () => {
  it("parses ISO strings", () => {
    expect(parseJiraUpdated("2026-05-09T12:00:00.000Z")).toBe(
      Date.parse("2026-05-09T12:00:00.000Z"),
    );
  });
  it("passes through numbers", () => {
    expect(parseJiraUpdated(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it("returns 0 for unparseable", () => {
    expect(parseJiraUpdated(undefined)).toBe(0);
    expect(parseJiraUpdated("not a date")).toBe(0);
  });
});

describe("jiraJqlTimeString", () => {
  it("floors ms to minute boundary and renders YYYY-MM-DD HH:mm UTC", () => {
    expect(jiraJqlTimeString(Date.parse("2026-05-09T12:34:56.789Z"))).toBe("2026-05-09 12:34");
  });
});

describe("buildSearchRequest", () => {
  it("targets the new /rest/api/3/search/jql endpoint", () => {
    expect(SEARCH_PATH).toBe("/rest/api/3/search/jql");
    const req = buildSearchRequest(
      "https://x.atlassian.net",
      "project = OPS",
      Date.parse("2026-05-09T12:00:00Z"),
      50,
      undefined,
    );
    expect(req.url).toBe(`https://x.atlassian.net${SEARCH_PATH}`);
  });

  it("appends updated >= filter and ORDER BY when fromMs > 0", () => {
    const req = buildSearchRequest(
      "https://x.atlassian.net",
      "project = OPS",
      Date.parse("2026-05-09T12:00:00Z"),
      50,
      undefined,
    );
    expect(req.body.jql).toBe(
      '(project = OPS) AND updated >= "2026-05-09 12:00" ORDER BY updated ASC',
    );
    expect(req.body.fields).toEqual(["summary", "status", "updated"]);
    expect(req.body.maxResults).toBe(50);
    expect(req.body.nextPageToken).toBeUndefined();
  });

  it("omits updated >= filter when fromMs is 0", () => {
    const req = buildSearchRequest("https://x.atlassian.net", "project = OPS", 0, 50, undefined);
    expect(req.body.jql).toBe("project = OPS ORDER BY updated ASC");
  });

  it("includes nextPageToken in body when provided", () => {
    const req = buildSearchRequest(
      "https://x.atlassian.net",
      "project = OPS",
      Date.parse("2026-05-09T12:00:00Z"),
      50,
      "TOKEN-1",
    );
    expect(req.body.nextPageToken).toBe("TOKEN-1");
  });
});

describe("decidePoll", () => {
  it("seeds on first observation", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z")).action).toBe("seed");
  });

  it("skips when interval has not elapsed", () => {
    const prev: JiraSearchPollerState = {
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: 1_000,
      last_issue_keys: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z")).action).toBe("skip");
  });

  it("polls when interval has elapsed and exposes prev cursor as fromMs", () => {
    const prev: JiraSearchPollerState = {
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: 1_000,
      last_issue_keys: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const d = decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"));
    expect(d.action).toBe("poll");
    expect(d.fromMs).toBe(1_000);
  });
});

describe("JiraSearchPoller.tick", () => {
  it("first tick seeds state at minute boundary and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([{ issues: [] }]);
    const poller = new JiraSearchPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:30Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(state.saved[0]?.last_updated_ms).toBe(Date.parse("2026-05-09T12:00:00Z"));
  });

  it("emits issues newer than cursor and advances cursor", async () => {
    const cursorMs = Date.parse("2026-05-09T12:00:00Z");
    const state = fakeState({
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: cursorMs,
      last_issue_keys: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        issues: [
          rawIssue({ key: "OPS-1", updated_ms: cursorMs + 30_000 }),
          rawIssue({ key: "OPS-2", updated_ms: cursorMs + 60_000 }),
        ],
      },
    ]);
    const poller = new JiraSearchPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.issue_key)).toEqual(["OPS-1", "OPS-2"]);
    expect(state.saved[0]?.last_updated_ms).toBe(cursorMs + 60_000);
    expect(state.saved[0]?.last_issue_keys).toEqual(["OPS-2"]);
  });

  it("dedups issue keys at the boundary timestamp", async () => {
    const cursorMs = Date.parse("2026-05-09T12:00:00Z");
    const state = fakeState({
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: cursorMs,
      last_issue_keys: ["OPS-1"],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        issues: [
          rawIssue({ key: "OPS-1", updated_ms: cursorMs }),
          rawIssue({ key: "OPS-2", updated_ms: cursorMs }),
          rawIssue({ key: "OPS-3", updated_ms: cursorMs + 1000 }),
        ],
      },
    ]);
    const poller = new JiraSearchPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.issue_key)).toEqual(["OPS-2", "OPS-3"]);
  });

  it("paginates while nextPageToken is returned", async () => {
    const cursorMs = Date.parse("2026-05-09T12:00:00Z");
    const state = fakeState({
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: cursorMs,
      last_issue_keys: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        issues: [rawIssue({ key: "OPS-1", updated_ms: cursorMs + 1 })],
        nextPageToken: "T1",
      },
      { issues: [rawIssue({ key: "OPS-2", updated_ms: cursorMs + 2 })] },
    ]);
    const poller = new JiraSearchPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.nextPageToken).toBe("T1");
    expect(events.map((e) => e.issue_key)).toEqual(["OPS-1", "OPS-2"]);
  });

  it("dryRun does not write state", async () => {
    const cursorMs = Date.parse("2026-05-09T12:00:00Z");
    const state = fakeState({
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: cursorMs,
      last_issue_keys: [],
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ issues: [rawIssue({ key: "OPS-1", updated_ms: cursorMs + 10 })] }]);
    const poller = new JiraSearchPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("computeNextState", () => {
  it("retains boundary keys when max did not advance", () => {
    const prev: JiraSearchPollerState = {
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: 200,
      last_issue_keys: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawIssue({ key: "b", updated_ms: 200 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_updated_ms).toBe(200);
    expect(next.last_issue_keys.sort()).toEqual(["a", "b"]);
  });

  it("replaces boundary keys when max advanced", () => {
    const prev: JiraSearchPollerState = {
      base: KEY.base,
      jql: KEY.jql,
      last_updated_ms: 200,
      last_issue_keys: ["a"],
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const next = computeNextState(
      prev,
      KEY,
      [rawIssue({ key: "b", updated_ms: 300 })],
      new Date("2026-05-09T12:01:00Z"),
    );
    expect(next.last_updated_ms).toBe(300);
    expect(next.last_issue_keys).toEqual(["b"]);
  });
});

describe("uniqueJiraSearchTriggers", () => {
  function rb(id: string, base: string, jql: string, intervalSec: number): Runbook {
    return {
      id,
      trigger: { source: "jira_search", base, jql, interval_sec: intervalSec },
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (base, jql)", () => {
    const out = uniqueJiraSearchTriggers([
      rb("a", "https://x.atlassian.net", "project = OPS", 60),
      rb("b", "https://x.atlassian.net", "project = OPS", 60),
      rb("c", "https://x.atlassian.net", "project = PROD", 60),
      rb("d", "https://y.atlassian.net", "project = OPS", 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers", () => {
    const out = uniqueJiraSearchTriggers([
      rb("a", "https://x", "q", 60),
      rb("b", "https://x", "q", 30),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-jira_search runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      agent: fakeAgent(),
      sourcePath: "/tmp/x.yaml",
    };
    expect(uniqueJiraSearchTriggers([fileRb])).toEqual([]);
  });
});
