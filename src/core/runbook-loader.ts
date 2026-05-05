import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Cron } from "croner";
import YAML from "yaml";
import type { Runbook, BashStep, ClaudeStep, Step, Trigger } from "../types.js";

export class RunbookValidationError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "RunbookValidationError";
  }
}

export function loadRunbooks(dir: string): Runbook[] {
  const files = listYamlFiles(dir);
  const runbooks = files.map((f) => parseRunbookFile(f));
  assertUniqueIds(runbooks);
  return runbooks;
}

export function loadRunbookFile(path: string): Runbook {
  return parseRunbookFile(resolve(path));
}

function listYamlFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) continue;
    if (!/\.ya?ml$/.test(entry.name)) continue;
    out.push(full);
  }
  return out.sort();
}

function parseRunbookFile(file: string): Runbook {
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new RunbookValidationError(file, `YAML parse error: ${(e as Error).message}`);
  }
  return validateRunbook(raw, file);
}

function validateRunbook(raw: unknown, file: string): Runbook {
  if (!isObject(raw)) throw new RunbookValidationError(file, "root must be a mapping");

  const id = mustString(raw, "id", file);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    throw new RunbookValidationError(file, `id must be kebab-case [a-z0-9-]+, got: ${id}`);

  const description = optionalString(raw, "description", file);

  const enabled = optionalBoolean(raw, "enabled", file) ?? undefined;
  const cooldown_sec = optionalNumber(raw, "cooldown_sec", file, "cooldown_sec") ?? undefined;
  if (cooldown_sec !== undefined && cooldown_sec <= 0)
    throw new RunbookValidationError(file, "cooldown_sec must be > 0");

  const trigger = validateTrigger(raw["trigger"], file);
  const steps = validateSteps(raw["steps"], file, file);

  const rb: Runbook = {
    id,
    trigger,
    steps,
    sourcePath: file,
  };
  if (description !== undefined) rb.description = description;
  if (enabled !== undefined) rb.enabled = enabled;
  if (cooldown_sec !== undefined) rb.cooldown_sec = cooldown_sec;
  return rb;
}

function validateTrigger(raw: unknown, file: string): Trigger {
  if (!isObject(raw)) throw new RunbookValidationError(file, "trigger must be a mapping");
  const source = mustString(raw, "source", file, "trigger.source");
  if (source === "file") {
    const path = mustString(raw, "path", file, "trigger.path");
    const patternStr = mustString(raw, "pattern", file, "trigger.pattern");
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternStr);
    } catch (e) {
      throw new RunbookValidationError(
        file,
        `trigger.pattern is not a valid regex: ${(e as Error).message}`,
      );
    }
    return { source: "file", path, pattern };
  }
  if (source === "cron") {
    const schedule = mustString(raw, "schedule", file, "trigger.schedule");
    try {
      // Validate by constructing — Cron throws synchronously on bad expressions.
      new Cron(schedule);
    } catch (e) {
      throw new RunbookValidationError(
        file,
        `trigger.schedule is not a valid cron expression: ${(e as Error).message}`,
      );
    }
    return { source: "cron", schedule };
  }
  throw new RunbookValidationError(file, `trigger.source must be "file" or "cron" (got: ${source})`);
}

function validateSteps(raw: unknown, file: string, runbookFile: string): Step[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new RunbookValidationError(file, "steps must be a non-empty array");
  const seen = new Set<string>();
  const steps: Step[] = [];
  for (const [i, raw_] of raw.entries()) {
    const step =
      isObject(raw_) && "claude" in raw_
        ? validateClaudeStep(raw_, file, `steps[${i}]`, runbookFile)
        : validateBashStep(raw_, file, `steps[${i}]`);
    if (seen.has(step.id))
      throw new RunbookValidationError(file, `duplicate step id: ${step.id}`);
    seen.add(step.id);
    steps.push(step);
  }
  return steps;
}

function validateClaudeStep(raw: unknown, file: string, ctx: string, runbookFile: string): ClaudeStep {
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);
  const id = mustString(raw, "id", file, `${ctx}.id`);

  const claudeRaw = raw["claude"];
  if (!isObject(claudeRaw))
    throw new RunbookValidationError(file, `${ctx}.claude must be a mapping`);

  const hasPrompt = "prompt" in claudeRaw;
  const hasPromptFile = "prompt_file" in claudeRaw;
  if (!hasPrompt && !hasPromptFile)
    throw new RunbookValidationError(file, `${ctx}.claude must have "prompt" or "prompt_file"`);
  if (hasPrompt && hasPromptFile)
    throw new RunbookValidationError(
      file,
      `${ctx}.claude cannot have both "prompt" and "prompt_file"`,
    );

  let prompt: string;
  if (hasPromptFile) {
    const relPath = mustString(claudeRaw, "prompt_file", file, `${ctx}.claude.prompt_file`);
    const absPath = resolve(dirname(runbookFile), relPath);
    try {
      prompt = readFileSync(absPath, "utf8");
    } catch {
      throw new RunbookValidationError(
        file,
        `${ctx}.claude.prompt_file: cannot read file: ${absPath}`,
      );
    }
  } else {
    prompt = mustString(claudeRaw, "prompt", file, `${ctx}.claude.prompt`);
  }

  const hasSystem = "system" in claudeRaw;
  const hasSystemFile = "system_file" in claudeRaw;
  if (hasSystem && hasSystemFile)
    throw new RunbookValidationError(
      file,
      `${ctx}.claude cannot have both "system" and "system_file"`,
    );

  let system: string | undefined;
  if (hasSystemFile) {
    const relPath = mustString(claudeRaw, "system_file", file, `${ctx}.claude.system_file`);
    const absPath = resolve(dirname(runbookFile), relPath);
    try {
      system = readFileSync(absPath, "utf8");
    } catch {
      throw new RunbookValidationError(
        file,
        `${ctx}.claude.system_file: cannot read file: ${absPath}`,
      );
    }
  } else if (hasSystem) {
    system = mustString(claudeRaw, "system", file, `${ctx}.claude.system`);
  }

  const model =
    optionalString(claudeRaw, "model", file, `${ctx}.claude.model`) ?? "claude-opus-4-7";
  const max_tokens =
    optionalNumber(claudeRaw, "max_tokens", file, `${ctx}.claude.max_tokens`) ?? 1024;
  if (max_tokens <= 0)
    throw new RunbookValidationError(file, `${ctx}.claude.max_tokens must be > 0`);

  const agent = optionalBoolean(claudeRaw, "agent", file, `${ctx}.claude.agent`) ?? false;
  const allowed_tools = validateAllowedTools(
    claudeRaw["allowed_tools"],
    file,
    `${ctx}.claude.allowed_tools`,
  );
  const max_turns = optionalNumber(claudeRaw, "max_turns", file, `${ctx}.claude.max_turns`);
  if (max_turns !== undefined && max_turns <= 0)
    throw new RunbookValidationError(file, `${ctx}.claude.max_turns must be > 0`);
  const pmRaw = optionalString(claudeRaw, "permission_mode", file, `${ctx}.claude.permission_mode`);
  if (pmRaw !== undefined && pmRaw !== "accept-edits" && pmRaw !== "bypass")
    throw new RunbookValidationError(
      file,
      `${ctx}.claude.permission_mode must be "accept-edits" or "bypass"`,
    );
  const cwd = optionalString(claudeRaw, "cwd", file, `${ctx}.claude.cwd`);
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new RunbookValidationError(file, `${ctx}.claude.cwd must be an absolute path`);

  // agent: false で agent 専用フィールドが指定されたら設定誤りとして fail-closed
  if (!agent) {
    if (allowed_tools !== undefined)
      throw new RunbookValidationError(
        file,
        `${ctx}.claude.allowed_tools requires agent: true`,
      );
    if (max_turns !== undefined)
      throw new RunbookValidationError(file, `${ctx}.claude.max_turns requires agent: true`);
    if (pmRaw !== undefined)
      throw new RunbookValidationError(
        file,
        `${ctx}.claude.permission_mode requires agent: true`,
      );
    if (cwd !== undefined)
      throw new RunbookValidationError(file, `${ctx}.claude.cwd requires agent: true`);
  }

  const timeout_sec = optionalNumber(raw, "timeout_sec", file, `${ctx}.timeout_sec`) ?? 60;
  if (timeout_sec <= 0) throw new RunbookValidationError(file, `${ctx}.timeout_sec must be > 0`);
  const onErrorRaw = optionalString(raw, "on_error", file, `${ctx}.on_error`) ?? "stop";
  if (onErrorRaw !== "stop" && onErrorRaw !== "continue")
    throw new RunbookValidationError(file, `${ctx}.on_error must be "stop" or "continue"`);
  const capture = optionalBoolean(raw, "capture", file, `${ctx}.capture`) ?? false;
  const conditionRaw = optionalString(raw, "condition", file, `${ctx}.condition`);
  if (
    conditionRaw !== undefined &&
    conditionRaw !== "always" &&
    conditionRaw !== "on_success" &&
    conditionRaw !== "on_failure"
  )
    throw new RunbookValidationError(
      file,
      `${ctx}.condition must be "always", "on_success", or "on_failure"`,
    );
  const condition = conditionRaw as ClaudeStep["condition"];
  const claude: ClaudeStep["claude"] = {
    prompt,
    model,
    max_tokens,
    ...(system !== undefined ? { system } : {}),
  };
  if (agent) {
    claude.agent = true;
    if (allowed_tools !== undefined) claude.allowed_tools = allowed_tools;
    if (max_turns !== undefined) claude.max_turns = max_turns;
    if (pmRaw !== undefined) claude.permission_mode = pmRaw as "accept-edits" | "bypass";
    if (cwd !== undefined) claude.cwd = cwd;
  }
  const step: ClaudeStep = { id, claude, timeout_sec, on_error: onErrorRaw, capture };
  if (condition !== undefined) step.condition = condition;
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

function validateBashStep(raw: unknown, file: string, ctx: string): BashStep {
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);
  const id = mustString(raw, "id", file, `${ctx}.id`);
  if (!("bash" in raw))
    throw new RunbookValidationError(
      file,
      `${ctx} must have a bash field (only bash steps are supported in MVP)`,
    );
  const bash = mustString(raw, "bash", file, `${ctx}.bash`);
  const timeout_sec = optionalNumber(raw, "timeout_sec", file, `${ctx}.timeout_sec`) ?? 60;
  if (timeout_sec <= 0) throw new RunbookValidationError(file, `${ctx}.timeout_sec must be > 0`);
  const onErrorRaw = optionalString(raw, "on_error", file, `${ctx}.on_error`) ?? "stop";
  if (onErrorRaw !== "stop" && onErrorRaw !== "continue")
    throw new RunbookValidationError(file, `${ctx}.on_error must be "stop" or "continue"`);
  const env = validateEnv(raw["env"], file, `${ctx}.env`);
  const capture = optionalBoolean(raw, "capture", file, `${ctx}.capture`) ?? false;
  const conditionRaw = optionalString(raw, "condition", file, `${ctx}.condition`);
  if (
    conditionRaw !== undefined &&
    conditionRaw !== "always" &&
    conditionRaw !== "on_success" &&
    conditionRaw !== "on_failure"
  )
    throw new RunbookValidationError(
      file,
      `${ctx}.condition must be "always", "on_success", or "on_failure"`,
    );
  const condition = conditionRaw as BashStep["condition"];
  const step: BashStep = { id, bash, timeout_sec, on_error: onErrorRaw, env, capture };
  if (condition !== undefined) step.condition = condition;
  return step;
}

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean")
    throw new RunbookValidationError(file, `${ctx ?? key} must be a boolean`);
  return v;
}

function validateEnv(raw: unknown, file: string, ctx: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
      throw new RunbookValidationError(file, `${ctx}.${k} must be a string/number/boolean`);
    out[k] = String(v);
  }
  return out;
}

function assertUniqueIds(rbs: Runbook[]): void {
  const seen = new Map<string, string>();
  for (const rb of rbs) {
    const prev = seen.get(rb.id);
    if (prev) {
      throw new RunbookValidationError(rb.sourcePath, `duplicate runbook id "${rb.id}" (also in ${prev})`);
    }
    seen.set(rb.id, rb.sourcePath);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mustString(obj: Record<string, unknown>, key: string, file: string, ctx?: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0)
    throw new RunbookValidationError(file, `${ctx ?? key} must be a non-empty string`);
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new RunbookValidationError(file, `${ctx ?? key} must be a string`);
  return v;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new RunbookValidationError(file, `${ctx ?? key} must be a finite number`);
  return v;
}

export function dirHasFiles(path: string): boolean {
  try {
    const s = statSync(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
