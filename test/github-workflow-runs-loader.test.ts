import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunbookFile } from "../src/loader/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-gh-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `
id: ci-failure-fix
trigger:
  source: github_workflow_runs
  repo: example/app
  branch: main
  workflows:
    - ci.yml
  conclusions:
    - failure
    - cancelled
  interval_sec: 60
agent:
  prompt: "noop"
  allowed_tools: [Read]
`.trim();

describe("github_workflow_runs trigger loader", () => {
  it("loads a valid trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "github_workflow_runs") throw new Error("type narrow");
    expect(rb.trigger.repo).toBe("example/app");
    expect(rb.trigger.branch).toBe("main");
    expect(rb.trigger.workflows).toEqual(["ci.yml"]);
    expect(rb.trigger.conclusions).toEqual(["failure", "cancelled"]);
    expect(rb.trigger.interval_sec).toBe(60);
  });

  it("conclusions defaults to ['failure'] when omitted", () => {
    const yaml = VALID.replace(/  conclusions:\n    - failure\n    - cancelled\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "github_workflow_runs") throw new Error("type narrow");
    expect(rb.trigger.conclusions).toEqual(["failure"]);
  });

  it("branch and workflows are optional", () => {
    const yaml = VALID.replace(/  branch: main\n/, "").replace(
      /  workflows:\n    - ci\.yml\n/,
      "",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    if (rb.trigger.source !== "github_workflow_runs") throw new Error("type narrow");
    expect(rb.trigger.branch).toBeUndefined();
    expect(rb.trigger.workflows).toBeUndefined();
  });

  it('rejects malformed repo (must be "owner/repo")', () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID.replace("repo: example/app", "repo: example"));
    expect(() => loadRunbookFile(f)).toThrow(/owner\/repo/);
  });

  it("rejects unknown conclusion literal", () => {
    const yaml = VALID.replace(
      /  conclusions:\n    - failure\n    - cancelled\n/,
      "  conclusions:\n    - bogus\n",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/conclusions entries must be one of/);
  });

  it("rejects missing interval_sec", () => {
    const yaml = VALID.replace(/  interval_sec: 60\n/, "");
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/interval_sec is required/);
  });
});
