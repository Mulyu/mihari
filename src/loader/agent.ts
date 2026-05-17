import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Agent } from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import {
  isObject,
  mustString,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./primitives.js";

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_SEC = 600;

export function validateAgent(raw: unknown, file: string, runbookFile: string): Agent {
  if (!isObject(raw)) throw new RunbookValidationError(file, "agent must be a mapping");

  const prompt = readPromptOrFile(raw, file, "agent", runbookFile, "prompt", "prompt_file");
  if (prompt === undefined)
    throw new RunbookValidationError(file, `agent must have "prompt" or "prompt_file"`);

  const system = readPromptOrFile(raw, file, "agent", runbookFile, "system", "system_file");

  const model = optionalString(raw, "model", file, "agent.model") ?? DEFAULT_MODEL;

  if (!("allowed_tools" in raw))
    throw new RunbookValidationError(file, "agent.allowed_tools is required");
  const allowed_tools = parseAllowedTools(raw["allowed_tools"], file);

  const max_turns =
    optionalNumber(raw, "max_turns", file, "agent.max_turns") ?? DEFAULT_MAX_TURNS;
  if (max_turns <= 0)
    throw new RunbookValidationError(file, "agent.max_turns must be > 0");

  const timeout_sec =
    optionalNumber(raw, "timeout_sec", file, "agent.timeout_sec") ?? DEFAULT_TIMEOUT_SEC;
  if (timeout_sec <= 0)
    throw new RunbookValidationError(file, "agent.timeout_sec must be > 0");

  const pmRaw = optionalString(raw, "permission_mode", file, "agent.permission_mode") ?? "strict";
  if (pmRaw !== "strict" && pmRaw !== "bypass")
    throw new RunbookValidationError(file, `agent.permission_mode must be "strict" or "bypass"`);

  const cwd = optionalString(raw, "cwd", file, "agent.cwd");
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new RunbookValidationError(file, "agent.cwd must be an absolute path");

  const conventions =
    optionalBoolean(raw, "conventions", file, "agent.conventions") ?? false;

  if ("providers" in raw)
    throw new RunbookValidationError(
      file,
      `"agent.providers" was removed; SaaS auth and call patterns must live in agent.prompt / agent.system`,
    );

  const agent: Agent = {
    prompt,
    model,
    allowed_tools,
    permission_mode: pmRaw,
    max_turns,
    timeout_sec,
    conventions,
  };
  if (system !== undefined) agent.system = system;
  if (cwd !== undefined) agent.cwd = cwd;
  return agent;
}

function parseAllowedTools(raw: unknown, file: string): string[] {
  if (!Array.isArray(raw))
    throw new RunbookValidationError(file, "agent.allowed_tools must be an array of strings");
  if (raw.length === 0)
    throw new RunbookValidationError(file, "agent.allowed_tools must list at least one tool");
  const out: string[] = [];
  for (const [i, v] of raw.entries()) {
    if (typeof v !== "string" || v.length === 0)
      throw new RunbookValidationError(file, `agent.allowed_tools[${i}] must be a non-empty string`);
    out.push(v);
  }
  return out;
}

function readPromptOrFile(
  raw: Record<string, unknown>,
  file: string,
  ctxBase: string,
  runbookFile: string,
  key: string,
  fileKey: string,
): string | undefined {
  const hasInline = key in raw;
  const hasFile = fileKey in raw;
  if (hasInline && hasFile)
    throw new RunbookValidationError(
      file,
      `${ctxBase} cannot have both "${key}" and "${fileKey}"`,
    );
  if (!hasInline && !hasFile) return undefined;
  if (hasFile) {
    const relPath = mustString(raw, fileKey, file, `${ctxBase}.${fileKey}`);
    const absPath = resolve(dirname(runbookFile), relPath);
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      throw new RunbookValidationError(
        file,
        `${ctxBase}.${fileKey}: cannot read file: ${absPath}`,
      );
    }
  }
  return mustString(raw, key, file, `${ctxBase}.${key}`);
}
