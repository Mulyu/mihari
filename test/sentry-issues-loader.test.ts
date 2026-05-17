import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-sentry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: sentry-error-page
trigger:
  source: sentry_issues
  base: https://sentry.io
  organization: my-org
  project: my-project
  levels:
    - error
    - fatal
  interval_sec: 60
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("sentry_issues trigger loader", () => {
  it("loads a valid trigger and strips trailing slashes from base", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID.replace("https://sentry.io", "https://sentry.io//"));
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "sentry_issues") throw new Error("type narrow");
    expect(rb.trigger.base).toBe("https://sentry.io");
    expect(rb.trigger.organization).toBe("my-org");
    expect(rb.trigger.project).toBe("my-project");
    expect(rb.trigger.levels).toEqual(["error", "fatal"]);
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("levels defaults to ['error', 'fatal']", () => {
    const yaml = VALID.replace(/  levels:\n    - error\n    - fatal\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "sentry_issues") throw new Error("type narrow");
    expect(rb.trigger.levels).toEqual(["error", "fatal"]);
  });

  it("rejects non-http base", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID.replace("https://sentry.io", "ftp://x"));
    expect(() => loadRunbookFile(f)).toThrow(/http\(s\) URL/);
  });

  it("rejects unknown level", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID.replace(/  levels:\n    - error\n    - fatal\n/, "  levels:\n    - bogus\n"));
    expect(() => loadRunbookFile(f)).toThrow(/levels entries must be one of/);
  });

  it("rejects missing organization", () => {
    const yaml = VALID.replace(/  organization: my-org\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.organization/);
  });

  it("rejects missing project", () => {
    const yaml = VALID.replace(/  project: my-project\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.project/);
  });

  it("rejects missing interval_sec", () => {
    const yaml = VALID.replace(/  interval_sec: 60\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec is required/);
  });
});
