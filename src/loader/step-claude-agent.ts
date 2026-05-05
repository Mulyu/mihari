import type { ClaudeAgentStep } from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import {
  isObject,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./primitives.js";
import { readPromptOrFile } from "./prompt-file.js";
import { validateCommonStepFields } from "./step-common.js";

export function validateClaudeAgentStep(
  raw: unknown,
  file: string,
  ctx: string,
  runbookFile: string,
): ClaudeAgentStep {
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);

  const cfgRaw = raw["claude_agent"];
  if (!isObject(cfgRaw))
    throw new RunbookValidationError(file, `${ctx}.claude_agent must be a mapping`);

  const prompt = readPromptOrFile(
    cfgRaw,
    file,
    `${ctx}.claude_agent`,
    runbookFile,
    "prompt",
    "prompt_file",
  );
  if (prompt === undefined)
    throw new RunbookValidationError(
      file,
      `${ctx}.claude_agent must have "prompt" or "prompt_file"`,
    );
  const system = readPromptOrFile(
    cfgRaw,
    file,
    `${ctx}.claude_agent`,
    runbookFile,
    "system",
    "system_file",
  );

  const model =
    optionalString(cfgRaw, "model", file, `${ctx}.claude_agent.model`) ?? "claude-opus-4-7";

  if (!("allowed_tools" in cfgRaw))
    throw new RunbookValidationError(file, `${ctx}.claude_agent.allowed_tools is required`);
  const allowed_tools = validateAllowedTools(
    cfgRaw["allowed_tools"],
    file,
    `${ctx}.claude_agent.allowed_tools`,
  );
  if (allowed_tools === undefined || allowed_tools.length === 0)
    throw new RunbookValidationError(
      file,
      `${ctx}.claude_agent.allowed_tools must list at least one tool`,
    );

  const max_turns = optionalNumber(cfgRaw, "max_turns", file, `${ctx}.claude_agent.max_turns`);
  if (max_turns !== undefined && max_turns <= 0)
    throw new RunbookValidationError(file, `${ctx}.claude_agent.max_turns must be > 0`);

  const pmRaw =
    optionalString(cfgRaw, "permission_mode", file, `${ctx}.claude_agent.permission_mode`) ??
    "strict";
  if (pmRaw !== "strict" && pmRaw !== "bypass")
    throw new RunbookValidationError(
      file,
      `${ctx}.claude_agent.permission_mode must be "strict" or "bypass"`,
    );

  const cwd = optionalString(cfgRaw, "cwd", file, `${ctx}.claude_agent.cwd`);
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new RunbookValidationError(file, `${ctx}.claude_agent.cwd must be an absolute path`);

  const conventions =
    optionalBoolean(cfgRaw, "conventions", file, `${ctx}.claude_agent.conventions`) ?? false;

  const common = validateCommonStepFields(raw, file, ctx);

  const claude_agent: ClaudeAgentStep["claude_agent"] = {
    prompt,
    model,
    allowed_tools,
    permission_mode: pmRaw,
    conventions,
    ...(system !== undefined ? { system } : {}),
    ...(max_turns !== undefined ? { max_turns } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
  const step: ClaudeAgentStep = {
    id: common.id,
    claude_agent,
    timeout_sec: common.timeout_sec,
    on_error: common.on_error,
    capture: common.capture,
  };
  if (common.condition !== undefined) step.condition = common.condition;
  return step;
}

function validateAllowedTools(raw: unknown, file: string, ctx: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw))
    throw new RunbookValidationError(file, `${ctx} must be an array of strings`);
  const out: string[] = [];
  for (const [i, v] of raw.entries()) {
    if (typeof v !== "string" || v.length === 0)
      throw new RunbookValidationError(file, `${ctx}[${i}] must be a non-empty string`);
    out.push(v);
  }
  return out;
}
