import { spawn } from "node:child_process";
import { logger } from "../core/logger.js";
import type { BashStep, StepResult, TriggerEvent } from "../types.js";

const log = logger("step.bash");

export interface BashStepContext {
  event: TriggerEvent;
}

const TEMPLATE_RE = /\{\{\s*(event\.line|event\.path|event\.timestamp|env\.[A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function substituteTemplate(bash: string): string {
  // {{ event.line }} などはシェル展開時に環境変数経由で読む。
  // 値そのものを文字列置換すると、ログ行に `;rm -rf` 等が混ざったとき注入になる。
  return bash.replace(TEMPLATE_RE, (raw, key: string) => {
    if (key === "event.line") return '"$MIHARI_EVENT_LINE"';
    if (key === "event.path") return '"$MIHARI_EVENT_PATH"';
    if (key === "event.timestamp") return '"$MIHARI_EVENT_TIMESTAMP"';
    if (key.startsWith("env.")) return `"$${key.slice(4)}"`;
    return raw;
  });
}

export function buildEnv(
  base: NodeJS.ProcessEnv,
  step: BashStep,
  ctx: BashStepContext,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...step.env };
  // file 以外のトリガーでは line / path に意味が無いので空文字を入れる。
  env["MIHARI_EVENT_LINE"] = ctx.event.type === "file" ? ctx.event.content : "";
  env["MIHARI_EVENT_PATH"] = ctx.event.type === "file" ? ctx.event.path : "";
  env["MIHARI_EVENT_TIMESTAMP"] = ctx.event.timestamp;
  return env;
}

export async function runBashStep(step: BashStep, ctx: BashStepContext): Promise<StepResult> {
  const script = substituteTemplate(step.bash);
  const env = buildEnv(process.env, step, ctx);
  const start = Date.now();

  return await new Promise<StepResult>((resolveResult) => {
    const child = spawn("bash", ["-c", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGTERM が無視されたら強制終了
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1000);
    }, step.timeout_sec * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log.warn({ stepId: step.id, err: err.message }, "spawn error");
      resolveResult({
        stepId: step.id,
        ok: false,
        exit_code: null,
        signal: null,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
        timed_out: false,
        error: err.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      resolveResult({
        stepId: step.id,
        ok,
        exit_code: code,
        signal: signal ?? null,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
        timed_out: timedOut,
        error: timedOut ? `timeout after ${step.timeout_sec}s` : null,
      });
    });
  });
}
