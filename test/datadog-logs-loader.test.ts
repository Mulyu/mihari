import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-ddl-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: dd-logs-checkout
trigger:
  source: datadog_logs
  site: datadoghq.com
  query: "service:checkout status:error"
  interval_sec: 60
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("datadog_logs trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("datadog_logs");
    if (rb.trigger.source !== "datadog_logs") throw new Error("type narrow");
    expect(rb.trigger.site).toBe("datadoghq.com");
    expect(rb.trigger.query).toBe("service:checkout status:error");
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("rejects missing site", () => {
    const yaml = VALID.replace(/  site: datadoghq\.com\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.site/);
  });

  it("rejects missing query", () => {
    const yaml = VALID.replace(/  query: .*\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.query/);
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
});
