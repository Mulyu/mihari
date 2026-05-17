import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-jira-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: jira-watch-ops
trigger:
  source: jira_search
  base: https://example.atlassian.net
  jql: project = OPS AND status = Open
  interval_sec: 120
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("jira_search trigger loader", () => {
  it("loads a valid trigger and strips trailing slashes from base", () => {
    const yaml = VALID.replace(
      "https://example.atlassian.net",
      "https://example.atlassian.net///",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "jira_search") throw new Error("type narrow");
    expect(rb.trigger.base).toBe("https://example.atlassian.net");
    expect(rb.trigger.jql).toBe("project = OPS AND status = Open");
    expect(rb.trigger.interval_sec).toBe(120);
  });

  it("rejects non-http base", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID.replace("https://example.atlassian.net", "ftp://x"));
    expect(() => loadRunbookFile(f)).toThrow(/http\(s\) URL/);
  });

  it('rejects jql with "ORDER BY" (poller orders by updated itself)', () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID.replace(
        "jql: project = OPS AND status = Open",
        'jql: "project = OPS ORDER BY priority"',
      ),
    );
    expect(() => loadRunbookFile(f)).toThrow(/ORDER BY/);
  });

  it("rejects missing base", () => {
    const yaml = VALID.replace(/  base: .*\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.base/);
  });

  it("rejects missing jql", () => {
    const yaml = VALID.replace(/  jql: .*\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/trigger.jql/);
  });

  it("rejects missing interval_sec", () => {
    const yaml = VALID.replace(/  interval_sec: 120\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec is required/);
  });

  it("rejects non-positive interval_sec", () => {
    const yaml = VALID.replace("interval_sec: 120", "interval_sec: 0");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec must be > 0/);
  });
});
