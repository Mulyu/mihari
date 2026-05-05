import { logger } from "../core/logger.js";
import type { ClaudeAgentStep, StepResult } from "../types.js";
import {
  captureClaudeOutput,
  substituteClaudeTemplate,
  type StepContext,
} from "./claude-step.js";

const log = logger("step.claude-agent");

// allowed_tools エントリと実際の tool 呼び出しを照合する。
// "Read" / "Edit" などはツール名一致。
// "Bash(git status)" はコマンド完全一致、"Bash(git push:*)" は "git push" もしくは
// "git push <args>" にマッチ（: の前までを prefix として比較）。
export function matchesAllowedTools(
  toolName: string,
  input: Record<string, unknown>,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p === toolName) return true;
    const m = /^([A-Za-z][A-Za-z0-9]*)\((.+)\)$/.exec(p);
    if (!m) continue;
    if (m[1] !== toolName) continue;
    if (toolName !== "Bash") continue;
    const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
    const spec = m[2] as string;
    if (spec.endsWith(":*")) {
      const prefix = spec.slice(0, -2);
      if (command === prefix || command.startsWith(prefix + " ")) return true;
    } else if (spec === command) {
      return true;
    }
  }
  return false;
}

export async function runClaudeAgentStep(
  step: ClaudeAgentStep,
  ctx: StepContext,
): Promise<StepResult> {
  const start = Date.now();
  const prompt = substituteClaudeTemplate(step.claude_agent.prompt, ctx);
  const system = step.claude_agent.system
    ? substituteClaudeTemplate(step.claude_agent.system, ctx)
    : undefined;

  const allowed = step.claude_agent.allowed_tools;
  const pm = step.claude_agent.permission_mode;
  const cwd = step.claude_agent.cwd ?? process.cwd();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), step.timeout_sec * 1000);

  let stdout = "";
  let ok = false;
  let errorMessage: string | null = null;
  let timedOut = false;

  try {
    // 動的 import は try 内に置く: 未インストール / プラットフォーム非対応 等の load 失敗を
    // ステップ単位の StepResult として扱い、ランブック全体を巻き込まないようにする。
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // strict: SDK 標準の権限フローを起動させず、canUseTool で全 tool 呼び出しを判定する。
    // acceptEdits を使うと Edit/Write 等が canUseTool より先に auto-approve されてしまい、
    // allowed_tools に Edit/Write を載せていない runbook（read-only 用途）でファイル変更を許してしまう。
    const sdkPermissionMode = pm === "bypass" ? "bypassPermissions" : "default";
    const baseOptions: Record<string, unknown> = {
      cwd,
      model: step.claude_agent.model,
      abortController: controller,
      permissionMode: sdkPermissionMode,
      allowedTools: allowed,
    };
    if (step.claude_agent.max_turns !== undefined)
      baseOptions["maxTurns"] = step.claude_agent.max_turns;
    if (system !== undefined) {
      // claude_code preset の上に append する形で system 指示を追加する。
      baseOptions["systemPrompt"] = { type: "preset", preset: "claude_code", append: system };
    }
    if (pm === "bypass") {
      baseOptions["allowDangerouslySkipPermissions"] = true;
    } else {
      // strict: allowed_tools に無い tool 呼び出しは fail-closed で deny する。
      // headless 実行で permission prompt によりブロックされない保証も兼ねる。
      baseOptions["canUseTool"] = async (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        if (matchesAllowedTools(toolName, input, allowed)) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return {
          behavior: "deny" as const,
          message: `tool ${toolName} not in allowed_tools`,
        };
      };
    }

    // SDK の Options 型は exactOptionalPropertyTypes と相性が悪い optional 多数を持つので、
    // 構築済みのプレーンオブジェクトを options として渡す（型のみ as でアサート）。
    const q = query({
      prompt,
      options: baseOptions as import("@anthropic-ai/claude-agent-sdk").Options,
    });

    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          stdout = msg.result;
          ok = true;
        } else {
          ok = false;
          errorMessage = `agent ${msg.subtype}: num_turns=${msg.num_turns}`;
        }
        log.debug(
          {
            stepId: step.id,
            subtype: msg.subtype,
            num_turns: msg.num_turns,
            duration_ms: msg.duration_ms,
          },
          "claude agent step done",
        );
        break;
      }
    }
  } catch (err) {
    timedOut = (err as Error).name === "AbortError";
    errorMessage = timedOut
      ? `timeout after ${step.timeout_sec}s`
      : (err as Error).message;
    log.warn({ stepId: step.id, err: errorMessage }, "claude agent step error");
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  return {
    stepId: step.id,
    ok,
    exit_code: ok ? 0 : 1,
    signal: null,
    stdout,
    stderr: "",
    duration_ms: Date.now() - start,
    timed_out: timedOut,
    error: errorMessage,
    captured: step.capture && ok ? captureClaudeOutput(stdout) : null,
    skipped: false,
  };
}
