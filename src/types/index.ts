export type Trigger = FileTrigger | CronTrigger | AwsCloudWatchLogsTrigger | DatadogMonitorsTrigger;

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

// Datadog Monitor の状態遷移をポーリングで観測するトリガー。
// site は明示必須（datadoghq.com / datadoghq.eu / us3.datadoghq.com 等。state key の同一性を担保）。
// monitor_tags は Datadog SDK の monitorTags フィルタへ渡すタグ配列（任意。空なら全 monitor が対象）。
// transitions は拾う遷移の "to" 状態のリスト（デフォルト ["alert"]）。状態語彙は loader 側で固定する。
export type DatadogMonitorState =
  | "alert"
  | "warn"
  | "no_data"
  | "ok"
  | "skipped"
  | "ignored"
  | "unknown";

export interface DatadogMonitorsTrigger {
  source: "datadog_monitors";
  site: string;
  monitor_tags?: string[];
  transitions: DatadogMonitorState[];
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
    }
  | {
      type: "datadog_monitor";
      site: string;
      monitor_tags: string[];
      monitor_id: string;
      monitor_name: string;
      from_state: DatadogMonitorState;
      to_state: DatadogMonitorState;
      timestamp: string;
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

// Datadog Monitor poller の cursor。
// 観測した monitor id ごとの最終状態を保持し、次回 tick で差分を取って遷移を検出する。
// `monitor_tags` を含むのは集約キーと state ファイル名の整合のため（監査用に冗長保存）。
// `next_page` は前回 tick が hop cap で truncated されたときの再開地点。完全取得後は undefined。
// 1 回の walk が複数 tick にまたがる前提で、`monitor_states` は常に merge する（古い entry は
// drop しない＝削除検知は諦める。fail-open 寄りで欠落より安全側に倒す）。
export interface DatadogMonitorsPollerState {
  site: string;
  monitor_tags: string[];
  monitor_states: Record<string, DatadogMonitorState>;
  next_page?: number;
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
