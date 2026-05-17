import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  Runbook,
  SentryIssueLevel,
  SentryIssuesPollerState,
  SentryIssuesTrigger,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.sentry-issues");

export type SentryIssueEvent = Extract<TriggerEvent, { type: "sentry_issue" }>;

export interface ListIssuesInput {
  organization: string;
  project: string;
  cursor?: string;
}

export interface RawIssue {
  id: string;
  short_id: string;
  title: string;
  level: SentryIssueLevel;
  status: string;
  permalink: string;
  first_seen: string;
  first_seen_ms: number;
  last_seen: string;
  last_seen_ms: number;
}

export interface ListIssuesOutput {
  issues: RawIssue[];
  cursor?: string;
}

export interface SentryIssuesApi {
  listUnresolvedIssues(input: ListIssuesInput): Promise<ListIssuesOutput>;
}

export interface SentryIssuesApiFactory {
  forBase(base: string): SentryIssuesApi;
}

export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
}

export function decidePoll(
  prev: SentryIssuesPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed" };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) return { action: "skip" };
  return { action: "poll" };
}

export interface PollerKey {
  base: string;
  organization: string;
  project: string;
}

export class SentryIssuesPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: SentryIssuesApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<SentryIssueEvent[]> {
    const prev = this.state.loadSentryIssuesState(this.key);
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    const issues = await this.fetchAllIssues();

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveSentryIssuesState(this.buildState(prev, issues, now));
      }
      return [];
    }

    // 既知 issue は last_seen が進んだときに fire（=新規 event 観測の合図）。
    // 未知 issue は is_new=true で fire（新規 issue）。
    const events: SentryIssueEvent[] = [];
    for (const i of issues) {
      const prevLastSeen = prev?.issue_last_seen_ms[i.id];
      const isNew = prevLastSeen === undefined;
      if (!isNew && i.last_seen_ms <= (prevLastSeen ?? 0)) continue;
      events.push({
        type: "sentry_issue",
        base: this.key.base,
        organization: this.key.organization,
        project: this.key.project,
        issue_id: i.id,
        short_id: i.short_id,
        title: i.title,
        level: i.level,
        status: i.status,
        permalink: i.permalink,
        first_seen: i.first_seen,
        last_seen: i.last_seen,
        is_new: isNew,
        timestamp: now.toISOString(),
      });
    }

    if (!dryRun) {
      await this.state.saveSentryIssuesState(this.buildState(prev, issues, now));
    }

    return events;
  }

  // datadog_monitors と同じ理由で「前回 state ∪ 今回観測分」を保持する。
  // unresolved でなくなって今回観測されなかった issue は state にゴミとして残るが、
  // 観測されない以上 event も emit されない（fail-open）。
  private buildState(
    prev: SentryIssuesPollerState | null,
    issues: RawIssue[],
    now: Date,
  ): SentryIssuesPollerState {
    const issue_last_seen_ms: Record<string, number> = {
      ...(prev?.issue_last_seen_ms ?? {}),
    };
    for (const i of issues) {
      issue_last_seen_ms[i.id] = i.last_seen_ms;
    }
    return {
      base: this.key.base,
      organization: this.key.organization,
      project: this.key.project,
      issue_last_seen_ms,
      last_polled_at: now.toISOString(),
    };
  }

  private async fetchAllIssues(): Promise<RawIssue[]> {
    const all: RawIssue[] = [];
    let cursor: string | undefined;
    let hops = 0;
    while (true) {
      const res = await this.api.listUnresolvedIssues({
        organization: this.key.organization,
        project: this.key.project,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      all.push(...res.issues);
      hops++;
      if (res.cursor === undefined) return all;
      cursor = res.cursor;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn(
          { organization: this.key.organization, project: this.key.project, hops },
          "pagination cap reached, will resume next tick",
        );
        return all;
      }
    }
  }
}

type SentryIssuesRunbook = Runbook & { trigger: SentryIssuesTrigger };

function isSentryIssuesRunbook(rb: Runbook): rb is SentryIssuesRunbook {
  return rb.trigger.source === "sentry_issues";
}

export interface UniqueSentryIssuesTrigger {
  base: string;
  organization: string;
  project: string;
  intervalSec: number;
}

export function uniqueSentryIssuesTriggers(
  runbooks: Runbook[],
): UniqueSentryIssuesTrigger[] {
  const groups = new Map<string, UniqueSentryIssuesTrigger>();
  for (const rb of runbooks) {
    if (!isSentryIssuesRunbook(rb)) continue;
    const key = `${rb.trigger.base}|${rb.trigger.organization}|${rb.trigger.project}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        base: rb.trigger.base,
        organization: rb.trigger.organization,
        project: rb.trigger.project,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

export function normalizeSentryLevel(raw: unknown): SentryIssueLevel {
  if (
    raw === "fatal" ||
    raw === "error" ||
    raw === "warning" ||
    raw === "info" ||
    raw === "debug" ||
    raw === "sample"
  ) {
    return raw;
  }
  return "info";
}

// Sentry の Link ヘッダから rel="next" の cursor を取り出す。
//   `<...>; rel="previous"; results="false"; cursor="...:0:1", <...>; rel="next"; results="true"; cursor="A:1:0"`
export function parseSentryNextCursor(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const seg = part.trim();
    if (!/rel="next"/.test(seg)) continue;
    if (!/results="true"/.test(seg)) return undefined;
    const m = /cursor="([^"]+)"/.exec(seg);
    if (m && typeof m[1] === "string") return m[1];
  }
  return undefined;
}

// Sentry は SDK を持たず fetch で叩く。認証は env SENTRY_AUTH_TOKEN (Bearer)。
export async function createSentryIssuesApiFactory(): Promise<SentryIssuesApiFactory> {
  const token = process.env["SENTRY_AUTH_TOKEN"] ?? "";
  if (!token) {
    log.warn({}, "SENTRY_AUTH_TOKEN is required for sentry_issues trigger; calls will 401");
  }

  const cache = new Map<string, SentryIssuesApi>();
  return {
    forBase(base: string) {
      const existing = cache.get(base);
      if (existing) return existing;
      const api: SentryIssuesApi = {
        async listUnresolvedIssues(input) {
          const params = new URLSearchParams({
            query: "is:unresolved",
            statsPeriod: "24h",
            limit: "100",
          });
          if (input.cursor !== undefined) params.set("cursor", input.cursor);
          const url = `${base}/api/0/projects/${input.organization}/${input.project}/issues/?${params.toString()}`;
          const headers: Record<string, string> = { Accept: "application/json" };
          if (token) headers["Authorization"] = `Bearer ${token}`;
          const res = await fetch(url, { headers });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`sentry issues ${res.status}: ${text.slice(0, 200)}`);
          }
          const body = (await res.json()) as Array<{
            id?: string;
            shortId?: string;
            title?: string;
            level?: string;
            status?: string;
            permalink?: string;
            firstSeen?: string;
            lastSeen?: string;
          }>;
          const issues: RawIssue[] = [];
          for (const i of body) {
            if (typeof i.id !== "string") continue;
            const firstSeen = typeof i.firstSeen === "string" ? i.firstSeen : "";
            const lastSeen = typeof i.lastSeen === "string" ? i.lastSeen : "";
            const firstSeenMs = firstSeen ? Date.parse(firstSeen) : 0;
            const lastSeenMs = lastSeen ? Date.parse(lastSeen) : 0;
            issues.push({
              id: i.id,
              short_id: typeof i.shortId === "string" ? i.shortId : "",
              title: typeof i.title === "string" ? i.title : "",
              level: normalizeSentryLevel(i.level),
              status: typeof i.status === "string" ? i.status : "",
              permalink: typeof i.permalink === "string" ? i.permalink : "",
              first_seen: firstSeen,
              first_seen_ms: Number.isFinite(firstSeenMs) ? firstSeenMs : 0,
              last_seen: lastSeen,
              last_seen_ms: Number.isFinite(lastSeenMs) ? lastSeenMs : 0,
            });
          }
          const nextCursor = parseSentryNextCursor(res.headers.get("link"));
          return {
            issues,
            ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
          };
        },
      };
      cache.set(base, api);
      return api;
    },
  };
}
