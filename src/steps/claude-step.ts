import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../core/logger.js";
import type { ClaudeStep, StepResult, TriggerEvent } from "../types.js";

const log = logger("step.claude");

export interface StepContext {
  event: TriggerEvent;
  capturedSteps: Record<string, string>;
}

const TEMPLATE_RE =
  /\{\{\s*(event\.line|event\.path|event\.timestamp|env\.[A-Za-z_][A-Za-z0-9_]*|steps\.[a-z0-9][a-z0-9-]*\.output)\s*\}\}/g;

// プロンプト用の直接置換テンプレ展開。bash-step の env 経由展開とは別。
// claude / claude_agent ステップで共有する。
export function substituteClaudeTemplate(text: string, ctx: StepContext): string {
  return text.replace(TEMPLATE_RE, (_raw, key: string) => {
    if (key === "event.line") return ctx.event.type === "file" ? ctx.event.content : "";
    if (key === "event.path") return ctx.event.type === "file" ? ctx.event.path : "";
    if (key === "event.timestamp") return ctx.event.timestamp;
    if (key.startsWith("env.")) return process.env[key.slice(4)] ?? "";
    if (key.startsWith("steps.") && key.endsWith(".output")) {
      const stepId = key.slice("steps.".length, -".output".length);
      return ctx.capturedSteps[stepId] ?? "";
    }
    return _raw;
  });
}

export function captureClaudeOutput(text: string): string {
  return text.replace(/\n+$/, "");
}

export async function runClaudeStep(step: ClaudeStep, ctx: StepContext): Promise<StepResult> {
  const start = Date.now();
  const prompt = substituteClaudeTemplate(step.claude.prompt, ctx);
  const system = step.claude.system ? substituteClaudeTemplate(step.claude.system, ctx) : undefined;

  const client = new Anthropic();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), step.timeout_sec * 1000);

  try {
    const response = await client.messages.create(
      {
        model: step.claude.model,
        max_tokens: step.claude.max_tokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);
    const textBlock = response.content.find((b) => b.type === "text");
    const stdout = textBlock?.type === "text" ? textBlock.text : "";
    const ok = response.stop_reason !== "max_tokens";

    log.debug(
      {
        stepId: step.id,
        stop_reason: response.stop_reason,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      "claude step done",
    );

    return {
      stepId: step.id,
      ok,
      exit_code: ok ? 0 : 1,
      signal: null,
      stdout,
      stderr: "",
      duration_ms: Date.now() - start,
      timed_out: false,
      error: ok ? null : `stop_reason: ${response.stop_reason}`,
      captured: step.capture && ok ? captureClaudeOutput(stdout) : null,
      skipped: false,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = (err as Error).name === "AbortError";
    const message = isTimeout
      ? `timeout after ${step.timeout_sec}s`
      : (err as Error).message;
    log.warn({ stepId: step.id, err: message }, "claude step error");
    return {
      stepId: step.id,
      ok: false,
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - start,
      timed_out: isTimeout,
      error: message,
      captured: null,
      skipped: false,
    };
  }
}
