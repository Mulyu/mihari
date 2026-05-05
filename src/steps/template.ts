import type { StepContext } from "../types/index.js";

// 全ステップで共通のテンプレ字句構造。
// 拾うキー: event.line / event.path / event.timestamp / env.<NAME> / steps.<id>.output
export const TEMPLATE_RE =
  /\{\{\s*(event\.line|event\.path|event\.timestamp|env\.[A-Za-z_][A-Za-z0-9_]*|steps\.[a-z0-9][a-z0-9-]*\.output)\s*\}\}/g;

export function normalizeStepEnvName(stepId: string): string {
  return stepId.replace(/-/g, "_").toUpperCase();
}

// bash 用展開: 値は env 経由で渡し、テンプレは ${VAR} に置換する（裸）。
// 引用は呼び出し側責務（`echo "{{ event.line }}"` のように囲む）。
// 自前で `"$VAR"` を生成すると、ユーザの `"... {{ ... }} ..."` と隣接して
// 引用が崩れ、IFS による単語分割で改行が空白化されるなどの罠がある。
export function substituteBashTemplate(bash: string): string {
  return bash.replace(TEMPLATE_RE, (raw, key: string) => {
    if (key === "event.line") return "${MIHARI_EVENT_LINE}";
    if (key === "event.path") return "${MIHARI_EVENT_PATH}";
    if (key === "event.timestamp") return "${MIHARI_EVENT_TIMESTAMP}";
    if (key.startsWith("env.")) return `\${${key.slice(4)}}`;
    if (key.startsWith("steps.") && key.endsWith(".output")) {
      const stepId = key.slice("steps.".length, -".output".length);
      return `\${MIHARI_STEP_${normalizeStepEnvName(stepId)}}`;
    }
    return raw;
  });
}

// claude / claude_agent 用展開: prompt 文字列に値を直接埋め込む。
// bash と違って二重引用やシェル展開を経由しないので、値をそのまま入れて良い。
export function substituteClaudeTemplate(text: string, ctx: StepContext): string {
  return text.replace(TEMPLATE_RE, (raw, key: string) => {
    if (key === "event.line") return ctx.event.type === "file" ? ctx.event.content : "";
    if (key === "event.path") return ctx.event.type === "file" ? ctx.event.path : "";
    if (key === "event.timestamp") return ctx.event.timestamp;
    if (key.startsWith("env.")) return process.env[key.slice(4)] ?? "";
    if (key.startsWith("steps.") && key.endsWith(".output")) {
      const stepId = key.slice("steps.".length, -".output".length);
      return ctx.capturedSteps[stepId] ?? "";
    }
    return raw;
  });
}

// bash の `$(cmd)` と同じく末尾の改行群を取り除く。
export function captureStdout(stdout: string): string {
  return stdout.replace(/\n+$/, "");
}
