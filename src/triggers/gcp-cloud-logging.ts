import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  GcpCloudLoggingPollerState,
  GcpCloudLoggingTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.gcp-cloud-logging");

export type GcpCloudLoggingEvent = Extract<TriggerEvent, { type: "gcp_cloud_logging" }>;

export interface GetEntriesInput {
  filter: string;
  fromMs: number;
  toMs: number;
  pageToken?: string;
}

export interface RawLogEntry {
  insert_id: string;
  timestamp_ms: number;
  log_name: string;
  severity: string;
  resource_type: string;
  message: string;
}

export interface GetEntriesOutput {
  entries: RawLogEntry[];
  pageToken?: string;
}

export interface GcpCloudLoggingApi {
  getEntries(input: GetEntriesInput): Promise<GetEntriesOutput>;
}

export interface GcpCloudLoggingApiFactory {
  forProject(projectId: string): GcpCloudLoggingApi;
}

export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
  fromMs: number;
}

export function decidePoll(
  prev: GcpCloudLoggingPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed", fromMs: now.getTime() };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) {
    return { action: "skip", fromMs: prev.last_event_timestamp_ms };
  }
  return { action: "poll", fromMs: prev.last_event_timestamp_ms };
}

export interface PollerKey {
  projectId: string;
  filter: string;
}

export class GcpCloudLoggingPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: GcpCloudLoggingApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<GcpCloudLoggingEvent[]> {
    const prev = this.state.loadGcpCloudLoggingState(this.key);
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveGcpCloudLoggingState({
          project_id: this.key.projectId,
          filter: this.key.filter,
          last_event_timestamp_ms: now.getTime(),
          last_event_ids: [],
          last_polled_at: now.toISOString(),
        });
      }
      return [];
    }

    const seenIds = new Set(prev?.last_event_ids ?? []);
    const collected: RawLogEntry[] = [];
    let pageToken: string | undefined;
    let hops = 0;

    do {
      const res = await this.api.getEntries({
        filter: this.key.filter,
        fromMs: decision.fromMs,
        toMs: now.getTime(),
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const e of res.entries) {
        if (seenIds.has(e.insert_id)) continue;
        collected.push(e);
      }
      pageToken = res.pageToken;
      hops++;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn(
          { projectId: this.key.projectId, hops },
          "pagination cap reached, will resume next tick",
        );
        break;
      }
    } while (pageToken);

    const events: GcpCloudLoggingEvent[] = collected.map((e) => ({
      type: "gcp_cloud_logging",
      project_id: this.key.projectId,
      filter: this.key.filter,
      log_id: e.insert_id,
      log_name: e.log_name,
      severity: e.severity,
      resource_type: e.resource_type,
      message: e.message,
      timestamp: new Date(e.timestamp_ms).toISOString(),
      timestamp_ms: e.timestamp_ms,
    }));

    if (!dryRun) {
      const next = computeNextState(prev, this.key, collected, now);
      await this.state.saveGcpCloudLoggingState(next);
    }

    return events;
  }
}

export function computeNextState(
  prev: GcpCloudLoggingPollerState | null,
  key: PollerKey,
  newEntries: RawLogEntry[],
  now: Date,
): GcpCloudLoggingPollerState {
  const prevMaxMs = prev?.last_event_timestamp_ms ?? now.getTime();
  let maxMs = prevMaxMs;
  for (const e of newEntries) {
    if (e.timestamp_ms > maxMs) maxMs = e.timestamp_ms;
  }
  const idsAtMax = newEntries.filter((e) => e.timestamp_ms === maxMs).map((e) => e.insert_id);
  const last_event_ids =
    maxMs === prevMaxMs
      ? Array.from(new Set([...(prev?.last_event_ids ?? []), ...idsAtMax]))
      : idsAtMax;

  return {
    project_id: key.projectId,
    filter: key.filter,
    last_event_timestamp_ms: maxMs,
    last_event_ids,
    last_polled_at: now.toISOString(),
  };
}

type GcpCloudLoggingRunbook = Runbook & { trigger: GcpCloudLoggingTrigger };

function isGcpCloudLoggingRunbook(rb: Runbook): rb is GcpCloudLoggingRunbook {
  return rb.trigger.source === "gcp_cloud_logging";
}

export interface UniqueGcpCloudLoggingTrigger {
  projectId: string;
  filter: string;
  intervalSec: number;
}

export function uniqueGcpCloudLoggingTriggers(
  runbooks: Runbook[],
): UniqueGcpCloudLoggingTrigger[] {
  const groups = new Map<string, UniqueGcpCloudLoggingTrigger>();
  for (const rb of runbooks) {
    if (!isGcpCloudLoggingRunbook(rb)) continue;
    const key = `${rb.trigger.project_id}|${rb.trigger.filter}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        projectId: rb.trigger.project_id,
        filter: rb.trigger.filter,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// GCP の timestamp は RFC3339 文字列で来る。Date とプロトコルバッファ形式の {seconds, nanos}
// 両方に対応する。
export function parseGcpTimestamp(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  if (raw && typeof raw === "object") {
    const o = raw as { seconds?: string | number; nanos?: number };
    const seconds = typeof o.seconds === "string" ? Number(o.seconds) : o.seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof o.nanos === "number" ? o.nanos : 0;
      return seconds * 1000 + Math.floor(nanos / 1_000_000);
    }
  }
  return 0;
}

// SDK は gcp_cloud_logging トリガーが 1 つでも存在するときだけ動的 import する。
// 認証は GCP SDK の標準チェーン（GOOGLE_APPLICATION_CREDENTIALS / metadata server 等）に委譲。
export async function createGcpCloudLoggingApiFactory(): Promise<GcpCloudLoggingApiFactory> {
  const sdk = await import("@google-cloud/logging");
  const { Logging } = sdk;

  const cache = new Map<string, GcpCloudLoggingApi>();
  return {
    forProject(projectId: string) {
      const existing = cache.get(projectId);
      if (existing) return existing;
      const logging = new Logging({ projectId });
      const api: GcpCloudLoggingApi = {
        async getEntries(input) {
          // ユーザ指定の filter に加えて、cursor 由来の timestamp 範囲を AND で重ねる。
          const fromIso = new Date(input.fromMs).toISOString();
          const toIso = new Date(input.toMs).toISOString();
          const composedFilter = `(${input.filter}) AND timestamp >= "${fromIso}" AND timestamp <= "${toIso}"`;
          const opts: {
            filter: string;
            orderBy: string;
            pageSize: number;
            pageToken?: string;
          } = {
            filter: composedFilter,
            orderBy: "timestamp asc",
            pageSize: 1000,
          };
          if (input.pageToken !== undefined) opts.pageToken = input.pageToken;
          const [entries, nextQuery] = await logging.getEntries(opts);
          const out: RawLogEntry[] = [];
          for (const entry of entries) {
            const md = entry.metadata as {
              insertId?: string;
              timestamp?: unknown;
              logName?: string;
              severity?: string | number;
              resource?: { type?: string };
              textPayload?: string;
              jsonPayload?: unknown;
            };
            const id = typeof md.insertId === "string" ? md.insertId : "";
            if (!id) continue;
            const ts = parseGcpTimestamp(md.timestamp);
            if (!ts) continue;
            const message =
              typeof md.textPayload === "string"
                ? md.textPayload
                : md.jsonPayload !== undefined
                  ? JSON.stringify(md.jsonPayload)
                  : "";
            out.push({
              insert_id: id,
              timestamp_ms: ts,
              log_name: typeof md.logName === "string" ? md.logName : "",
              severity: typeof md.severity === "string" ? md.severity : String(md.severity ?? ""),
              resource_type:
                typeof md.resource?.type === "string" ? md.resource.type : "",
              message,
            });
          }
          const next =
            nextQuery && typeof (nextQuery as { pageToken?: string }).pageToken === "string"
              ? ((nextQuery as { pageToken: string }).pageToken as string)
              : undefined;
          return {
            entries: out,
            ...(next !== undefined ? { pageToken: next } : {}),
          };
        },
      };
      cache.set(projectId, api);
      return api;
    },
  };
}
