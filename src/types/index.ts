export type Trigger = FileTrigger | CronTrigger | AwsCloudWatchLogsTrigger;

export type Step = BashStep | ClaudeStep | ClaudeAgentStep;

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

// CloudWatch Logs を `file` トリガーと対称な「リモートのログストリーム」として扱う。
// pattern は省略可。省略時は全 event がマッチ。
// region は明示必須（SDK の region 解決には頼らず、state key の同一性も担保する）。
export interface AwsCloudWatchLogsTrigger {
  source: "aws_cloudwatch_logs";
  region: string;
  log_group: string;
  pattern?: RegExp;
  interval_sec: number;
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

// 単発の messages.create 呼び出し。副作用なし。テキストを返すだけ。
export interface ClaudeStep {
  id: string;
  claude: {
    prompt: string;
    system?: string;
    model: string;
    max_tokens: number;
  };
  timeout_sec: number;
  on_error: "stop" | "continue";
  capture: boolean;
  condition?: "always" | "on_success" | "on_failure";
}

// Claude Agent SDK 経由のエージェントループ。ファイル編集 / Bash 等の副作用を伴う。
export interface ClaudeAgentStep {
  id: string;
  claude_agent: {
    prompt: string;
    system?: string;
    model: string;
    // SDK の allowedTools にそのまま渡す（"Read", "Bash(git push:*)" など）。
    allowed_tools: string[];
    // SDK の maxTurns に対応（省略時は SDK 既定）。
    max_turns?: number;
    // "strict" は allowed_tools に無い tool 呼び出しを全て deny。
    // "bypass" は全ツールを許可（allowDangerouslySkipPermissions = true）。
    permission_mode: "strict" | "bypass";
    // 絶対パス。省略時は process.cwd()。
    cwd?: string;
    // 既定の運用規約（PR 重複検知 / 決定的 branch 命名 / dirty tree チェック）を
    // system prompt に自動 append するか。既定 false。
    // true にすると preamble が git status:* / git ls-remote:* / gh pr list:* を agent に
    // 要求するため、allowed_tools にこれらが含まれていない runbook では canUseTool に
    // 弾かれる。opt-in を明示してもらう前提でデフォルトは off にしている。
    conventions: boolean;
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
  | { type: "manual"; timestamp: string }
  | {
      type: "aws_cloudwatch_logs";
      region: string;
      log_group: string;
      log_stream: string;
      message: string;
      event_id: string;
      timestamp: string;
      timestamp_ms: number;
    };

// 全ステップ実行時に渡される共通コンテキスト。
// bash / claude / claude_agent いずれの runner も同じ型を受け取る。
export interface StepContext {
  event: TriggerEvent;
  capturedSteps: Record<string, string>;
  idempotencyKey: string;
}

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

// CloudWatch Logs poller の cursor。
// `last_event_timestamp_ms` は次回 FilterLogEvents 呼び出しの startTime（inclusive）。
// `last_event_ids` は同 ms に複数 event があり得るため boundary 重複除去用。
export interface AwsCloudWatchLogsPollerState {
  region: string;
  log_group: string;
  last_event_timestamp_ms: number;
  last_event_ids: string[];
  last_polled_at: string;
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
