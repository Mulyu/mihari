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

  it("accepts enabled: false", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML + "\nenabled: false");
    const rb = loadRunbookFile(f);
    expect(rb.enabled).toBe(false);
  });

  it("defaults enabled to undefined (truthy)", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML);
    const rb = loadRunbookFile(f);
    expect(rb.enabled).toBeUndefined();
  });

  it("accepts cooldown_sec", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML + "\ncooldown_sec: 120");
    const rb = loadRunbookFile(f);
    expect(rb.cooldown_sec).toBe(120);
  });

  it("rejects cooldown_sec <= 0", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML + "\ncooldown_sec: 0");
    expect(() => loadRunbookFile(f)).toThrow(/cooldown_sec must be > 0/);
  });

  it("accepts step condition: on_failure", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID_YAML.replace("    bash: echo hi", "    bash: echo hi\n    condition: on_failure"),
    );
    const rb = loadRunbookFile(f);
    expect(rb.steps[0]?.condition).toBe("on_failure");
  });

  it("rejects unknown step condition", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID_YAML.replace("    bash: echo hi", "    bash: echo hi\n    condition: maybe"),
    );
    expect(() => loadRunbookFile(f)).toThrow(/condition must be/);
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

  it("rejects step with unsupported type", () => {
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
    webhook:
      url: https://example.com
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

describe("claude steps", () => {
  const VALID_CLAUDE = `
id: analyze
trigger:
  source: file
  path: /var/log/app.log
  pattern: "ERROR"
steps:
  - id: ask
    claude:
      prompt: "What does this mean: {{ event.line }}"
`.trim();

  it("loads a valid claude step with inline prompt", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CLAUDE);
    const rb = loadRunbookFile(f);
    expect(rb.steps).toHaveLength(1);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.claude.prompt).toContain("{{ event.line }}");
    expect(step.claude.model).toBe("claude-opus-4-7");
    expect(step.claude.max_tokens).toBe(1024);
    expect(step.timeout_sec).toBe(60);
    expect(step.on_error).toBe("stop");
    expect(step.capture).toBe(false);
  });

  it("loads claude step with prompt_file", () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "Analyze this error.");
    const yaml = VALID_CLAUDE.replace(
      '      prompt: "What does this mean: {{ event.line }}"',
      "      prompt_file: prompt.md",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.claude.prompt).toBe("Analyze this error.");
  });

  it("loads claude step with system", () => {
    const yaml = VALID_CLAUDE + "\n      system: You are an expert.";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.claude.system).toBe("You are an expert.");
  });

  it("loads claude step with system_file", () => {
    const sysFile = join(dir, "system.md");
    writeFileSync(sysFile, "You are a DevOps expert.");
    const yaml = VALID_CLAUDE + "\n      system_file: system.md";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.claude.system).toBe("You are a DevOps expert.");
  });

  it("rejects both prompt and prompt_file", () => {
    const yaml = VALID_CLAUDE + "\n      prompt_file: nope.md";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/both "prompt" and "prompt_file"/);
  });

  it("rejects both system and system_file", () => {
    const yaml = VALID_CLAUDE + "\n      system: hi\n      system_file: nope.md";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/both "system" and "system_file"/);
  });

  it("rejects prompt_file that does not exist", () => {
    const yaml = VALID_CLAUDE.replace(
      '      prompt: "What does this mean: {{ event.line }}"',
      "      prompt_file: no-such-file.md",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/cannot read file/);
  });

  it("accepts custom model and max_tokens", () => {
    const yaml =
      VALID_CLAUDE + "\n      model: claude-haiku-4-5\n      max_tokens: 512";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.claude.model).toBe("claude-haiku-4-5");
    expect(step.claude.max_tokens).toBe(512);
  });

  it("accepts capture: true on claude step", () => {
    const yaml = VALID_CLAUDE + "\n    capture: true";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.capture).toBe(true);
  });

  it("accepts condition on claude step", () => {
    const yaml = VALID_CLAUDE + "\n    condition: on_failure";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    const step = rb.steps[0];
    if (!step || !("claude" in step)) throw new Error("expected claude step");
    expect(step.condition).toBe("on_failure");
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
