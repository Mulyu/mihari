import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { runBashStep } from "../steps/bash-step.js";
import type { Runbook, RunResult, StepResult, TriggerEvent } from "../types.js";
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

  log.info(
    { run_id, runbook_id: runbook.id, trigger_type: event.type },
    "runbook started",
  );

  let allOk = true;
  for (const step of runbook.steps) {
    const r = await runBashStep(step, { event });
    results.push(r);
    if (!r.ok) {
      allOk = false;
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
      if (step.on_error === "stop") break;
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
    ok: allOk,
    steps: results,
    trigger_event: event,
  };
  await state.appendRunResult(result);
  log.info({ run_id, runbook_id: runbook.id, ok: allOk }, "runbook finished");
  return result;
}
