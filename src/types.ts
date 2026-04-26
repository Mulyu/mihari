export type Trigger = FileTrigger | CronTrigger;

export interface Runbook {
  id: string;
  description?: string;
  trigger: Trigger;
  steps: BashStep[];
  sourcePath: string;
}

export interface FileTrigger {
  source: "file";
  path: string;
  pattern: RegExp;
}

export interface CronTrigger {
  source: "cron";
  schedule: string;
}

export interface BashStep {
  id: string;
  bash: string;
  timeout_sec: number;
  on_error: "stop" | "continue";
  env: Record<string, string>;
}

export interface LogLine {
  path: string;
  content: string;
  timestamp: string;
}

export interface Match {
  runbook: Runbook;
  line: LogLine;
}

export interface PollerState {
  path: string;
  inode: number;
  size: number;
  offset: number;
  updated_at: string;
}

export interface TriggerState {
  runbook_id: string;
  last_fired_at: string;
}

export interface StepResult {
  stepId: string;
  ok: boolean;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  error?: string;
}

export interface RunResult {
  run_id: string;
  runbook_id: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  steps: StepResult[];
  trigger_line: string | null;
}
