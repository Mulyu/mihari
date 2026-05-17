import { describe, expect, it, vi } from "vitest";
import {
  AwsCloudWatchAlarmsPoller,
  decidePoll,
  normalizeAlarmState,
  uniqueAwsCloudWatchAlarmsTriggers,
  type AwsCloudWatchAlarmsApi,
  type DescribeAlarmsInput,
  type DescribeAlarmsOutput,
} from "../src/triggers/aws-cloudwatch-alarms.js";
import type {
  AwsCloudWatchAlarmsPollerState,
  Runbook,
} from "../src/types/index.js";
import type { StateStore } from "../src/state/store.js";
import { fakeAgent } from "./_fixtures.js";

function fakeApi(
  responses: DescribeAlarmsOutput[],
): AwsCloudWatchAlarmsApi & { calls: DescribeAlarmsInput[] } {
  const calls: DescribeAlarmsInput[] = [];
  let i = 0;
  return {
    calls,
    async describeAlarms(input) {
      calls.push(input);
      const r = responses[i] ?? { alarms: [] };
      i++;
      return r;
    },
  };
}

function fakeState(initial: AwsCloudWatchAlarmsPollerState | null = null): StateStore & {
  saved: AwsCloudWatchAlarmsPollerState[];
} {
  let cur = initial;
  const saved: AwsCloudWatchAlarmsPollerState[] = [];
  return {
    saved,
    loadAwsCloudWatchAlarmsState: vi.fn(() => cur),
    saveAwsCloudWatchAlarmsState: vi.fn(async (s: AwsCloudWatchAlarmsPollerState) => {
      cur = s;
      saved.push(s);
    }),
  } as unknown as StateStore & { saved: AwsCloudWatchAlarmsPollerState[] };
}

const KEY = { region: "us-east-1", alarmNames: ["prod-5xx", "prod-latency"] };

describe("decidePoll", () => {
  it("seeds on first observation", () => {
    expect(decidePoll(null, 60, new Date("2026-05-09T12:00:00Z"))).toEqual({ action: "seed" });
  });

  it("skips when interval has not elapsed", () => {
    const prev: AwsCloudWatchAlarmsPollerState = {
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:00:30Z"))).toEqual({ action: "skip" });
  });

  it("polls when interval has elapsed", () => {
    const prev: AwsCloudWatchAlarmsPollerState = {
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    };
    expect(decidePoll(prev, 60, new Date("2026-05-09T12:01:00Z"))).toEqual({ action: "poll" });
  });
});

describe("normalizeAlarmState", () => {
  it("passes through valid CloudWatch state literals as-is", () => {
    expect(normalizeAlarmState("OK")).toBe("OK");
    expect(normalizeAlarmState("ALARM")).toBe("ALARM");
    expect(normalizeAlarmState("INSUFFICIENT_DATA")).toBe("INSUFFICIENT_DATA");
  });

  it("falls back to INSUFFICIENT_DATA for unexpected input", () => {
    expect(normalizeAlarmState(undefined)).toBe("INSUFFICIENT_DATA");
    expect(normalizeAlarmState("alarm")).toBe("INSUFFICIENT_DATA");
    expect(normalizeAlarmState(42)).toBe("INSUFFICIENT_DATA");
  });
});

describe("AwsCloudWatchAlarmsPoller.tick", () => {
  it("first tick seeds state and emits no events", async () => {
    const state = fakeState(null);
    const api = fakeApi([
      {
        alarms: [
          { alarm_name: "prod-5xx", alarm_arn: "arn:1", state_value: "OK" },
          { alarm_name: "prod-latency", alarm_arn: "arn:2", state_value: "ALARM" },
        ],
      },
    ]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:00Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(1);
    expect(state.saved[0]?.alarm_states).toEqual({
      "prod-5xx": "OK",
      "prod-latency": "ALARM",
    });
  });

  it("skips API call when interval has not elapsed", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:00:30Z"));
    expect(events).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("emits a transition event when state_value changes", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK", "prod-latency": "ALARM" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        alarms: [
          { alarm_name: "prod-5xx", alarm_arn: "arn:1", state_value: "ALARM" },
          { alarm_name: "prod-latency", alarm_arn: "arn:2", state_value: "ALARM" },
        ],
      },
    ]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "aws_cloudwatch_alarm",
      region: "us-east-1",
      alarm_name: "prod-5xx",
      alarm_arn: "arn:1",
      from_state: "OK",
      to_state: "ALARM",
    });
  });

  it("does not emit for alarms first observed (no fromState)", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        alarms: [
          { alarm_name: "prod-5xx", alarm_arn: "arn:1", state_value: "OK" },
          { alarm_name: "prod-new", alarm_arn: "arn:3", state_value: "ALARM" },
        ],
      },
    ]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events).toEqual([]);
    expect(state.saved[0]?.alarm_states).toEqual({
      "prod-5xx": "OK",
      "prod-new": "ALARM",
    });
  });

  it("paginates while NextToken is returned", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: [],
      alarm_states: { a: "OK", b: "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        alarms: [{ alarm_name: "a", alarm_arn: "arn:a", state_value: "ALARM" }],
        nextToken: "T",
      },
      {
        alarms: [{ alarm_name: "b", alarm_arn: "arn:b", state_value: "ALARM" }],
      },
    ]);
    const poller = new AwsCloudWatchAlarmsPoller(
      { region: "us-east-1", alarmNames: [] },
      60,
      state,
      api,
    );
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.nextToken).toBe("T");
    expect(events.map((e) => e.alarm_name).sort()).toEqual(["a", "b"]);
  });

  it("dryRun does not write state", async () => {
    const state = fakeState(null);
    const api = fakeApi([{ alarms: [] }]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    await poller.tick(new Date("2026-05-09T12:00:00Z"), true);
    expect(state.saved).toHaveLength(0);
  });

  it("merges prev state with newly fetched alarms instead of overwriting", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: ["prod-5xx", "prod-latency"],
      alarm_states: { "prod-5xx": "OK", "prod-latency": "OK" },
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([
      {
        alarms: [{ alarm_name: "prod-5xx", alarm_arn: "arn:1", state_value: "ALARM" }],
      },
    ]);
    const poller = new AwsCloudWatchAlarmsPoller(KEY, 60, state, api);
    const events = await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(events.map((e) => e.alarm_name)).toEqual(["prod-5xx"]);
    expect(state.saved[0]?.alarm_states).toEqual({
      "prod-5xx": "ALARM",
      "prod-latency": "OK",
    });
  });

  it("passes alarm_names to API when configured, omits when empty", async () => {
    const state = fakeState({
      region: "us-east-1",
      alarm_names: ["only-one"],
      alarm_states: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api = fakeApi([{ alarms: [] }]);
    const poller = new AwsCloudWatchAlarmsPoller(
      { region: "us-east-1", alarmNames: ["only-one"] },
      60,
      state,
      api,
    );
    await poller.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api.calls[0]?.alarmNames).toEqual(["only-one"]);

    const state2 = fakeState({
      region: "us-east-1",
      alarm_names: [],
      alarm_states: {},
      last_polled_at: "2026-05-09T12:00:00Z",
    });
    const api2 = fakeApi([{ alarms: [] }]);
    const poller2 = new AwsCloudWatchAlarmsPoller(
      { region: "us-east-1", alarmNames: [] },
      60,
      state2,
      api2,
    );
    await poller2.tick(new Date("2026-05-09T12:01:00Z"));
    expect(api2.calls[0]?.alarmNames).toBeUndefined();
  });
});

describe("uniqueAwsCloudWatchAlarmsTriggers", () => {
  function rb(
    id: string,
    region: string,
    names: string[],
    intervalSec: number,
  ): Runbook {
    const trigger: Runbook["trigger"] = {
      source: "aws_cloudwatch_alarms",
      region,
      transitions: ["ALARM"],
      interval_sec: intervalSec,
    };
    if (names.length > 0) trigger.alarm_names = names;
    return {
      id,
      trigger,
      agent: fakeAgent(),
      sourcePath: `/tmp/${id}.yaml`,
    };
  }

  it("dedupes by (region, sorted alarm_names)", () => {
    const out = uniqueAwsCloudWatchAlarmsTriggers([
      rb("a", "us-east-1", ["x", "y"], 60),
      rb("b", "us-east-1", ["y", "x"], 60),
      rb("c", "us-east-1", ["z"], 60),
      rb("d", "us-west-2", ["x", "y"], 60),
    ]);
    expect(out).toHaveLength(3);
  });

  it("takes min interval_sec across subscribers of the same key", () => {
    const out = uniqueAwsCloudWatchAlarmsTriggers([
      rb("a", "us-east-1", ["x"], 60),
      rb("b", "us-east-1", ["x"], 30),
      rb("c", "us-east-1", ["x"], 120),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.intervalSec).toBe(30);
  });

  it("ignores non-aws_cloudwatch_alarms runbooks", () => {
    const fileRb: Runbook = {
      id: "x",
      trigger: { source: "file", path: "/var/log/x", pattern: /./ },
      agent: fakeAgent(),
      sourcePath: "/tmp/x.yaml",
    };
    expect(uniqueAwsCloudWatchAlarmsTriggers([fileRb])).toEqual([]);
  });
});
