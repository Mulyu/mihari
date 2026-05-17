import type { StateStore } from "../state/store.js";
import type {
  AwsCloudWatchAlarmState,
  AwsCloudWatchAlarmsPollerState,
  AwsCloudWatchAlarmsTrigger,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

export type AwsCloudWatchAlarmEvent = Extract<TriggerEvent, { type: "aws_cloudwatch_alarm" }>;

export interface DescribeAlarmsInput {
  alarmNames?: string[];
  nextToken?: string;
}

export interface RawAlarm {
  alarm_name: string;
  alarm_arn: string;
  state_value: AwsCloudWatchAlarmState;
}

export interface DescribeAlarmsOutput {
  alarms: RawAlarm[];
  nextToken?: string;
}

export interface AwsCloudWatchAlarmsApi {
  describeAlarms(input: DescribeAlarmsInput): Promise<DescribeAlarmsOutput>;
}

export interface AwsCloudWatchAlarmsApiFactory {
  forRegion(region: string): AwsCloudWatchAlarmsApi;
}

export interface PollDecision {
  action: "poll" | "skip" | "seed";
}

export function decidePoll(
  prev: AwsCloudWatchAlarmsPollerState | null,
  intervalSec: number,
  now: Date,
): PollDecision {
  if (prev === null) return { action: "seed" };
  const elapsedMs = now.getTime() - new Date(prev.last_polled_at).getTime();
  if (elapsedMs < intervalSec * 1000) return { action: "skip" };
  return { action: "poll" };
}

export interface PollerKey {
  region: string;
  alarmNames: string[];
}

export class AwsCloudWatchAlarmsPoller {
  constructor(
    public readonly key: PollerKey,
    public readonly intervalSec: number,
    private readonly state: StateStore,
    private readonly api: AwsCloudWatchAlarmsApi,
  ) {}

  async tick(now: Date = new Date(), dryRun = false): Promise<AwsCloudWatchAlarmEvent[]> {
    const prev = this.state.loadAwsCloudWatchAlarmsState({
      region: this.key.region,
      alarmNames: this.key.alarmNames,
    });
    const decision = decidePoll(prev, this.intervalSec, now);
    if (decision.action === "skip") return [];

    const alarms = await this.fetchAllAlarms();

    if (decision.action === "seed") {
      if (!dryRun) {
        await this.state.saveAwsCloudWatchAlarmsState(this.buildState(prev, alarms, now));
      }
      return [];
    }

    const events: AwsCloudWatchAlarmEvent[] = [];
    for (const a of alarms) {
      const fromState = prev?.alarm_states[a.alarm_name];
      if (fromState !== undefined && fromState !== a.state_value) {
        events.push({
          type: "aws_cloudwatch_alarm",
          region: this.key.region,
          alarm_names: this.key.alarmNames,
          alarm_name: a.alarm_name,
          alarm_arn: a.alarm_arn,
          from_state: fromState,
          to_state: a.state_value,
          timestamp: now.toISOString(),
        });
      }
    }

    if (!dryRun) {
      await this.state.saveAwsCloudWatchAlarmsState(this.buildState(prev, alarms, now));
    }

    return events;
  }

  // alarm_states は前回 state ∪ 今回観測分の merge。datadog_monitors と同じ理由で、
  // 途中失敗時にゴミが残ることは許容する（fail-open）。
  private buildState(
    prev: AwsCloudWatchAlarmsPollerState | null,
    alarms: RawAlarm[],
    now: Date,
  ): AwsCloudWatchAlarmsPollerState {
    const alarm_states: Record<string, AwsCloudWatchAlarmState> = {
      ...(prev?.alarm_states ?? {}),
    };
    for (const a of alarms) {
      alarm_states[a.alarm_name] = a.state_value;
    }
    return {
      region: this.key.region,
      alarm_names: this.key.alarmNames,
      alarm_states,
      last_polled_at: now.toISOString(),
    };
  }

  private async fetchAllAlarms(): Promise<RawAlarm[]> {
    const all: RawAlarm[] = [];
    let nextToken: string | undefined;
    const input: DescribeAlarmsInput = {};
    if (this.key.alarmNames.length > 0) input.alarmNames = this.key.alarmNames;
    while (true) {
      const res = await this.api.describeAlarms({
        ...input,
        ...(nextToken !== undefined ? { nextToken } : {}),
      });
      all.push(...res.alarms);
      if (res.nextToken === undefined) return all;
      nextToken = res.nextToken;
    }
  }
}

type AwsCloudWatchAlarmsRunbook = Runbook & { trigger: AwsCloudWatchAlarmsTrigger };

function isAwsCloudWatchAlarmsRunbook(rb: Runbook): rb is AwsCloudWatchAlarmsRunbook {
  return rb.trigger.source === "aws_cloudwatch_alarms";
}

export interface UniqueAwsCloudWatchAlarmsTrigger {
  region: string;
  alarmNames: string[];
  intervalSec: number;
}

// (region, alarm_names) でグループ化。alarm_names は順序非依存にするためソート後 join をキーに使う。
// 同じ key を購読する複数 runbook がある場合、interval は min を取る。
export function uniqueAwsCloudWatchAlarmsTriggers(
  runbooks: Runbook[],
): UniqueAwsCloudWatchAlarmsTrigger[] {
  const groups = new Map<string, UniqueAwsCloudWatchAlarmsTrigger>();
  for (const rb of runbooks) {
    if (!isAwsCloudWatchAlarmsRunbook(rb)) continue;
    const names = [...(rb.trigger.alarm_names ?? [])].sort();
    const key = `${rb.trigger.region}|${names.join(",")}`;
    const existing = groups.get(key);
    if (existing) {
      existing.intervalSec = Math.min(existing.intervalSec, rb.trigger.interval_sec);
    } else {
      groups.set(key, {
        region: rb.trigger.region,
        alarmNames: names,
        intervalSec: rb.trigger.interval_sec,
      });
    }
  }
  return [...groups.values()];
}

// CloudWatch の StateValue は OK / ALARM / INSUFFICIENT_DATA のリテラルで返るので
// そのまま使う（mihari 内部で別名へ変換しない方針）。未知の値は INSUFFICIENT_DATA に倒す。
export function normalizeAlarmState(raw: unknown): AwsCloudWatchAlarmState {
  if (raw === "OK" || raw === "ALARM" || raw === "INSUFFICIENT_DATA") return raw;
  return "INSUFFICIENT_DATA";
}

// SDK は aws_cloudwatch_alarms トリガーが 1 つでも存在するときだけ動的 import する。
// 認証は AWS SDK の標準チェーン（環境変数 / ~/.aws/credentials / IAM ロール）に委譲する。
export async function createAwsCloudWatchAlarmsApiFactory(): Promise<AwsCloudWatchAlarmsApiFactory> {
  const sdk = await import("@aws-sdk/client-cloudwatch");
  const { AlarmType, CloudWatchClient, DescribeAlarmsCommand } = sdk;

  const cache = new Map<string, AwsCloudWatchAlarmsApi>();
  return {
    forRegion(region: string) {
      const existing = cache.get(region);
      if (existing) return existing;
      const client = new CloudWatchClient({ region });
      const api: AwsCloudWatchAlarmsApi = {
        async describeAlarms(input) {
          const cmdInput: import("@aws-sdk/client-cloudwatch").DescribeAlarmsCommandInput = {
            AlarmTypes: [AlarmType.MetricAlarm, AlarmType.CompositeAlarm],
          };
          if (input.alarmNames !== undefined) cmdInput.AlarmNames = input.alarmNames;
          if (input.nextToken !== undefined) cmdInput.NextToken = input.nextToken;
          const out = await client.send(new DescribeAlarmsCommand(cmdInput));
          const alarms: RawAlarm[] = [];
          for (const a of out.MetricAlarms ?? []) {
            if (typeof a.AlarmName !== "string" || typeof a.AlarmArn !== "string") continue;
            alarms.push({
              alarm_name: a.AlarmName,
              alarm_arn: a.AlarmArn,
              state_value: normalizeAlarmState(a.StateValue),
            });
          }
          for (const a of out.CompositeAlarms ?? []) {
            if (typeof a.AlarmName !== "string" || typeof a.AlarmArn !== "string") continue;
            alarms.push({
              alarm_name: a.AlarmName,
              alarm_arn: a.AlarmArn,
              state_value: normalizeAlarmState(a.StateValue),
            });
          }
          return {
            alarms,
            ...(out.NextToken !== undefined ? { nextToken: out.NextToken } : {}),
          };
        },
      };
      cache.set(region, api);
      return api;
    },
  };
}

