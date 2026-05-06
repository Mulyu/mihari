import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-cwlogs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: cw-error
trigger:
  source: aws_cloudwatch_logs
  region: us-east-1
  log_group: /aws/lambda/myfunc
  pattern: "ERROR"
  interval_sec: 60
steps:
  - id: do-it
    bash: echo hi
`.trim();

describe("aws_cloudwatch_logs trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("aws_cloudwatch_logs");
    if (rb.trigger.source !== "aws_cloudwatch_logs") throw new Error("type narrow");
    expect(rb.trigger.region).toBe("us-east-1");
    expect(rb.trigger.log_group).toBe("/aws/lambda/myfunc");
    expect(rb.trigger.interval_sec).toBe(60);
    expect(rb.trigger.pattern?.test("ERROR something")).toBe(true);
    expect(rb.trigger.pattern?.test("INFO something")).toBe(false);
  });

  it("pattern is optional (matches everything when omitted)", () => {
    const yaml = VALID.replace(/  pattern: "ERROR"\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "aws_cloudwatch_logs") throw new Error("type narrow");
    expect(rb.trigger.pattern).toBeUndefined();
  });

  it("rejects missing region", () => {
    const yaml = VALID.replace(/  region: us-east-1\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.region/);
  });

  it("rejects missing log_group", () => {
    const yaml = VALID.replace(/  log_group: \/aws\/lambda\/myfunc\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.log_group/);
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

  it("rejects invalid pattern regex", () => {
    const yaml = VALID.replace('pattern: "ERROR"', 'pattern: "["');
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/not a valid regex/);
  });
});
