import { describe, expect, it, vi } from "vitest";
import type { ClaudeStep, StepContext, TriggerEvent } from "../src/types/index.js";

// Anthropic SDK をモジュールごとモックして runClaudeStep の挙動を直接検証する。
// 各テストで mockCreate.mockResolvedValueOnce / mockRejectedValueOnce を切り替える。
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

const { runClaudeStep } = await import("../src/steps/claude-step.js");

const cronEvent: TriggerEvent = {
  type: "cron",
  timestamp: "2026-04-26T00:00:00Z",
};

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    event: cronEvent,
    capturedSteps: {},
    idempotencyKey: "test-key",
    ...over,
  };
}

function step(over: Partial<ClaudeStep["claude"]> = {}): ClaudeStep {
  return {
    id: "ask",
    claude: {
      prompt: "Hello {{ event.timestamp }}",
      model: "claude-haiku-4-5",
      max_tokens: 256,
      ...over,
    },
    timeout_sec: 5,
    on_error: "stop",
    capture: false,
  };
}

function reply(stopReason: string, text = "answer") {
  return {
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("runClaudeStep: stop_reason handling", () => {
  it("treats end_turn as success", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("end_turn", "good"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe("good");
    expect(r.error).toBeNull();
  });

  it("treats stop_sequence as success", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("stop_sequence"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(true);
  });

  it("treats max_tokens as failure", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("max_tokens"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("max_tokens");
  });

  it("treats refusal as failure (no silent success)", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("refusal"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refusal");
  });

  it("treats pause_turn as failure", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("pause_turn"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pause_turn");
  });

  it("treats tool_use as failure (no tools defined for messages.create)", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("tool_use"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("tool_use");
  });
});

describe("runClaudeStep: prompt template substitution", () => {
  it("substitutes {{ event.timestamp }} in the prompt before sending", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("end_turn"));
    await runClaudeStep(step(), ctx());
    const sent = mockCreate.mock.calls[0]?.[0];
    expect(sent).toBeDefined();
    expect(sent.messages[0].content).toBe("Hello 2026-04-26T00:00:00Z");
  });

  it("substitutes templates in system as well when present", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("end_turn"));
    await runClaudeStep(step({ system: "ts={{ event.timestamp }}" }), ctx());
    const sent = mockCreate.mock.calls[0]?.[0];
    expect(sent.system).toBe("ts=2026-04-26T00:00:00Z");
  });
});

describe("runClaudeStep: capture", () => {
  it("returns trimmed text in captured when capture=true and step succeeded", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("end_turn", "answer\n\n"));
    const r = await runClaudeStep({ ...step(), capture: true }, ctx());
    expect(r.captured).toBe("answer");
  });

  it("captured is null when the step failed (refusal)", async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(reply("refusal", "won't"));
    const r = await runClaudeStep({ ...step(), capture: true }, ctx());
    expect(r.ok).toBe(false);
    expect(r.captured).toBeNull();
  });
});

describe("runClaudeStep: errors / timeout", () => {
  it("returns ok=false with the SDK error message on a thrown error", async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValueOnce(new Error("network fail"));
    const r = await runClaudeStep(step(), ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("network fail");
    expect(r.timed_out).toBe(false);
  });

  it("returns timed_out=true when the SDK throws AbortError", async () => {
    mockCreate.mockReset();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    mockCreate.mockRejectedValueOnce(abortErr);
    const r = await runClaudeStep({ ...step(), timeout_sec: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.error).toContain("timeout");
  });
});
