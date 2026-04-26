import { describe, expect, it } from "vitest";
import { buildEnv, runBashStep, substituteTemplate } from "../src/steps/bash-step.js";
import type { BashStep, LogLine } from "../src/types.js";

const step = (over: Partial<BashStep> = {}): BashStep => ({
  id: "s",
  bash: "true",
  timeout_sec: 5,
  on_error: "stop",
  env: {},
  ...over,
});

const line: LogLine = {
  path: "/var/log/app.log",
  content: 'evil "; rm -rf /"',
  timestamp: "2026-04-26T00:00:00Z",
};

describe("substituteTemplate", () => {
  it("replaces event vars with quoted env refs", () => {
    expect(substituteTemplate("echo {{ event.line }}")).toBe('echo "$MIHARI_EVENT_LINE"');
    expect(substituteTemplate("p={{ event.path }} t={{ event.timestamp }}")).toBe(
      'p="$MIHARI_EVENT_PATH" t="$MIHARI_EVENT_TIMESTAMP"',
    );
  });

  it("replaces env.NAME with quoted env ref", () => {
    expect(substituteTemplate("region={{ env.AWS_REGION }}")).toBe('region="$AWS_REGION"');
  });

  it("leaves unrelated braces alone", () => {
    expect(substituteTemplate("echo $X {{ unknown }} ${Y}")).toBe("echo $X {{ unknown }} ${Y}");
  });
});

describe("buildEnv", () => {
  it("populates MIHARI_EVENT_* from the event", () => {
    const env = buildEnv({}, step(), { event: line });
    expect(env["MIHARI_EVENT_LINE"]).toBe(line.content);
    expect(env["MIHARI_EVENT_PATH"]).toBe(line.path);
    expect(env["MIHARI_EVENT_TIMESTAMP"]).toBe(line.timestamp);
  });

  it("merges step env over base env", () => {
    const env = buildEnv({ FOO: "base" }, step({ env: { FOO: "step" } }), { event: null });
    expect(env["FOO"]).toBe("step");
  });
});

describe("runBashStep", () => {
  it("runs successful commands", async () => {
    const r = await runBashStep(step({ bash: "echo hello" }), { event: null });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("captures non-zero exit", async () => {
    const r = await runBashStep(step({ bash: "exit 7" }), { event: null });
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(7);
  });

  it("does not interpolate event content as shell text (injection safe)", async () => {
    const r = await runBashStep(
      step({ bash: "echo {{ event.line }}" }),
      { event: line },
    );
    expect(r.ok).toBe(true);
    // The literal string from the log line is echoed back, not executed.
    expect(r.stdout).toContain('evil "; rm -rf /"');
  });

  it("times out long-running commands", async () => {
    const r = await runBashStep(step({ bash: "sleep 5", timeout_sec: 1 }), { event: null });
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
  }, 10000);
});
