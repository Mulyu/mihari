import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  CloudWatchLogsPollerState,
  CloudWatchLogsTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.cloudwatch-logs");

export type CloudWatchLogsEvent = Extract<TriggerEvent, { type: "cloudwatch_logs" }>;

// AWS SDK の CloudWatchLogsClient + FilterLogEventsCommand を薄くラップした抽象。
// テストは fake を注入できる。本番は createCloudWatchLogsApi() が SDK を動的 import して返す。
export interface FilterLogEventsInput {
  logGroupName: string;
  startTime: number;
  nextToken?: string;
}

export interface FilterLogEventsOutput {
  events: Array<{
    eventId: string;
    timestamp: number;
    message: string;
    logStreamName: string;
  }>;
  nextToken?: string;
}

export interface CloudWatchLogsApi {
  filterLogEvents(input: FilterLogEventsInput): Promise<FilterLogEventsOutput>;
}

export interface CloudWatchLogsApiFactory {
  forRegion(region: string): CloudWatchLogsApi;
}

// 最大 hop。1 tick で取り切れない量の event があれば残りは次 tick に持ち越す。
export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
  startTimeMs: number;
}

export function decidePoll(
  prev: CloudWatchLogsPollerState | null,
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
  region: string;
  logGroup: string;
}

export class CloudWatchLogsPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: CloudWatchLogsApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<CloudWatchLogsEvent[]> {
    const prev = this.state.loadCloudWatchLogsState(this.key);
    const decision = decidePoll(prev, this.intervalSec, now);

    if (decision.action === "skip") return [];

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveCloudWatchLogsState({
          region: this.key.region,
          log_group: this.key.logGroup,
          last_event_timestamp_ms: now.getTime(),
          last_event_ids: [],
          last_polled_at: now.toISOString(),
        });
      }
      return [];
    }

    const seenIds = new Set(prev?.last_event_ids ?? []);
    const collected: FilterLogEventsOutput["events"] = [];
    let nextToken: string | undefined;
    let hops = 0;

    do {
      const res = await this.api.filterLogEvents({
        logGroupName: this.key.logGroup,
        startTime: decision.startTimeMs,
        ...(nextToken !== undefined ? { nextToken } : {}),
      });
      for (const e of res.events) {
        if (seenIds.has(e.eventId)) continue;
        collected.push(e);
      }
      nextToken = res.nextToken;
      hops++;
      if (hops >= PAGINATION_HOP_CAP) {
        log.warn(
          { logGroup: this.key.logGroup, hops },
          "pagination cap reached, will resume next tick",
        );
        break;
      }
    } while (nextToken);

    const events: CloudWatchLogsEvent[] = collected.map((e) => ({
      type: "cloudwatch_logs",
      region: this.key.region,
      log_group: this.key.logGroup,
      log_stream: e.logStreamName,
      message: e.message,
      event_id: e.eventId,
      timestamp: new Date(e.timestamp).toISOString(),
      timestamp_ms: e.timestamp,
    }));

    if (!dryRun) {
      const next = computeNextState(prev, this.key, collected, now);
      await this.state.saveCloudWatchLogsState(next);
    }

    return events;
  }
}

// 新 cursor を計算する。max timestamp に進め、その timestamp に並んだ eventId を
// `last_event_ids` として残す。次回ポーリングの boundary 重複除去に使う。
export function computeNextState(
  prev: CloudWatchLogsPollerState | null,
  key: PollerKey,
  newEvents: FilterLogEventsOutput["events"],
  now: Date,
): CloudWatchLogsPollerState {
  const prevMaxMs = prev?.last_event_timestamp_ms ?? now.getTime();
  let maxMs = prevMaxMs;
  for (const e of newEvents) {
    if (e.timestamp > maxMs) maxMs = e.timestamp;
  }
  const idsAtMax = newEvents.filter((e) => e.timestamp === maxMs).map((e) => e.eventId);
  // maxMs が前回と同じなら前回の last_event_ids も残しておく（同 ms に追加で来た event を
  // 次回も弾けるようにするため）。max が進んだなら新しい batch だけが意味を持つ。
  const last_event_ids =
    maxMs === prevMaxMs
      ? Array.from(new Set([...(prev?.last_event_ids ?? []), ...idsAtMax]))
      : idsAtMax;

  return {
    region: key.region,
    log_group: key.logGroup,
    last_event_timestamp_ms: maxMs,
    last_event_ids,
    last_polled_at: now.toISOString(),
  };
}

type CloudWatchLogsRunbook = Runbook & { trigger: CloudWatchLogsTrigger };

function isCloudWatchLogsRunbook(rb: Runbook): rb is CloudWatchLogsRunbook {
  return rb.trigger.source === "cloudwatch_logs";
}

export interface UniqueCloudWatchLogsTrigger {
  region: string;
  logGroup: string;
  intervalSec: number;
}

// (region, log_group) でグループ化。同じ key を購読する複数 runbook がある場合、
// interval は min を取る（短い間隔で取れば長い間隔の購読側にも届く）。
export function uniqueCloudWatchLogsTriggers(
  runbooks: Runbook[],
): UniqueCloudWatchLogsTrigger[] {
  const groups = new Map<string, UniqueCloudWatchLogsTrigger>();
  for (const rb of runbooks) {
    if (!isCloudWatchLogsRunbook(rb)) continue;
    const key = `${rb.trigger.region}|${rb.trigger.log_group}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        region: rb.trigger.region,
        logGroup: rb.trigger.log_group,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// SDK は cloudwatch_logs トリガーが 1 つでも存在するときだけ動的 import する。
// それ以外のユーザーには @aws-sdk/client-cloudwatch-logs の起動コストが乗らない。
export async function createCloudWatchLogsApiFactory(): Promise<CloudWatchLogsApiFactory> {
  const sdk = await import("@aws-sdk/client-cloudwatch-logs");
  const { CloudWatchLogsClient, FilterLogEventsCommand } = sdk;

  const cache = new Map<string, CloudWatchLogsApi>();
  return {
    forRegion(region: string) {
      const existing = cache.get(region);
      if (existing) return existing;
      const client = new CloudWatchLogsClient({ region });
      const api: CloudWatchLogsApi = {
        async filterLogEvents(input) {
          const out = await client.send(
            new FilterLogEventsCommand({
              logGroupName: input.logGroupName,
              startTime: input.startTime,
              ...(input.nextToken !== undefined ? { nextToken: input.nextToken } : {}),
            }),
          );
          const events = (out.events ?? [])
            .filter(
              (
                e,
              ): e is {
                eventId: string;
                timestamp: number;
                message: string;
                logStreamName: string;
              } =>
                typeof e.eventId === "string" &&
                typeof e.timestamp === "number" &&
                typeof e.message === "string" &&
                typeof e.logStreamName === "string",
            )
            .map((e) => ({
              eventId: e.eventId,
              timestamp: e.timestamp,
              message: e.message,
              logStreamName: e.logStreamName,
            }));
          return {
            events,
            ...(out.nextToken !== undefined ? { nextToken: out.nextToken } : {}),
          };
        },
      };
      cache.set(region, api);
      return api;
    },
  };
}
