export type Trigger = FileTrigger | CronTrigger;

export type Step = BashStep | ClaudeStep;

export interface Runbook {
  id: string;
  description?: string;
  trigger: Trigger;
  steps: Step[];
  sourcePath: string;
  enabled?: boolean;
  cooldown_sec?: number;
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
  capture: boolean;
  condition?: "always" | "on_success" | "on_failure";
}

export interface ClaudeStep {
  id: string;
  claude: {
    prompt: string;
    system?: string;
    model: string;
    max_tokens: number;
    // Agent モード（Claude Agent SDK 経由）。true でファイル編集 / Bash 等のツール利用が有効。
    agent?: boolean;
    // agent: true 時のみ有効。SDK の allowedTools にそのまま渡す（"Read", "Bash(git push:*)" など）。
    allowed_tools?: string[];
    // agent: true 時のみ有効。SDK の maxTurns に対応。
    max_turns?: number;
    // agent: true 時のみ有効。"accept-edits" は edit 自動承認 + allowed_tools 範囲のみ実行可。
    // "bypass" は全ツールを許可（allowDangerouslySkipPermissions = true）。
    permission_mode?: "accept-edits" | "bypass";
    // agent: true 時のみ有効。絶対パス。省略時は process.cwd()。
    cwd?: string;
  };
  timeout_sec: number;
  on_error: "stop" | "continue";
  capture: boolean;
  condition?: "always" | "on_success" | "on_failure";
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
  // capture: true のステップで、テンプレ展開で使われる正規化済み stdout（trailing newline 除去）。
  // それ以外のステップでは null。
  captured: string | null;
  skipped: boolean;
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
