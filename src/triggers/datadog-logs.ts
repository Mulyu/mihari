import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  DatadogLogsPollerState,
  DatadogLogsTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.datadog-logs");

export type DatadogLogEvent = Extract<TriggerEvent, { type: "datadog_log" }>;

export interface SearchLogsInput {
  query: string;
  fromMs: number;
  toMs: number;
  cursor?: string;
}

export interface RawLog {
  id: string;
  timestamp_ms: number;
  service: string;
  host: string;
  message: string;
}

export interface SearchLogsOutput {
  logs: RawLog[];
  cursor?: string;
}

export interface DatadogLogsApi {
  searchLogs(input: SearchLogsInput): Promise<SearchLogsOutput>;
}

export interface DatadogLogsApiFactory {
  forSite(site: string): DatadogLogsApi;
}

// 1 tick で取り切れない量が来たときの安全網。aws_cloudwatch_logs と同じ理由で
// 残りは次 tick に持ち越す。
export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
  startTimeMs: number;
}

export function decidePoll(
  prev: DatadogLogsPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) {
    return { action: "seed", startTimeMs: now.getTime() };
  }
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) {
    return { action: "skip", startTimeMs: prev.last_event_timestamp_ms };
  }
  return { action: "poll", startTimeMs: prev.last_event_timestamp_ms };
}

export interface PollerKey {
  site: string;
  query: string;
}

export class DatadogLogsPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: DatadogLogsApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<DatadogLogEvent[]> {
    const prev = this.state.loadDatadogLogsState(this.key);
    const decision = decidePoll(prev, this.intervalSec, now);

    if (decision.action === "skip") return [];

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveDatadogLogsState({
          site: this.key.site,
          query: this.key.query,
          last_event_timestamp_ms: now.getTime(),
          last_event_ids: [],
          last_polled_at: now.toISOString(),
        });
      }
      return [];
    }

    const seenIds = new Set(prev?.last_event_ids ?? []);
    const collected: RawLog[] = [];
    let cursor: string | undefined;
    let hops = 0;

    do {
      const res = await this.api.searchLogs({
        query: this.key.query,
        fromMs: decision.startTimeMs,
        toMs: now.getTime(),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const l of res.logs) {
        if (seenIds.has(l.id)) continue;
        collected.push(l);
      }
      cursor = res.cursor;
      hops++;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn(
          { query: this.key.query, hops },
          "pagination cap reached, will resume next tick",
        );
        break;
      }
    } while (cursor);

    const events: DatadogLogEvent[] = collected.map((l) => ({
      type: "datadog_log",
      site: this.key.site,
      query: this.key.query,
      log_id: l.id,
      service: l.service,
      host: l.host,
      message: l.message,
      timestamp: new Date(l.timestamp_ms).toISOString(),
      timestamp_ms: l.timestamp_ms,
    }));

    if (!dryRun) {
      const next = computeNextState(prev, this.key, collected, now);
      await this.state.saveDatadogLogsState(next);
    }

    return events;
  }
}

// aws_cloudwatch_logs と同形のカーソル更新。max timestamp に進めて、その timestamp に
// 並んだ id を last_event_ids として残し、次回ポーリングの境界重複除去に使う。
export function computeNextState(
  prev: DatadogLogsPollerState | null,
  key: PollerKey,
  newLogs: RawLog[],
  now: Date,
): DatadogLogsPollerState {
  const prevMaxMs = prev?.last_event_timestamp_ms ?? now.getTime();
  let maxMs = prevMaxMs;
  for (const l of newLogs) {
    if (l.timestamp_ms > maxMs) maxMs = l.timestamp_ms;
  }
  const idsAtMax = newLogs.filter((l) => l.timestamp_ms === maxMs).map((l) => l.id);
  const last_event_ids =
    maxMs === prevMaxMs
      ? Array.from(new Set([...(prev?.last_event_ids ?? []), ...idsAtMax]))
      : idsAtMax;

  return {
    site: key.site,
    query: key.query,
    last_event_timestamp_ms: maxMs,
    last_event_ids,
    last_polled_at: now.toISOString(),
  };
}

type DatadogLogsRunbook = Runbook & { trigger: DatadogLogsTrigger };

function isDatadogLogsRunbook(rb: Runbook): rb is DatadogLogsRunbook {
  return rb.trigger.source === "datadog_logs";
}

export interface UniqueDatadogLogsTrigger {
  site: string;
  query: string;
  intervalSec: number;
}

export function uniqueDatadogLogsTriggers(runbooks: Runbook[]): UniqueDatadogLogsTrigger[] {
  const groups = new Map<string, UniqueDatadogLogsTrigger>();
  for (const rb of runbooks) {
    if (!isDatadogLogsRunbook(rb)) continue;
    const key = `${rb.trigger.site}|${rb.trigger.query}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        site: rb.trigger.site,
        query: rb.trigger.query,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// SDK は datadog_logs トリガーが 1 つでも存在するときだけ動的 import する。
// datadog_monitors と同じ @datadog/datadog-api-client を共有するが、API client の
// インスタンスは別 (v2.LogsApi) で per-site にキャッシュする。
export async function createDatadogLogsApiFactory(): Promise<DatadogLogsApiFactory> {
  const sdk = await import("@datadog/datadog-api-client");
  const { client, v2 } = sdk;

  const apiKey = process.env["DD_API_KEY"] ?? "";
  const appKey = process.env["DD_APP_KEY"] ?? "";
  if (!apiKey || !appKey) {
    log.warn(
      { apiKey: apiKey ? "set" : "missing", appKey: appKey ? "set" : "missing" },
      "DD_API_KEY / DD_APP_KEY are required for datadog_logs trigger; SDK will return auth errors",
    );
  }

  const cache = new Map<string, DatadogLogsApi>();
  return {
    forSite(site: string) {
      const existing = cache.get(site);
      if (existing) return existing;
      const configuration = client.createConfiguration({
        authMethods: { apiKeyAuth: apiKey, appKeyAuth: appKey },
      });
      client.setServerVariables(configuration, { site });
      const logsApi = new v2.LogsApi(configuration);
      const api: DatadogLogsApi = {
        async searchLogs(input) {
          const body: import("@datadog/datadog-api-client").v2.LogsListRequest = {
            filter: {
              query: input.query,
              from: new Date(input.fromMs).toISOString(),
              to: new Date(input.toMs).toISOString(),
            },
            sort: "timestamp",
            page: { limit: 1000 },
          };
          if (input.cursor !== undefined && body.page !== undefined) {
            body.page.cursor = input.cursor;
          }
          const res = await logsApi.listLogs({ body });
          const logs: RawLog[] = [];
          for (const d of res.data ?? []) {
            const id = d.id;
            const a = d.attributes;
            if (typeof id !== "string" || a === undefined) continue;
            const tsRaw = a.timestamp;
            if (tsRaw === undefined) continue;
            const ts = tsRaw instanceof Date ? tsRaw.getTime() : Date.parse(String(tsRaw));
            if (!Number.isFinite(ts)) continue;
            logs.push({
              id,
              timestamp_ms: ts,
              service: typeof a.service === "string" ? a.service : "",
              host: typeof a.host === "string" ? a.host : "",
              message: typeof a.message === "string" ? a.message : "",
            });
          }
          const cursor = res.meta?.page?.after;
          return {
            logs,
            ...(typeof cursor === "string" ? { cursor } : {}),
          };
        },
      };
      cache.set(site, api);
      return api;
    },
  };
}
