import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  GithubWorkflowRunsPollerState,
  GithubWorkflowRunsTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.github-workflow-runs");

export type GithubWorkflowRunEvent = Extract<TriggerEvent, { type: "github_workflow_run" }>;

export interface ListRunsInput {
  repo: string;
  page: number;
  perPage: number;
}

export interface RawRun {
  id: number;
  run_number: number;
  workflow_name: string;
  workflow_path: string;
  branch: string;
  conclusion: string;
  status: string;
  html_url: string;
  updated_at: string;
}

export interface ListRunsOutput {
  runs: RawRun[];
  hasMore: boolean;
}

export interface GithubWorkflowRunsApi {
  listCompletedRuns(input: ListRunsInput): Promise<ListRunsOutput>;
}

export interface GithubWorkflowRunsApiFactory {
  forRepo(repo: string): GithubWorkflowRunsApi;
}

export const PER_PAGE = 100;
export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
  cursor: number;
}

export function decidePoll(
  prev: GithubWorkflowRunsPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed", cursor: 0 };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) return { action: "skip", cursor: prev.last_run_id };
  return { action: "poll", cursor: prev.last_run_id };
}

export interface PollerKey {
  repo: string;
}

export class GithubWorkflowRunsPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: GithubWorkflowRunsApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<GithubWorkflowRunEvent[]> {
    const prev = this.state.loadGithubWorkflowRunsState({ repo: this.key.repo });
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    if (decision.action === "seed") {
      // 初回 seed では top run の id を cursor として保存し、過去履歴を遡らない。
      const first = await this.api.listCompletedRuns({
        repo: this.key.repo,
        page: 1,
        perPage: 1,
      });
      const maxId = first.runs[0]?.id ?? 0;
      if (!dryRun) {
        await this.state.saveGithubWorkflowRunsState({
          repo: this.key.repo,
          last_run_id: maxId,
          last_polled_at: now.toISOString(),
        });
      }
      return [];
    }

    const collected: RawRun[] = [];
    let page = 1;
    let hops = 0;
    let hitOldCursor = false;

    while (!hitOldCursor) {
      const res = await this.api.listCompletedRuns({
        repo: this.key.repo,
        page,
        perPage: PER_PAGE,
      });
      for (const r of res.runs) {
        if (r.id <= decision.cursor) {
          hitOldCursor = true;
          continue;
        }
        collected.push(r);
      }
      page++;
      hops++;
      if (!res.hasMore) break;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn({ repo: this.key.repo, hops }, "pagination cap reached, will resume next tick");
        break;
      }
    }

    // GitHub API は created DESC で返るので、cursor 更新には最大 id を使う。
    let newMaxId = decision.cursor;
    for (const r of collected) {
      if (r.id > newMaxId) newMaxId = r.id;
    }

    // emit は ascending（古いものから）の順で揃える。
    collected.sort((a, b) => a.id - b.id);

    const events: GithubWorkflowRunEvent[] = collected.map((r) => ({
      type: "github_workflow_run",
      repo: this.key.repo,
      run_id: r.id,
      run_number: r.run_number,
      workflow_name: r.workflow_name,
      workflow_path: r.workflow_path,
      branch: r.branch,
      conclusion: r.conclusion,
      status: r.status,
      html_url: r.html_url,
      timestamp: r.updated_at,
    }));

    if (!dryRun) {
      await this.state.saveGithubWorkflowRunsState({
        repo: this.key.repo,
        last_run_id: newMaxId,
        last_polled_at: now.toISOString(),
      });
    }

    return events;
  }
}

type GithubWorkflowRunsRunbook = Runbook & { trigger: GithubWorkflowRunsTrigger };

function isGithubWorkflowRunsRunbook(rb: Runbook): rb is GithubWorkflowRunsRunbook {
  return rb.trigger.source === "github_workflow_runs";
}

export interface UniqueGithubWorkflowRunsTrigger {
  repo: string;
  intervalSec: number;
}

// repo 単位でグループ化。branch / workflows / conclusions は matcher 側で個別適用。
export function uniqueGithubWorkflowRunsTriggers(
  runbooks: Runbook[],
): UniqueGithubWorkflowRunsTrigger[] {
  const groups = new Map<string, UniqueGithubWorkflowRunsTrigger>();
  for (const rb of runbooks) {
    if (!isGithubWorkflowRunsRunbook(rb)) continue;
    const key = rb.trigger.repo;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        repo: rb.trigger.repo,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// GitHub API は SDK を持たず Node の global fetch を使う。認証は env GH_TOKEN。
// レート制限は authenticated で 5000 req/hour、interval_sec を 60+ にする想定で十分。
export async function createGithubWorkflowRunsApiFactory(): Promise<GithubWorkflowRunsApiFactory> {
  const token = process.env["GH_TOKEN"] ?? "";
  if (!token) {
    log.warn(
      {},
      "GH_TOKEN is required for github_workflow_runs trigger; unauthenticated calls hit a 60 req/hour rate limit",
    );
  }

  const cache = new Map<string, GithubWorkflowRunsApi>();
  return {
    forRepo(repo: string) {
      const existing = cache.get(repo);
      if (existing) return existing;
      const api: GithubWorkflowRunsApi = {
        async listCompletedRuns(input) {
          const params = new URLSearchParams({
            status: "completed",
            per_page: String(input.perPage),
            page: String(input.page),
          });
          const url = `https://api.github.com/repos/${input.repo}/actions/runs?${params.toString()}`;
          const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          };
          if (token) headers["Authorization"] = `Bearer ${token}`;
          const res = await fetch(url, { headers });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`github actions/runs ${res.status}: ${text.slice(0, 200)}`);
          }
          const body = (await res.json()) as {
            total_count?: number;
            workflow_runs?: Array<{
              id?: number;
              run_number?: number;
              name?: string;
              path?: string;
              head_branch?: string;
              conclusion?: string;
              status?: string;
              html_url?: string;
              updated_at?: string;
            }>;
          };
          const runs: RawRun[] = [];
          for (const r of body.workflow_runs ?? []) {
            if (typeof r.id !== "number") continue;
            runs.push({
              id: r.id,
              run_number: typeof r.run_number === "number" ? r.run_number : 0,
              workflow_name: typeof r.name === "string" ? r.name : "",
              workflow_path: typeof r.path === "string" ? r.path : "",
              branch: typeof r.head_branch === "string" ? r.head_branch : "",
              conclusion: typeof r.conclusion === "string" ? r.conclusion : "",
              status: typeof r.status === "string" ? r.status : "",
              html_url: typeof r.html_url === "string" ? r.html_url : "",
              updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
            });
          }
          const total = body.total_count ?? 0;
          const hasMore = input.page * input.perPage < total;
          return { runs, hasMore };
        },
      };
      cache.set(repo, api);
      return api;
    },
  };
}
