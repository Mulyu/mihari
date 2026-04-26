import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRunbookFile,
  loadRunbooks,
  RunbookValidationError,
} from "../src/core/runbook-loader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mihari-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_YAML = `
id: cleanup
description: test
trigger:
  source: file
  path: /var/log/myapp.log
  pattern: "ERROR.*disk full"
steps:
  - id: do-it
    bash: echo hi
`.trim();

describe("loadRunbookFile", () => {
  it("parses a valid runbook", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML);
    const rb = loadRunbookFile(f);
    expect(rb.id).toBe("cleanup");
    expect(rb.trigger.source).toBe("file");
    expect(rb.trigger.path).toBe("/var/log/myapp.log");
    expect(rb.trigger.pattern.test("ERROR: disk full now")).toBe(true);
    expect(rb.steps).toHaveLength(1);
    expect(rb.steps[0]?.bash).toBe("echo hi");
    expect(rb.steps[0]?.timeout_sec).toBe(60);
    expect(rb.steps[0]?.on_error).toBe("stop");
    expect(rb.steps[0]?.capture).toBe(false);
  });

  it("accepts capture: true and surfaces it on the step", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID_YAML.replace("    bash: echo hi", "    bash: echo hi\n    capture: true"),
    );
    const rb = loadRunbookFile(f);
    expect(rb.steps[0]?.capture).toBe(true);
  });

  it("rejects non-boolean capture", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID_YAML.replace("    bash: echo hi", "    bash: echo hi\n    capture: \"yes\""),
    );
    expect(() => loadRunbookFile(f)).toThrow(/capture must be a boolean/);
  });

  it("rejects non-kebab id", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML.replace("cleanup", "Cleanup_Bad"));
    expect(() => loadRunbookFile(f)).toThrow(RunbookValidationError);
  });

  it("rejects unsupported source", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML.replace("source: file", "source: datadog"));
    expect(() => loadRunbookFile(f)).toThrow(/source must be "file"/);
  });

  it("rejects invalid regex", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML.replace('"ERROR.*disk full"', '"["'));
    expect(() => loadRunbookFile(f)).toThrow(/not a valid regex/);
  });

  it("rejects empty steps", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      `
id: cleanup
trigger:
  source: file
  path: /tmp/x
  pattern: x
steps: []
`.trim(),
    );
    expect(() => loadRunbookFile(f)).toThrow(/non-empty array/);
  });

  it("rejects step with non-bash", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      `
id: cleanup
trigger:
  source: file
  path: /tmp/x
  pattern: x
steps:
  - id: x
    claude:
      prompt: hi
`.trim(),
    );
    expect(() => loadRunbookFile(f)).toThrow(/bash/);
  });

  it("rejects duplicate step ids", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      `
id: cleanup
trigger:
  source: file
  path: /tmp/x
  pattern: x
steps:
  - id: a
    bash: echo 1
  - id: a
    bash: echo 2
`.trim(),
    );
    expect(() => loadRunbookFile(f)).toThrow(/duplicate step id/);
  });
});

describe("cron triggers", () => {
  const VALID_CRON = `
id: hourly-check
trigger:
  source: cron
  schedule: "0 * * * *"
steps:
  - id: probe
    bash: curl -fsS https://example.com/health
`.trim();

  it("loads a valid cron trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CRON);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("cron");
    if (rb.trigger.source === "cron") {
      expect(rb.trigger.schedule).toBe("0 * * * *");
    }
  });

  it("rejects invalid cron expressions", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CRON.replace('"0 * * * *"', '"not a cron"'));
    expect(() => loadRunbookFile(f)).toThrow(/not a valid cron/);
  });

  it("rejects unsupported source", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CRON.replace("source: cron", "source: webhook"));
    expect(() => loadRunbookFile(f)).toThrow(/source must be/);
  });
});

describe("loadRunbooks", () => {
  it("loads all yaml files in a dir, ignores non-yaml", () => {
    writeFileSync(join(dir, "a.yaml"), VALID_YAML.replace("cleanup", "first"));
    writeFileSync(join(dir, "b.yml"), VALID_YAML.replace("cleanup", "second"));
    writeFileSync(join(dir, "README.md"), "# nope");
    const rbs = loadRunbooks(dir);
    expect(rbs.map((r) => r.id).sort()).toEqual(["first", "second"]);
  });

  it("rejects duplicate runbook ids", () => {
    writeFileSync(join(dir, "a.yaml"), VALID_YAML);
    writeFileSync(join(dir, "b.yaml"), VALID_YAML);
    expect(() => loadRunbooks(dir)).toThrow(/duplicate runbook id/);
  });
});
