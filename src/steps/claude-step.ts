import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import type { ClaudeStep, StepContext, StepResult } from "../types.js";
import { captureStdout, substituteClaudeTemplate } from "./template.js";

const log = logger("step.claude");

// 後方互換用 re-export（claude-agent-step が捨てる経路）。
export { substituteClaudeTemplate, captureStdout as captureClaudeOutput };
export type { StepContext };

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
      captured: step.capture && ok ? captureStdout(stdout) : null,
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
