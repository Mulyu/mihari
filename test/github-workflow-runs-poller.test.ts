import { describe, expect, it, vi } from "vitest";
import {
  GithubWorkflowRunsPoller,
  PAGINATION_HOP_CAP,
  decidePoll,
  uniqueGithubWorkflowRunsTriggers,
  type GithubWorkflowRunsApi,
  type ListRunsInput,
  type ListRunsOutput,
  type RawRun,
} from "../src/triggers/github-workflow-runs.js";
import { matchGithubWorkflowRun } from "../src/engine/matcher.js";
import type {
  GithubWorkflowRunsPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: ListRunsOutput[],
): GithubWorkflowRunsApi & { calls: ListRunsInput[] } {
  const calls: ListRunsInput[] = [];
  let i = 0;
  return {
    calls,
    async listCompletedRuns(input) {
      calls.push(input);
      const r = responses[i] ?? { runs: [], hasMore: false };
      i++;
      return r;
    },
  };
}

function fakeState(initial: GithubWorkflowRunsPollerState | null = null): StateStore & {
  saved: GithubWorkflowRunsPollerState[];
} {
  let cur = initial;
  const saved: GithubWorkflowRunsPollerState[] = [];
  return {
    saved,
    loadGithubWorkflowRunsState: vi.fn(() => cur),
    saveGithubWorkflowRunsState: vi.fn(async (s: GithubWorkflowRunsPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: GithubWorkflowRunsPollerState[] };
}

const KEY = { repo: "example/app" };

function rawRun(over: Partial<RawRun> & Pick<RawRun, "id">): RawRun {
  return {
    run_number: over.id,
    workflow_name: "CI",
    workflow_path: ".github/workflows/ci.yml",
    branch: "main",
    conclusion: "failure",
    status: "completed",
    html_url: `https://github.com/example/app/actions/runs/${over.id}`,
    updated_at: "2026-05-09T12:00:00Z",
    ...over,
  };
}

describe("decidePoll", () => {
  it("seeds on first observation", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z")).action).toBe("seed");
  });

  it("skips when interval has not elapsed", () => {
    const prev: GithubWorkflowRunsPollerState = {
      repo: KEY.repo,
      last_run_id: 100,
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z")).action).toBe("skip");
  });

  it("polls when interval has elapsed", () => {
    const prev: GithubWorkflowRunsPollerState = {
      repo: KEY.repo,
      last_run_id: 100,
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    const d = decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"));
    expect(d.action).toBe("poll");
    expect(d.cursor).toBe(100);
  });
});

describe("GithubWorkflowRunsPoller.tick", () => {
  it("first tick seeds state with the top run id and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([
      { runs: [rawRun({ id: 500 })], hasMore: true },
    ]);
    const poller = new GithubWorkflowRunsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(state.saved[0]?.last_run_id).toBe(500);
    expect(api.calls[0]?.perPage).toBe(1);
  });

  it("emits runs with id > cursor in ascending order and advances cursor", async () => {
    const state = fakeState({
      repo: KEY.repo,
      last_run_id: 100,
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        runs: [
          rawRun({ id: 110, run_number: 110 }),
          rawRun({ id: 105, run_number: 105 }),
          rawRun({ id: 100, run_number: 100 }),
        ],
        hasMore: false,
      },
    ]);
    const poller = new GithubWorkflowRunsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.run_id)).toEqual([105, 110]);
    expect(state.saved[0]?.last_run_id).toBe(110);
  });

  it("stops paginating once a run with id <= cursor appears", async () => {
    const state = fakeState({
      repo: KEY.repo,
      last_run_id: 100,
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        runs: [rawRun({ id: 120 }), rawRun({ id: 110 })],
        hasMore: true,
      },
      {
        runs: [rawRun({ id: 105 }), rawRun({ id: 99 })],
        hasMore: true,
      },
      { runs: [rawRun({ id: 1 })], hasMore: true },
    ]);
    const poller = new GithubWorkflowRunsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.run_id)).toEqual([105, 110, 120]);
    expect(api.calls).toHaveLength(2); // stops after seeing id=99 on page 2
  });

  it("respects PAGINATION_HOP_CAP", async () => {
    const state = fakeState({
      repo: KEY.repo,
      last_run_id: 0,
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const responses: ListRunsOutput[] = [];
    for (let i = 0; i < PAGINATION_HOP_CAP + 5; i++) {
      responses.push({
        runs: [rawRun({ id: 1_000 + i })],
        hasMore: true,
      });
    }
    const api = fakeApi(responses);
    const poller = new GithubWorkflowRunsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls.length).toBe(PAGINATION_HOP_CAP);
  });

  it("dryRun does not write state", async () => {
    const state = fakeState({
      repo: KEY.repo,
      last_run_id: 100,
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ runs: [rawRun({ id: 200 })], hasMore: false }]);
    const poller = new GithubWorkflowRunsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:01:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });
});

describe("matchGithubWorkflowRun", () => {
  function rb(
    id: string,
    repo: string,
    branch: string | undefined,
    workflows: string[] | undefined,
    conclusions: string[],
  ): Runbook {
    const trigger: Runbook["trigger"] = {
      source: "github_workflow_runs",
      repo,
      conclusions,
      interval_sec: 60,
    };
    if (branch !== undefined) trigger.branch = branch;
    if (workflows !== undefined) trigger.workflows = workflows;
    return {
      id,
      trigger,
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  const event = {
    type: "github_workflow_run" as const,
    repo: "example/app",
    run_id: 1,
    run_number: 1,
    workflow_name: "CI",
    workflow_path: ".github/workflows/ci.yml",
    branch: "main",
    conclusion: "failure",
    status: "completed",
    html_url: "https://github.com/x",
    timestamp: "2026-05-09T12:00:00Z",
  };

  it("matches when repo + branch + workflow slug + conclusion all match", () => {
    const r = rb("a", "example/app", "main", ["ci.yml"], ["failure"]);
    expect(matchGithubWorkflowRun(event, [r])).toHaveLength(1);
  });

  it("matches workflow by full path or workflow name", () => {
    expect(matchGithubWorkflowRun(event, [rb("a", "example/app", undefined, [".github/workflows/ci.yml"], ["failure"])])).toHaveLength(1);
    expect(matchGithubWorkflowRun(event, [rb("b", "example/app", undefined, ["CI"], ["failure"])])).toHaveLength(1);
  });

  it("no match when branch differs", () => {
    expect(
      matchGithubWorkflowRun(event, [rb("a", "example/app", "release", ["ci.yml"], ["failure"])]),
    ).toEqual([]);
  });

  it("no match when conclusion not in list", () => {
    expect(
      matchGithubWorkflowRun(event, [rb("a", "example/app", undefined, undefined, ["success"])]),
    ).toEqual([]);
  });

  it("no match when workflows list does not include this run", () => {
    expect(
      matchGithubWorkflowRun(event, [rb("a", "example/app", undefined, ["release.yml"], ["failure"])]),
    ).toEqual([]);
  });

  it("no match when repo differs", () => {
    expect(
      matchGithubWorkflowRun(event, [rb("a", "other/app", undefined, undefined, ["failure"])]),
    ).toEqual([]);
  });
});

describe("uniqueGithubWorkflowRunsTriggers", () => {
  function rb(id: string, repo: string, intervalSec: number): Runbook {
    return {
      id,
      trigger: {
        source: "github_workflow_runs",
        repo,
        conclusions: ["failure"],
        interval_sec: intervalSec,
      },
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by repo", () => {
    const out = uniqueGithubWorkflowRunsTriggers([
      rb("a", "x/y", 60),
      rb("b", "x/y", 60),
      rb("c", "x/z", 60),
    ]);
    expect(out).toHaveLength(2);
  });

  it("takes min interval_sec across subscribers", () => {
    const out = uniqueGithubWorkflowRunsTriggers([
      rb("a", "x/y", 60),
      rb("b", "x/y", 30),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });
});
