import { randomUUID } from "node:crypto";
import pino from "pino";
import type { LogLine, Match, Runbook, RunResult, StepResult } from "../types.js";
import { runBashStep } from "../steps/bash-step.js";
import type { StateStore } from "./state.js";

const log = pino({ name: "mihari.executor" });

export interface Executor {
  execute(match: Match): Promise<RunResult>;
  executeBare(runbook: Runbook): Promise<RunResult>;
}

export function createExecutor(state: StateStore): Executor {
  return {
    async execute(m: Match): Promise<RunResult> {
      return runRunbook(m.runbook, m.line, state);
    },
    async executeBare(runbook: Runbook): Promise<RunResult> {
      return runRunbook(runbook, null, state);
    },
  };
}

async function runRunbook(
  runbook: Runbook,
  line: LogLine | null,
  state: StateStore,
): Promise<RunResult> {
  const run_id = `run_${randomUUID().slice(0, 8)}`;
  const started_at = new Date().toISOString();
  const results: StepResult[] = [];

  log.info(
    { run_id, runbook_id: runbook.id, line: line?.content ?? null },
    "runbook started",
  );

  let allOk = true;
  for (const step of runbook.steps) {
    const r = await runBashStep(step, { event: line });
    results.push(r);
    if (!r.ok) {
      allOk = false;
      log.warn(
        { run_id, runbook_id: runbook.id, step: step.id, exit_code: r.exit_code, timed_out: r.timed_out },
        "step failed",
      );
      if (step.on_error === "stop") break;
    } else {
      log.info({ run_id, runbook_id: runbook.id, step: step.id, duration_ms: r.duration_ms }, "step ok");
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
    trigger_line: line?.content ?? null,
  };
  await state.appendRunResult(result);
  log.info({ run_id, runbook_id: runbook.id, ok: allOk }, "runbook finished");
  return result;
}
