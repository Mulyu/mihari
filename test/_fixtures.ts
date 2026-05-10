import type { Agent, RunResult, Runbook, TriggerEvent } from "../src/types/index.js";

export function fakeAgent(over: Partial<Agent> = {}): Agent {
  return {
    prompt: "noop",
    model: "claude-haiku-4-5",
    allowed_tools: ["Read"],
    permission_mode: "strict",
    max_turns: 1,
    timeout_sec: 60,
    conventions: false,
    providers: [],
    ...over,
  };
}

export function fakeRunResult(over: Partial<RunResult> = {}): RunResult {
  const event: TriggerEvent = { type: "manual", timestamp: "2026-04-26T00:00:00Z" };
  return {
    run_id: "run_xxxxxxxx",
    runbook_id: "rb",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    ok: true,
    agent: {
      ok: true,
      exit_code: 0,
      stdout: "",
      duration_ms: 1,
      timed_out: false,
      error: null,
    },
    trigger_event: event,
    ...over,
  };
}

export function rbWithAgent(
  base: Omit<Runbook, "agent" | "sourcePath"> & { sourcePath?: string },
  agentOver: Partial<Agent> = {},
): Runbook {
  return {
    ...base,
    sourcePath: base.sourcePath ?? `/tmp/${base.id}.yaml`,
    agent: fakeAgent(agentOver),
  };
}
