import { logger } from "../lib/logger.js";
import type { StateStore } from "../state/store.js";
import type {
  DatadogMonitorState,
  DatadogMonitorsPollerState,
  DatadogMonitorsTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

const log = logger("trigger.datadog-monitors");

export type DatadogMonitorEvent = Extract<TriggerEvent, { type: "datadog_monitor" }>;

// Datadog SDK の v1.MonitorsApi.listMonitors を薄くラップした抽象。
// テストは fake を注入できる。本番は createDatadogMonitorsApiFactory() が SDK を動的 import して返す。
export interface ListMonitorsInput {
  page: number;
  pageSize: number;
  monitorTags?: string;
}

export interface RawMonitor {
  id: string;
  name: string;
  overall_state: DatadogMonitorState;
}

export interface ListMonitorsOutput {
  monitors: RawMonitor[];
  hasMore: boolean;
}

export interface DatadogMonitorsApi {
  listMonitors(input: ListMonitorsInput): Promise<ListMonitorsOutput>;
}

export interface DatadogMonitorsApiFactory {
  forSite(site: string): DatadogMonitorsApi;
}

export const PAGE_SIZE = 100;
// 最大 hop。1 tick で取り切れない量があれば残りは次 tick に持ち越す。
export const PAGINATION_HOP_CAP = 50;

export interface PollDecision {
  action: "poll" | "skip" | "seed";
}

export function decidePoll(
  prev: DatadogMonitorsPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed" };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) return { action: "skip" };
  return { action: "poll" };
}

export interface PollerKey {
  site: string;
  monitorTags: string[];
}

export class DatadogMonitorsPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: DatadogMonitorsApi,
    // テストで小さい値に上書き可能。本番は PAGINATION_HOP_CAP を使う。
    private readonly hopCap: number = PAGINATION_HOP_CAP,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<DatadogMonitorEvent[]> {
    const prev = this.state.loadDatadogMonitorsState({
      site: this.key.site,
      monitorTags: this.key.monitorTags,
    });
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    // 前回 tick が hop cap で truncated されていれば続きの page から再開する。
    const startPage = prev?.next_page ?? 0;
    const fetched = await this.fetchPages(startPage);

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveDatadogMonitorsState(
          this.buildState(prev, fetched, now, /*emitEvents*/ false),
        );
      }
      return [];
    }

    // poll: 前回 state と差分を取り、状態が変化した monitor を全件 event 化する。
    // transitions による絞り込みは matcher 側で runbook.trigger.transitions に応じて行う
    // （同じ (site, monitor_tags) を購読する複数 runbook が異なる transitions を持てるよう）。
    const events: DatadogMonitorEvent[] = [];
    for (const m of fetched.monitors) {
      const fromState = prev?.monitor_states[m.id];
      if (fromState !== undefined && fromState !== m.overall_state) {
        events.push({
          type: "datadog_monitor",
          site: this.key.site,
          monitor_tags: this.key.monitorTags,
          monitor_id: m.id,
          monitor_name: m.name,
          from_state: fromState,
          to_state: m.overall_state,
          timestamp: now.toISOString(),
        });
      }
    }

    if (!dryRun) {
      await this.state.saveDatadogMonitorsState(
        this.buildState(prev, fetched, now, /*emitEvents*/ true),
      );
    }

    return events;
  }

  // monitor_states は常に「前回 state ∪ 今回観測分」の merge。1 回の walk が複数 tick に
  // またがる前提で、今回見えなかった monitor は前回 state から落とさない（部分取得時の
  // 過去 state 喪失を防ぐ）。完全取得（!truncated）時も merge を維持する代わり、削除検知は
  // 諦める：mihari は state を欠落させるより残すほうを選ぶ（fail-open 方針と整合）。
  private buildState(
    prev: DatadogMonitorsPollerState | null,
    fetched: FetchResult,
    now: Date,
    _emitEvents: boolean,
  ): DatadogMonitorsPollerState {
    const monitor_states: Record<string, DatadogMonitorState> = {
      ...(prev?.monitor_states ?? {}),
    };
    for (const m of fetched.monitors) {
      monitor_states[m.id] = m.overall_state;
    }
    const next: DatadogMonitorsPollerState = {
      site: this.key.site,
      monitor_tags: this.key.monitorTags,
      monitor_states,
      last_polled_at: now.toISOString(),
    };
    if (fetched.truncated) next.next_page = fetched.nextPage;
    return next;
  }

  private async fetchPages(startPage: number): Promise<FetchResult> {
    const all: RawMonitor[] = [];
    let page = startPage;
    let hops = 0;
    const tags =
      this.key.monitorTags.length > 0 ? this.key.monitorTags.join(",") : undefined;
    // hasMore が false になるか hop cap に達するまでページング。
    while (true) {
      const res = await this.api.listMonitors({
        page,
        pageSize: PAGE_SIZE,
        ...(tags !== undefined ? { monitorTags: tags } : {}),
      });
      all.push(...res.monitors);
      hops++;
      page++;
      if (!res.hasMore) {
        return { monitors: all, truncated: false, nextPage: 0 };
      }
      if (hops >= this.hopCap) {
        log.warn(
          { site: this.key.site, hops, nextPage: page },
          "pagination cap reached, will resume from next_page on next tick",
        );
        return { monitors: all, truncated: true, nextPage: page };
      }
    }
  }
}

interface FetchResult {
  monitors: RawMonitor[];
  truncated: boolean;
  // truncated=true のとき次回再開する page。truncated=false のときは 0 にリセット。
  nextPage: number;
}

type DatadogMonitorsRunbook = Runbook & { trigger: DatadogMonitorsTrigger };

function isDatadogMonitorsRunbook(rb: Runbook): rb is DatadogMonitorsRunbook {
  return rb.trigger.source === "datadog_monitors";
}

export interface UniqueDatadogMonitorsTrigger {
  site: string;
  monitorTags: string[];
  intervalSec: number;
}

// (site, monitor_tags) でグループ化。monitor_tags は順序非依存にするためソート後 join をキーに使う。
// 同じ key を購読する複数 runbook がある場合、interval は min を取る。
export function uniqueDatadogMonitorsTriggers(
  runbooks: Runbook[],
): UniqueDatadogMonitorsTrigger[] {
  const groups = new Map<string, UniqueDatadogMonitorsTrigger>();
  for (const rb of runbooks) {
    if (!isDatadogMonitorsRunbook(rb)) continue;
    const tags = [...(rb.trigger.monitor_tags ?? [])].sort();
    const key = `${rb.trigger.site}|${tags.join(",")}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        site: rb.trigger.site,
        monitorTags: tags,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// Datadog SDK の MonitorOverallStates 文字列を mihari の小文字リテラルへ正規化する。
export function normalizeOverallState(raw: unknown): DatadogMonitorState {
  if (typeof raw !== "string") return "unknown";
  switch (raw) {
    case "Alert":
      return "alert";
    case "Warn":
      return "warn";
    case "No Data":
      return "no_data";
    case "OK":
      return "ok";
    case "Skipped":
      return "skipped";
    case "Ignored":
      return "ignored";
    case "Unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

// SDK は datadog_monitors トリガーが 1 つでも存在するときだけ動的 import する。
// 認証は環境変数 DD_API_KEY / DD_APP_KEY から読み、SDK の authMethods にそのまま渡す。
// mihari は YAML に認証フィールドを置かない（aws_cloudwatch_logs が AWS SDK 標準チェーンに
// 委譲するのと対称）。
export async function createDatadogMonitorsApiFactory(): Promise<DatadogMonitorsApiFactory> {
  const sdk = await import("@datadog/datadog-api-client");
  const { client, v1 } = sdk;

  const apiKey = process.env["DD_API_KEY"] ?? "";
  const appKey = process.env["DD_APP_KEY"] ?? "";
  if (!apiKey || !appKey) {
    log.warn(
      { apiKey: apiKey ? "set" : "missing", appKey: appKey ? "set" : "missing" },
      "DD_API_KEY / DD_APP_KEY are required for datadog_monitors trigger; SDK will return auth errors",
    );
  }

  const cache = new Map<string, DatadogMonitorsApi>();
  return {
    forSite(site: string) {
      const existing = cache.get(site);
      if (existing) return existing;
      const configuration = client.createConfiguration({
        authMethods: {
          apiKeyAuth: apiKey,
          appKeyAuth: appKey,
        },
      });
      client.setServerVariables(configuration, { site });
      const monitorsApi = new v1.MonitorsApi(configuration);
      const api: DatadogMonitorsApi = {
        async listMonitors(input) {
          const params: { page: number; pageSize: number; monitorTags?: string } = {
            page: input.page,
            pageSize: input.pageSize,
          };
          if (input.monitorTags !== undefined) params.monitorTags = input.monitorTags;
          const monitors = await monitorsApi.listMonitors(params);
          const normalized: RawMonitor[] = [];
          for (const m of monitors) {
            if (typeof m.id !== "number") continue;
            if (typeof m.name !== "string") continue;
            normalized.push({
              id: String(m.id),
              name: m.name,
              overall_state: normalizeOverallState(m.overallState),
            });
          }
          // SDK は hasMore を返さない。pageSize ぴったりなら次があり得ると見なし、
          // 次の page を取りに行く（最終ページが空配列で終わるまで）。
          return {
            monitors: normalized,
            hasMore: monitors.length >= input.pageSize,
          };
        },
      };
      cache.set(site, api);
      return api;
    },
  };
}
