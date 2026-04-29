import { describe, expect, it } from "vitest";
import {
  buildEnv,
  captureStdout,
  normalizeStepEnvName,
  runBashStep,
  substituteTemplate,
} from "../src/steps/bash-step.js";
import type { BashStep, TriggerEvent } from "../src/types.js";

const step = (over: Partial<BashStep> = {}): BashStep => ({
  id: "s",
  bash: "true",
  timeout_sec: 5,
  on_error: "stop",
  env: {},
  capture: false,
  ...over,
});

const fileEvent: TriggerEvent = {
  type: "file",
  path: "/var/log/app.log",
  content: 'evil "; rm -rf /"',
  timestamp: "2026-04-26T00:00:00Z",
};

const cronEvent: TriggerEvent = {
  type: "cron",
  timestamp: "2026-04-26T00:00:00Z",
};

const manualEvent: TriggerEvent = {
  type: "manual",
  timestamp: "2026-04-26T00:00:00Z",
};

describe("substituteTemplate", () => {
  it("replaces event vars with bare braced env refs (quoting is the user's job)", () => {
    expect(substituteTemplate("echo {{ event.line }}")).toBe("echo ${MIHARI_EVENT_LINE}");
    expect(substituteTemplate("p={{ event.path }} t={{ event.timestamp }}")).toBe(
      "p=${MIHARI_EVENT_PATH} t=${MIHARI_EVENT_TIMESTAMP}",
    );
  });

  it("replaces env.NAME with bare braced env ref", () => {
    expect(substituteTemplate("region={{ env.AWS_REGION }}")).toBe("region=${AWS_REGION}");
  });

  it("replaces steps.<id>.output with normalized env ref", () => {
    expect(substituteTemplate("x={{ steps.list-clusters.output }}")).toBe(
      "x=${MIHARI_STEP_LIST_CLUSTERS}",
    );
    expect(substituteTemplate("x={{ steps.foo.output }}")).toBe("x=${MIHARI_STEP_FOO}");
  });

  it("leaves unrelated braces alone", () => {
    expect(substituteTemplate("echo $X {{ unknown }} ${Y}")).toBe("echo $X {{ unknown }} ${Y}");
  });
});

describe("normalizeStepEnvName", () => {
  it("converts kebab-case ids to upper-snake env names", () => {
    expect(normalizeStepEnvName("list-clusters")).toBe("LIST_CLUSTERS");
    expect(normalizeStepEnvName("foo")).toBe("FOO");
    expect(normalizeStepEnvName("a-b-c")).toBe("A_B_C");
  });
});

describe("captureStdout", () => {
  it("strips trailing newlines like bash $(cmd)", () => {
    expect(captureStdout("hello\n")).toBe("hello");
    expect(captureStdout("hello\n\n\n")).toBe("hello");
    expect(captureStdout("a\nb\n")).toBe("a\nb");
    expect(captureStdout("nochange")).toBe("nochange");
    expect(captureStdout("")).toBe("");
  });
});

describe("buildEnv", () => {
  it("populates MIHARI_EVENT_* from a file event", () => {
    const env = buildEnv({}, step(), { event: fileEvent, capturedSteps: {} });
    expect(env["MIHARI_EVENT_LINE"]).toBe(fileEvent.content);
    expect(env["MIHARI_EVENT_PATH"]).toBe(fileEvent.path);
    expect(env["MIHARI_EVENT_TIMESTAMP"]).toBe(fileEvent.timestamp);
  });

  it("blanks line/path on a cron event but keeps timestamp", () => {
    const env = buildEnv({}, step(), { event: cronEvent, capturedSteps: {} });
    expect(env["MIHARI_EVENT_LINE"]).toBe("");
    expect(env["MIHARI_EVENT_PATH"]).toBe("");
    expect(env["MIHARI_EVENT_TIMESTAMP"]).toBe(cronEvent.timestamp);
  });

  it("blanks line/path on a manual event but keeps timestamp", () => {
    const env = buildEnv({}, step(), { event: manualEvent, capturedSteps: {} });
    expect(env["MIHARI_EVENT_LINE"]).toBe("");
    expect(env["MIHARI_EVENT_PATH"]).toBe("");
    expect(env["MIHARI_EVENT_TIMESTAMP"]).toBe(manualEvent.timestamp);
  });

  it("merges step env over base env", () => {
    const env = buildEnv({ FOO: "base" }, step({ env: { FOO: "step" } }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(env["FOO"]).toBe("step");
  });

  it("exposes captured step outputs as MIHARI_STEP_<NORMALIZED>", () => {
    const env = buildEnv({}, step(), {
      event: cronEvent,
      capturedSteps: { "list-clusters": "abc", "single": "xyz" },
    });
    expect(env["MIHARI_STEP_LIST_CLUSTERS"]).toBe("abc");
    expect(env["MIHARI_STEP_SINGLE"]).toBe("xyz");
  });
});

describe("runBashStep", () => {
  it("runs successful commands", async () => {
    const r = await runBashStep(step({ bash: "echo hello" }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("captures non-zero exit", async () => {
    const r = await runBashStep(step({ bash: "exit 7" }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(7);
  });

  it("does not interpolate event content as shell text (injection safe)", async () => {
    // The user is expected to wrap the template in double quotes; values
    // travel through env vars and never touch shell parsing as code.
    const r = await runBashStep(
      step({ bash: 'echo "{{ event.line }}"' }),
      { event: fileEvent, capturedSteps: {} },
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('evil "; rm -rf /"');
  });

  it("times out long-running commands", async () => {
    const r = await runBashStep(step({ bash: "sleep 5", timeout_sec: 1 }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
  }, 10000);

  it("returns captured=null when capture is false", async () => {
    const r = await runBashStep(step({ bash: "echo hi", capture: false }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(r.captured).toBeNull();
  });

  it("returns trimmed stdout in captured when capture is true", async () => {
    const r = await runBashStep(step({ bash: "echo hi", capture: true }), {
      event: cronEvent,
      capturedSteps: {},
    });
    expect(r.captured).toBe("hi");
  });

  it("captured is null when the step fails (do not propagate broken output)", async () => {
    const r = await runBashStep(
      step({ bash: "echo broken && exit 1", capture: true }),
      { event: cronEvent, capturedSteps: {} },
    );
    expect(r.ok).toBe(false);
    expect(r.captured).toBeNull();
  });

  it("subsequent step can read previous capture via {{ steps.<id>.output }}", async () => {
    // Wrap the template in double quotes to preserve embedded whitespace.
    const r = await runBashStep(
      step({ id: "user", bash: 'echo "user={{ steps.list-clusters.output }}"' }),
      {
        event: cronEvent,
        capturedSteps: { "list-clusters": "alpha\nbeta" },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("user=alpha\nbeta");
  });
});
