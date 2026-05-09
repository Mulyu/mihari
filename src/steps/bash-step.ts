import { spawn } from "node:child_process";
import { logger } from "../lib/logger.js";
import type { BashStep, StepContext, StepResult } from "../types/index.js";
import {
  captureStdout,
  normalizeStepEnvName,
  substituteBashTemplate,
} from "./template.js";

const log = logger("step.bash");

// 後方互換用 re-export（旧 import パスを使うコード向け）。
export { captureStdout, normalizeStepEnvName, substituteBashTemplate as substituteTemplate };

export function buildEnv(
  base: NodeJS.ProcessEnv,
  step: BashStep,
  ctx: StepContext,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...step.env };
  // line / path / log_stream はトリガー種別ごとに意味が違う。該当しない型では空文字。
  if (ctx.event.type === "file") {
    env["MIHARI_EVENT_LINE"] = ctx.event.content;
    env["MIHARI_EVENT_PATH"] = ctx.event.path;
    env["MIHARI_EVENT_LOG_STREAM"] = "";
  } else if (ctx.event.type === "aws_cloudwatch_logs") {
    env["MIHARI_EVENT_LINE"] = ctx.event.message;
    env["MIHARI_EVENT_PATH"] = ctx.event.log_group;
    env["MIHARI_EVENT_LOG_STREAM"] = ctx.event.log_stream;
  } else {
    env["MIHARI_EVENT_LINE"] = "";
    env["MIHARI_EVENT_PATH"] = "";
    env["MIHARI_EVENT_LOG_STREAM"] = "";
  }
  // datadog_monitor は line/path/log_stream に対応する自然な値がないため、固有 env を別途
  // 渡してランブック側でパース不要にする（aws_cloudwatch_logs の log_stream と同じ思想）。
  if (ctx.event.type === "datadog_monitor") {
    env["MIHARI_EVENT_MONITOR_ID"] = ctx.event.monitor_id;
    env["MIHARI_EVENT_MONITOR_NAME"] = ctx.event.monitor_name;
    env["MIHARI_EVENT_FROM_STATE"] = ctx.event.from_state;
    env["MIHARI_EVENT_TO_STATE"] = ctx.event.to_state;
  } else {
    env["MIHARI_EVENT_MONITOR_ID"] = "";
    env["MIHARI_EVENT_MONITOR_NAME"] = "";
    env["MIHARI_EVENT_FROM_STATE"] = "";
    env["MIHARI_EVENT_TO_STATE"] = "";
  }
  env["MIHARI_EVENT_TIMESTAMP"] = ctx.event.timestamp;
  env["MIHARI_IDEMPOTENCY_KEY"] = ctx.idempotencyKey;
  for (const [stepId, value] of Object.entries(ctx.capturedSteps)) {
    env[`MIHARI_STEP_${normalizeStepEnvName(stepId)}`] = value;
  }
  return env;
}

export async function runBashStep(step: BashStep, ctx: StepContext): Promise<StepResult> {
  const script = substituteBashTemplate(step.bash);
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
        captured: null,
        skipped: false,
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
        captured: step.capture && ok ? captureStdout(stdout) : null,
        skipped: false,
      });
    });
  });
}
