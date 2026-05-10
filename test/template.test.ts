import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureStdout,
  normalizeStepEnvName,
  substituteBashTemplate,
  substituteClaudeTemplate,
} from "../src/steps/template.js";
import type { StepContext, TriggerEvent } from "../src/types/index.js";

const fileEvent: TriggerEvent = {
  type: "file",
  path: "/var/log/app.log",
  content: "ERROR: db down",
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

const cwEvent: TriggerEvent = {
  type: "aws_cloudwatch_logs",
  region: "us-east-1",
  log_group: "/aws/lambda/x",
  log_stream: "stream-1",
  message: "ERROR boom",
  event_id: "e1",
  timestamp: "2026-04-26T00:00:00Z",
  timestamp_ms: 1745625600000,
};

const ddEvent: TriggerEvent = {
  type: "datadog_monitor",
  site: "datadoghq.com",
  monitor_tags: ["env:prod"],
  monitor_id: "12345",
  monitor_name: "high-error-rate",
  from_state: "ok",
  to_state: "alert",
  timestamp: "2026-05-09T12:00:00Z",
};

function ctx(event: TriggerEvent, capturedSteps: Record<string, string> = {}): StepContext {
  return { event, capturedSteps, idempotencyKey: "abc123def456" };
}

describe("substituteBashTemplate", () => {
  it("rewrites all event placeholders to bare braced env refs", () => {
    expect(
      substituteBashTemplate(
        "L={{ event.line }} P={{ event.path }} T={{ event.timestamp }} S={{ event.log_stream }}",
      ),
    ).toBe(
      "L=${MIHARI_EVENT_LINE} P=${MIHARI_EVENT_PATH} T=${MIHARI_EVENT_TIMESTAMP} S=${MIHARI_EVENT_LOG_STREAM}",
    );
  });

  it("rewrites datadog_monitor placeholders to their env refs", () => {
    expect(
      substituteBashTemplate(
        "id={{ event.monitor_id }} name={{ event.monitor_name }} {{ event.from_state }}->{{ event.to_state }}",
      ),
    ).toBe(
      "id=${MIHARI_EVENT_MONITOR_ID} name=${MIHARI_EVENT_MONITOR_NAME} ${MIHARI_EVENT_FROM_STATE}->${MIHARI_EVENT_TO_STATE}",
    );
  });
});

describe("substituteClaudeTemplate: event.line", () => {
  it("expands to file content for a file event", () => {
    expect(substituteClaudeTemplate("got: {{ event.line }}", ctx(fileEvent))).toBe(
      "got: ERROR: db down",
    );
  });

  it("expands to message for an aws_cloudwatch_logs event", () => {
    expect(substituteClaudeTemplate("got: {{ event.line }}", ctx(cwEvent))).toBe(
      "got: ERROR boom",
    );
  });

  it("expands to empty string for cron / manual / datadog_monitor", () => {
    expect(substituteClaudeTemplate("[{{ event.line }}]", ctx(cronEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.line }}]", ctx(manualEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.line }}]", ctx(ddEvent))).toBe("[]");
  });
});

describe("substituteClaudeTemplate: event.path", () => {
  it("expands to file path for a file event", () => {
    expect(substituteClaudeTemplate("p={{ event.path }}", ctx(fileEvent))).toBe(
      "p=/var/log/app.log",
    );
  });

  it("expands to log_group for an aws_cloudwatch_logs event", () => {
    expect(substituteClaudeTemplate("p={{ event.path }}", ctx(cwEvent))).toBe(
      "p=/aws/lambda/x",
    );
  });

  it("expands to empty string for cron / manual / datadog_monitor", () => {
    expect(substituteClaudeTemplate("[{{ event.path }}]", ctx(cronEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.path }}]", ctx(manualEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.path }}]", ctx(ddEvent))).toBe("[]");
  });
});

describe("substituteClaudeTemplate: event.timestamp", () => {
  it("always expands to event.timestamp regardless of trigger type", () => {
    for (const event of [fileEvent, cronEvent, manualEvent, cwEvent, ddEvent]) {
      expect(substituteClaudeTemplate("t={{ event.timestamp }}", ctx(event))).toBe(
        `t=${event.timestamp}`,
      );
    }
  });
});

describe("substituteClaudeTemplate: event.log_stream", () => {
  it("expands to log_stream only for aws_cloudwatch_logs events", () => {
    expect(substituteClaudeTemplate("s={{ event.log_stream }}", ctx(cwEvent))).toBe(
      "s=stream-1",
    );
  });

  it("expands to empty string for non-cw events", () => {
    expect(substituteClaudeTemplate("[{{ event.log_stream }}]", ctx(fileEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.log_stream }}]", ctx(cronEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.log_stream }}]", ctx(manualEvent))).toBe("[]");
    expect(substituteClaudeTemplate("[{{ event.log_stream }}]", ctx(ddEvent))).toBe("[]");
  });
});

describe("substituteClaudeTemplate: datadog_monitor placeholders", () => {
  it("expands monitor_id / monitor_name / from_state / to_state for a datadog_monitor event", () => {
    const text =
      "id={{ event.monitor_id }} name={{ event.monitor_name }} {{ event.from_state }}->{{ event.to_state }}";
    expect(substituteClaudeTemplate(text, ctx(ddEvent))).toBe(
      "id=12345 name=high-error-rate ok->alert",
    );
  });

  it("expands datadog placeholders to empty string for non-datadog events", () => {
    const text = "[{{ event.monitor_id }}|{{ event.monitor_name }}|{{ event.from_state }}|{{ event.to_state }}]";
    expect(substituteClaudeTemplate(text, ctx(fileEvent))).toBe("[|||]");
    expect(substituteClaudeTemplate(text, ctx(cwEvent))).toBe("[|||]");
    expect(substituteClaudeTemplate(text, ctx(cronEvent))).toBe("[|||]");
    expect(substituteClaudeTemplate(text, ctx(manualEvent))).toBe("[|||]");
  });
});

describe("substituteClaudeTemplate: env.NAME", () => {
  beforeEach(() => {
    process.env["MIHARI_TEST_VAR"] = "from-env";
    delete process.env["MIHARI_TEST_MISSING"];
  });

  afterEach(() => {
    delete process.env["MIHARI_TEST_VAR"];
  });

  it("reads from process.env when the var is set", () => {
    expect(substituteClaudeTemplate("v={{ env.MIHARI_TEST_VAR }}", ctx(cronEvent))).toBe(
      "v=from-env",
    );
  });

  it("expands to empty string when the env var is missing", () => {
    expect(substituteClaudeTemplate("v=[{{ env.MIHARI_TEST_MISSING }}]", ctx(cronEvent))).toBe(
      "v=[]",
    );
  });
});

describe("substituteClaudeTemplate: steps.<id>.output", () => {
  it("expands to the captured output of a previous step", () => {
    const c = ctx(cronEvent, { "list-clusters": "a\nb\nc", solo: "x" });
    expect(substituteClaudeTemplate("v={{ steps.list-clusters.output }}", c)).toBe(
      "v=a\nb\nc",
    );
    expect(substituteClaudeTemplate("v={{ steps.solo.output }}", c)).toBe("v=x");
  });

  it("expands to empty string when the step did not capture", () => {
    expect(substituteClaudeTemplate("v=[{{ steps.missing.output }}]", ctx(cronEvent))).toBe(
      "v=[]",
    );
  });
});

describe("substituteClaudeTemplate: unknown braces", () => {
  it("leaves unrelated braces alone", () => {
    expect(substituteClaudeTemplate("hello {{ unknown }} world", ctx(cronEvent))).toBe(
      "hello {{ unknown }} world",
    );
  });
});

describe("normalizeStepEnvName / captureStdout (re-coverage)", () => {
  it("normalizeStepEnvName converts kebab-case to UPPER_SNAKE", () => {
    expect(normalizeStepEnvName("list-clusters")).toBe("LIST_CLUSTERS");
  });

  it("captureStdout strips trailing newlines like bash $(cmd)", () => {
    expect(captureStdout("hi\n\n")).toBe("hi");
    expect(captureStdout("a\nb")).toBe("a\nb");
  });
});
