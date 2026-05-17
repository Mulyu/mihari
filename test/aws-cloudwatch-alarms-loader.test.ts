import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-cwa-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: cw-alarm-fire
trigger:
  source: aws_cloudwatch_alarms
  region: us-east-1
  alarm_names:
    - prod-checkout-5xx
    - prod-payments-latency
  transitions:
    - ALARM
    - OK
  interval_sec: 60
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("aws_cloudwatch_alarms trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("aws_cloudwatch_alarms");
    if (rb.trigger.source !== "aws_cloudwatch_alarms") throw new Error("type narrow");
    expect(rb.trigger.region).toBe("us-east-1");
    expect(rb.trigger.alarm_names).toEqual(["prod-checkout-5xx", "prod-payments-latency"]);
    expect(rb.trigger.transitions).toEqual(["ALARM", "OK"]);
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("alarm_names is optional (omitting = subscribe to all in region)", () => {
    const yaml = VALID.replace(
      /  alarm_names:\n    - prod-checkout-5xx\n    - prod-payments-latency\n/,
      "",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "aws_cloudwatch_alarms") throw new Error("type narrow");
    expect(rb.trigger.alarm_names).toBeUndefined();
  });

  it("transitions defaults to ['ALARM'] when omitted", () => {
    const yaml = VALID.replace(/  transitions:\n    - ALARM\n    - OK\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "aws_cloudwatch_alarms") throw new Error("type narrow");
    expect(rb.trigger.transitions).toEqual(["ALARM"]);
  });

  it("rejects missing region", () => {
    const yaml = VALID.replace(/  region: us-east-1\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.region/);
  });

  it("rejects missing interval_sec", () => {
    const yaml = VALID.replace(/  interval_sec: 60\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec is required/);
  });

  it("rejects non-positive interval_sec", () => {
    const yaml = VALID.replace("interval_sec: 60", "interval_sec: 0");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec must be > 0/);
  });

  it("rejects unknown transition state (lowercase or invented)", () => {
    const yaml = VALID.replace(
      /  transitions:\n    - ALARM\n    - OK\n/,
      "  transitions:\n    - ALARM\n    - alert\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/transitions entries must be one of/);
  });

  it("rejects alarm_names with non-string entries", () => {
    const yaml = VALID.replace(
      /  alarm_names:\n    - prod-checkout-5xx\n    - prod-payments-latency\n/,
      "  alarm_names:\n    - 42\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/alarm_names entries/);
  });
});
