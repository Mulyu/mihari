import type { ClaudeStep } from "../types.js";
import { RunbookValidationError } from "./error.js";
import { isObject, optionalNumber, optionalString } from "./primitives.js";
import { readPromptOrFile } from "./prompt-file.js";
import { validateCommonStepFields } from "./step-common.js";

export function validateClaudeStep(
  raw: unknown,
  file: string,
  ctx: string,
  runbookFile: string,
): ClaudeStep {
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);

  const claudeRaw = raw["claude"];
  if (!isObject(claudeRaw))
    throw new RunbookValidationError(file, `${ctx}.claude must be a mapping`);

  const prompt = readPromptOrFile(
    claudeRaw,
    file,
    `${ctx}.claude`,
    runbookFile,
    "prompt",
    "prompt_file",
  );
  if (prompt === undefined)
    throw new RunbookValidationError(file, `${ctx}.claude must have "prompt" or "prompt_file"`);
  const system = readPromptOrFile(
    claudeRaw,
    file,
    `${ctx}.claude`,
    runbookFile,
    "system",
    "system_file",
  );

  const model =
    optionalString(claudeRaw, "model", file, `${ctx}.claude.model`) ?? "claude-opus-4-7";
  const max_tokens =
    optionalNumber(claudeRaw, "max_tokens", file, `${ctx}.claude.max_tokens`) ?? 1024;
  if (max_tokens <= 0)
    throw new RunbookValidationError(file, `${ctx}.claude.max_tokens must be > 0`);

  // 副作用ありのエージェント実行は別ステップ種別 (claude_agent) として扱う。
  // 単発 claude ステップに紛れ込ませない。
  for (const k of ["agent", "allowed_tools", "max_turns", "permission_mode", "cwd"]) {
    if (k in claudeRaw)
      throw new RunbookValidationError(
        file,
        `${ctx}.claude.${k} is only valid on a "claude_agent" step (use claude_agent: instead of claude:)`,
      );
  }

  const common = validateCommonStepFields(raw, file, ctx);
  const claude: ClaudeStep["claude"] = {
    prompt,
    model,
    max_tokens,
    ...(system !== undefined ? { system } : {}),
  };
  const step: ClaudeStep = {
    id: common.id,
    claude,
    timeout_sec: common.timeout_sec,
    on_error: common.on_error,
    capture: common.capture,
  };
  if (common.condition !== undefined) step.condition = common.condition;
  return step;
}
