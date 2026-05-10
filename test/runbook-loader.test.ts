import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRunbookFile,
  loadRunbooks,
  RunbookValidationError,
} from "../src/loader/index.js";

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
agent:
  prompt: "Investigate {{ event.line }}"
  allowed_tools:
    - Read
    - "Bash(curl:*)"
`.trim();

describe("runbook-level fields", () => {
  it("parses a valid runbook with default agent settings", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML);
    const rb = loadRunbookFile(f);
    expect(rb.id).toBe("cleanup");
    expect(rb.description).toBe("test");
    expect(rb.trigger.source).toBe("file");
    expect(rb.agent.prompt).toContain("{{ event.line }}");
    expect(rb.agent.model).toBe("claude-opus-4-7");
    expect(rb.agent.permission_mode).toBe("strict");
    expect(rb.agent.max_turns).toBe(30);
    expect(rb.agent.timeout_sec).toBe(600);
    expect(rb.agent.conventions).toBe(false);
    expect(rb.agent.providers).toEqual([]);
  });

  it("accepts enabled / cooldown_sec", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML + "\nenabled: false\ncooldown_sec: 120");
    const rb = loadRunbookFile(f);
    expect(rb.enabled).toBe(false);
    expect(rb.cooldown_sec).toBe(120);
  });

  it("rejects cooldown_sec <= 0", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML + "\ncooldown_sec: 0");
    expect(() => loadRunbookFile(f)).toThrow(/cooldown_sec must be > 0/);
  });

  it("rejects non-kebab id", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML.replace("cleanup", "Cleanup_Bad"));
    expect(() => loadRunbookFile(f)).toThrow(RunbookValidationError);
  });

  it("rejects unsupported trigger source", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML.replace("source: file", "source: webhook"));
    expect(() => loadRunbookFile(f)).toThrow(/source must be/);
  });

  it("rejects a runbook missing agent", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      `
id: x
trigger:
  source: cron
  schedule: "* * * * *"
`.trim(),
    );
    expect(() => loadRunbookFile(f)).toThrow(/"agent" is required/);
  });

  it("rejects a runbook that still has a steps: key (legacy 0.x)", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(
      f,
      VALID_YAML + `\nsteps:\n  - id: x\n    bash: echo hi\n`,
    );
    expect(() => loadRunbookFile(f)).toThrow(/"steps" was removed in 1\.0/);
  });
});

describe("agent: directive", () => {
  it("loads prompt_file relative to the runbook YAML", () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "Investigate the alert.");
    const yaml = VALID_YAML.replace(
      '  prompt: "Investigate {{ event.line }}"',
      "  prompt_file: prompt.md",
    );
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    expect(rb.agent.prompt).toBe("Investigate the alert.");
  });

  it("rejects both prompt and prompt_file", () => {
    const yaml = VALID_YAML + "\n  prompt_file: nope.md";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/both "prompt" and "prompt_file"/);
  });

  it("requires prompt or prompt_file", () => {
    const yaml = `
id: x
trigger:
  source: cron
  schedule: "* * * * *"
agent:
  allowed_tools: [Read]
`.trim();
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/must have "prompt" or "prompt_file"/);
  });

  it("requires non-empty allowed_tools", () => {
    const yaml = `
id: x
trigger:
  source: cron
  schedule: "* * * * *"
agent:
  prompt: "x"
  allowed_tools: []
`.trim();
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/at least one tool/);
  });

  it("rejects unknown permission_mode", () => {
    const yaml = VALID_YAML + "\n  permission_mode: ask";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/permission_mode must be/);
  });

  it("rejects relative cwd", () => {
    const yaml = VALID_YAML + "\n  cwd: ./relative";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/cwd must be an absolute path/);
  });

  it("rejects max_turns <= 0", () => {
    const yaml = VALID_YAML + "\n  max_turns: 0";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/max_turns must be > 0/);
  });

  it("rejects timeout_sec <= 0", () => {
    const yaml = VALID_YAML + "\n  timeout_sec: 0";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/timeout_sec must be > 0/);
  });

  it("rejects non-boolean conventions", () => {
    const yaml = VALID_YAML + '\n  conventions: "yes"';
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/conventions must be a boolean/);
  });
});

describe("agent.providers", () => {
  it("accepts supported provider literals", () => {
    const yaml = VALID_YAML + "\n  providers: [datadog, jira, slack]";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    const rb = loadRunbookFile(f);
    expect(rb.agent.providers).toEqual(["datadog", "jira", "slack"]);
  });

  it("rejects unknown provider", () => {
    const yaml = VALID_YAML + "\n  providers: [pagerduty]";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/providers\[0\] must be one of/);
  });

  it("rejects duplicate providers", () => {
    const yaml = VALID_YAML + "\n  providers: [jira, jira]";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/duplicate/);
  });

  it("rejects non-string entries", () => {
    const yaml = VALID_YAML + "\n  providers: [42]";
    const f = join(dir, "rb.yaml");
    writeFileSync(f, yaml);
    expect(() => loadRunbookFile(f)).toThrow(/providers\[0\] must be a string/);
  });

  it("defaults to []", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_YAML);
    const rb = loadRunbookFile(f);
    expect(rb.agent.providers).toEqual([]);
  });
});

describe("cron triggers", () => {
  const VALID_CRON = `
id: hourly-check
trigger:
  source: cron
  schedule: "0 * * * *"
agent:
  prompt: "ping"
  allowed_tools: [Read, "Bash(curl:*)"]
`.trim();

  it("loads a valid cron trigger", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CRON);
    const rb = loadRunbookFile(f);
    expect(rb.trigger.source).toBe("cron");
  });

  it("rejects invalid cron expressions", () => {
    const f = join(dir, "rb.yaml");
    writeFileSync(f, VALID_CRON.replace('"0 * * * *"', '"not a cron"'));
    expect(() => loadRunbookFile(f)).toThrow(/not a valid cron/);
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
