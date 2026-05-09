import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-dd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: dd-monitor-alert
trigger:
  source: datadog_monitors
  site: datadoghq.com
  monitor_tags:
    - "env:prod"
    - "service:web"
  transitions:
    - alert
    - warn
  interval_sec: 60
steps:
  - id: do-it
    bash: echo hi
`.trim();

describe("datadog_monitors trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("datadog_monitors");
    if (rb.trigger.source !== "datadog_monitors") throw new Error("type narrow");
    expect(rb.trigger.site).toBe("datadoghq.com");
    expect(rb.trigger.monitor_tags).toEqual(["env:prod", "service:web"]);
    expect(rb.trigger.transitions).toEqual(["alert", "warn"]);
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("monitor_tags is optional", () => {
    const yaml = VALID.replace(
      /  monitor_tags:\n    - "env:prod"\n    - "service:web"\n/,
      "",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "datadog_monitors") throw new Error("type narrow");
    expect(rb.trigger.monitor_tags).toBeUndefined();
  });

  it("transitions defaults to ['alert'] when omitted", () => {
    const yaml = VALID.replace(/  transitions:\n    - alert\n    - warn\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "datadog_monitors") throw new Error("type narrow");
    expect(rb.trigger.transitions).toEqual(["alert"]);
  });

  it("rejects missing site", () => {
    const yaml = VALID.replace(/  site: datadoghq\.com\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.site/);
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

  it("rejects empty transitions list", () => {
    const yaml = VALID.replace(
      /  transitions:\n    - alert\n    - warn\n/,
      "  transitions: []\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/non-empty array/);
  });

  it("rejects unknown transition state", () => {
    const yaml = VALID.replace(
      /  transitions:\n    - alert\n    - warn\n/,
      "  transitions:\n    - alert\n    - bogus\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/transitions entries must be one of/);
  });

  it("rejects monitor_tags with non-string entries", () => {
    const yaml = VALID.replace(
      /  monitor_tags:\n    - "env:prod"\n    - "service:web"\n/,
      "  monitor_tags:\n    - 42\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/monitor_tags entries/);
  });
});
