import { randomUUID } from "node:crypto";
import { runAgent } from "../agent/runner.js";
import { computeIdempotencyKey } from "../lib/idempotency.js";
import { logger } from "../lib/logger.js";
import type { Runbook, RunResult, TriggerEvent } from "../types/index.js";
import type { StateStore } from "../state/store.js";

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
  const idempotencyKey = computeIdempotencyKey(runbook.id, event);

  log.info(
    { run_id, runbook_id: runbook.id, trigger_type: event.type },
    "runbook started",
  );

  const agent = await runAgent(runbook.agent, { event, idempotencyKey });
  const finished_at = new Date().toISOString();

  if (!agent.ok) {
    log.warn(
      {
        run_id,
        runbook_id: runbook.id,
        timed_out: agent.timed_out,
        error: agent.error,
      },
      "runbook failed",
    );
  } else {
    log.info(
      { run_id, runbook_id: runbook.id, duration_ms: agent.duration_ms },
      "runbook ok",
    );
  }

  const result: RunResult = {
    run_id,
    runbook_id: runbook.id,
    started_at,
    finished_at,
    ok: agent.ok,
    agent,
    trigger_event: event,
  };
  await state.appendRunResult(result);
  return result;
}
