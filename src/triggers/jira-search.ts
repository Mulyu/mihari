import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  JiraSearchPollerState,
  JiraSearchTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.jira-search");

export type JiraIssueEvent = Extract<TriggerEvent, { type: "jira_issue" }>;

export interface SearchIssuesInput {
  jql: string;
  fromMs: number;
  nextPageToken?: string;
  maxResults: number;
}

export interface RawIssue {
  key: string;
  summary: string;
  status: string;
  updated_ms: number;
  updated: string;
}

export interface SearchIssuesOutput {
  issues: RawIssue[];
  nextPageToken?: string;
}

export interface JiraSearchApi {
  searchIssues(input: SearchIssuesInput): Promise<SearchIssuesOutput>;
}

export interface JiraSearchApiFactory {
  forBase(base: string): JiraSearchApi;
}

export const PAGE_SIZE = 100;
export const PAGINATION_HOP_CAP = 50;

export const SEARCH_PATH = "/rest/api/3/search/jql";

export interface PollDecision {
  action: "poll" | "skip" | "seed";
  fromMs: number;
}

export function decidePoll(
  prev: JiraSearchPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed", fromMs: now.getTime() };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) {
    return { action: "skip", fromMs: prev.last_updated_ms };
  }
  return { action: "poll", fromMs: prev.last_updated_ms };
}

export interface PollerKey {
  base: string;
  jql: string;
}

export class JiraSearchPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: JiraSearchApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<JiraIssueEvent[]> {
    const prev = this.state.loadJiraSearchState(this.key);
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    if (decision.action === "seed") {
      if (!dryRun) {
        // 初回観測ではミニッツ境界に丸めて保存する。Jira `updated >=` は分粒度なので
        // 次回以降のフィルタに直接使えるようにする。
        const minuteFloorMs = Math.floor(now.getTime() / 60_000) * 60_000;
        await this.state.saveJiraSearchState({
          base: this.key.base,
          jql: this.key.jql,
          last_updated_ms: minuteFloorMs,
          last_issue_keys: [],
          last_polled_at: now.toISOString(),
        });
      }
      return [];
    }

    const seenKeys = new Set(prev?.last_issue_keys ?? []);
    const collected: RawIssue[] = [];
    let nextPageToken: string | undefined;
    let hops = 0;

    while (true) {
      const res = await this.api.searchIssues({
        jql: this.key.jql,
        fromMs: decision.fromMs,
        maxResults: PAGE_SIZE,
        ...(nextPageToken !== undefined ? { nextPageToken } : {}),
      });
      for (const i of res.issues) {
        if (i.updated_ms < decision.fromMs) continue;
        if (i.updated_ms === decision.fromMs && seenKeys.has(i.key)) continue;
        collected.push(i);
      }
      hops++;
      if (res.nextPageToken === undefined) break;
      nextPageToken = res.nextPageToken;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn(
          { jql: this.key.jql, hops },
          "pagination cap reached, will resume next tick",
        );
        break;
      }
    }

    const events: JiraIssueEvent[] = collected.map((i) => ({
      type: "jira_issue",
      base: this.key.base,
      jql: this.key.jql,
      issue_key: i.key,
      summary: i.summary,
      status: i.status,
      updated: i.updated,
      updated_ms: i.updated_ms,
      timestamp: now.toISOString(),
    }));

    if (!dryRun) {
      const next = computeNextState(prev, this.key, collected, now);
      await this.state.saveJiraSearchState(next);
    }

    return events;
  }
}

// 新カーソル: 観測した issue の updated_ms の最大値（分単位に丸めない。Jira `updated >=`
// は分粒度だが、内部カーソルは ms 値そのままで持っておけば次回 fetch 後の dedup で
// 過剰検出を防げる）。境界 dedup 用に同 ms に並ぶ issue_keys を保持する。
export function computeNextState(
  prev: JiraSearchPollerState | null,
  key: PollerKey,
  newIssues: RawIssue[],
  now: Date,
): JiraSearchPollerState {
  const prevMaxMs = prev?.last_updated_ms ?? 0;
  let maxMs = prevMaxMs;
  for (const i of newIssues) {
    if (i.updated_ms > maxMs) maxMs = i.updated_ms;
  }
  const keysAtMax = newIssues.filter((i) => i.updated_ms === maxMs).map((i) => i.key);
  const last_issue_keys =
    maxMs === prevMaxMs
      ? Array.from(new Set([...(prev?.last_issue_keys ?? []), ...keysAtMax]))
      : keysAtMax;

  return {
    base: key.base,
    jql: key.jql,
    last_updated_ms: maxMs,
    last_issue_keys,
    last_polled_at: now.toISOString(),
  };
}

type JiraSearchRunbook = Runbook & { trigger: JiraSearchTrigger };

function isJiraSearchRunbook(rb: Runbook): rb is JiraSearchRunbook {
  return rb.trigger.source === "jira_search";
}

export interface UniqueJiraSearchTrigger {
  base: string;
  jql: string;
  intervalSec: number;
}

export function uniqueJiraSearchTriggers(runbooks: Runbook[]): UniqueJiraSearchTrigger[] {
  const groups = new Map<string, UniqueJiraSearchTrigger>();
  for (const rb of runbooks) {
    if (!isJiraSearchRunbook(rb)) continue;
    const key = `${rb.trigger.base}|${rb.trigger.jql}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        base: rb.trigger.base,
        jql: rb.trigger.jql,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// Jira REST API の updated は ms epoch も拾えるが、ISO 文字列で返るのが標準。
// 両方に対応する。
export function parseJiraUpdated(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

// JQL の updated 比較は分粒度なので、from を分境界で送る。
export function jiraJqlTimeString(ms: number): string {
  const d = new Date(Math.floor(ms / 60_000) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface SearchRequest {
  url: string;
  body: {
    jql: string;
    fields: string[];
    maxResults: number;
    nextPageToken?: string;
  };
}

// /rest/api/3/search/jql は新エンドポイント (旧 /rest/api/3/search は Jira Cloud で廃止)。
// JQL や fields は POST body に乗せ、ページングは cursor (nextPageToken) で行う。
export function buildSearchRequest(
  base: string,
  jql: string,
  fromMs: number,
  maxResults: number,
  nextPageToken: string | undefined,
): SearchRequest {
  const composed =
    fromMs > 0
      ? `(${jql}) AND updated >= "${jiraJqlTimeString(fromMs)}" ORDER BY updated ASC`
      : `${jql} ORDER BY updated ASC`;
  const body: SearchRequest["body"] = {
    jql: composed,
    fields: ["summary", "status", "updated"],
    maxResults,
  };
  if (nextPageToken !== undefined) body.nextPageToken = nextPageToken;
  return { url: `${base}${SEARCH_PATH}`, body };
}

// Jira は SDK を持たず fetch で叩く（Node 20+ の global fetch）。認証は env JIRA_USER /
// JIRA_TOKEN を basic 認証ヘッダに組む。mihari は YAML に認証フィールドを置かない方針。
export async function createJiraSearchApiFactory(): Promise<JiraSearchApiFactory> {
  const user = process.env["JIRA_USER"] ?? "";
  const token = process.env["JIRA_TOKEN"] ?? "";
  if (!user || !token) {
    log.warn(
      { user: user ? "set" : "missing", token: token ? "set" : "missing" },
      "JIRA_USER / JIRA_TOKEN are required for jira_search trigger; API calls will fail with 401",
    );
  }
  const auth = Buffer.from(`${user}:${token}`).toString("base64");

  const cache = new Map<string, JiraSearchApi>();
  return {
    forBase(base: string) {
      const existing = cache.get(base);
      if (existing) return existing;
      const api: JiraSearchApi = {
        async searchIssues(input) {
          const req = buildSearchRequest(
            base,
            input.jql,
            input.fromMs,
            input.maxResults,
            input.nextPageToken,
          );
          const res = await fetch(req.url, {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(req.body),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`jira search ${res.status}: ${text.slice(0, 200)}`);
          }
          const body = (await res.json()) as {
            nextPageToken?: string;
            issues?: Array<{
              key?: string;
              fields?: {
                summary?: string;
                status?: { name?: string };
                updated?: string;
              };
            }>;
          };
          const issues: RawIssue[] = [];
          for (const it of body.issues ?? []) {
            if (typeof it.key !== "string") continue;
            const updatedRaw = it.fields?.updated;
            const updated_ms = parseJiraUpdated(updatedRaw);
            issues.push({
              key: it.key,
              summary: typeof it.fields?.summary === "string" ? it.fields.summary : "",
              status: typeof it.fields?.status?.name === "string" ? it.fields.status.name : "",
              updated: typeof updatedRaw === "string" ? updatedRaw : "",
              updated_ms,
            });
          }
          return {
            issues,
            ...(typeof body.nextPageToken === "string" ? { nextPageToken: body.nextPageToken } : {}),
          };
        },
      };
      cache.set(base, api);
      return api;
    },
  };
}
