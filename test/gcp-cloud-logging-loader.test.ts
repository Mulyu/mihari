import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-gcp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: gcp-error-triage
trigger:
  source: gcp_cloud_logging
  project_id: my-project
  filter: 'severity>=ERROR resource.type="cloud_function"'
  interval_sec: 60
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("gcp_cloud_logging trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "gcp_cloud_logging") throw new Error("type narrow");
    expect(rb.trigger.project_id).toBe("my-project");
    expect(rb.trigger.filter).toBe('severity>=ERROR resource.type="cloud_function"');
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("rejects missing project_id", () => {
    const yaml = VALID.replace(/  project_id: my-project\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.project_id/);
  });

  it("rejects missing filter", () => {
    const yaml = VALID.replace(/  filter: .*\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.filter/);
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
