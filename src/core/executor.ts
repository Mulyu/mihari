import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { runBashStep } from "../steps/bash-step.js";
import { runClaudeStep } from "../steps/claude-step.js";
import type { Runbook, RunResult, Step, StepResult, TriggerEvent } from "../types.js";
import type { StateStore } from "./state.js";

const log = logger("executor");

export interface Executor {
  execute(runbook: Runbook, event: TriggerEvent): Promise<RunResult>;
}

export function createExecutor(state: StateStore): Executor {
  return {
    execute(runbook, event) {
      return runRunbook(runbook, event, state);
    },
  };
}

async function runRunbook(
  runbook: Runbook,
  event: TriggerEvent,
  state: StateStore,
): Promise<RunResult> {
  const run_id = `run_${randomUUID().slice(0, 8)}`;
  const started_at = new Date().toISOString();
  const results: StepResult[] = [];
  const capturedSteps: Record<string, string> = {};

  log.info(
    { run_id, runbook_id: runbook.id, trigger_type: event.type },
    "runbook started",
  );

  let anyFailed = false;
  let stopped = false;
  for (const step of runbook.steps) {
    const condition = step.condition;
    const failed = anyFailed || stopped;
    // condition: undefined (default) → run unless a stop happened (preserves current behavior)
    // condition: "always"            → always run
    // condition: "on_failure"        → run only if any previous step failed
    // condition: "on_success"        → run only if no failure so far
    const shouldRun =
      condition === "always" ||
      (condition === "on_failure" && failed) ||
      (condition === "on_success" && !failed) ||
      (condition === undefined && !stopped);

    if (!shouldRun) {
      log.debug(
        { run_id, runbook_id: runbook.id, step: step.id, condition, anyFailed, stopped },
        "step skipped",
      );
      results.push({
        stepId: step.id,
        ok: true,
        exit_code: null,
        signal: null,
        stdout: "",
        stderr: "",
        duration_ms: 0,
        timed_out: false,
        error: null,
        captured: null,
        skipped: true,
      });
      continue;
    }

    const r = await runStep(step, { event, capturedSteps });
    results.push(r);
    if (r.captured !== null) capturedSteps[step.id] = r.captured;
    if (!r.ok) {
      anyFailed = true;
      log.warn(
        {
          run_id,
          runbook_id: runbook.id,
          step: step.id,
          exit_code: r.exit_code,
          timed_out: r.timed_out,
        },
        "step failed",
      );
      if (step.on_error === "stop") stopped = true;
    } else {
      log.info(
        { run_id, runbook_id: runbook.id, step: step.id, duration_ms: r.duration_ms },
        "step ok",
      );
    }
  }

  const finished_at = new Date().toISOString();

  const result: RunResult = {
    run_id,
    runbook_id: runbook.id,
    started_at,
    finished_at,
    ok: !anyFailed,
    steps: results,
    trigger_event: event,
  };
  await state.appendRunResult(result);
  log.info({ run_id, runbook_id: runbook.id, ok: !anyFailed }, "runbook finished");
  return result;
}

function runStep(
  step: Step,
  ctx: { event: TriggerEvent; capturedSteps: Record<string, string> },
): Promise<StepResult> {
  if ("claude" in step) return runClaudeStep(step, ctx);
  return runBashStep(step, ctx);
}
