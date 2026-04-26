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

// 識別共用体。トリガー種別ごとに利用可能なフィールドを型で表現する。
export type TriggerEvent =
  | { type: "file"; path: string; content: string; timestamp: string }
  | { type: "cron"; timestamp: string }
  | { type: "manual"; timestamp: string };

export interface Match {
  runbook: Runbook;
  event: TriggerEvent;
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
  error: string | null;
}

export interface RunResult {
  run_id: string;
  runbook_id: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  steps: StepResult[];
  trigger_event: TriggerEvent;
}
