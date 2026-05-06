import type { Runbook, Step } from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import {
  isObject,
  mustString,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./primitives.js";
import { validateBashStep } from "./step-bash.js";
import { validateClaudeStep } from "./step-claude.js";
import { validateClaudeAgentStep } from "./step-claude-agent.js";
import { validateTrigger } from "./trigger.js";

export function validateRunbook(raw: unknown, file: string): Runbook {
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

  const rb: Runbook = { id, trigger, steps, sourcePath: file };
  if (description !== undefined) rb.description = description;
  if (enabled !== undefined) rb.enabled = enabled;
  if (cooldown_sec !== undefined) rb.cooldown_sec = cooldown_sec;
  return rb;
}

export function validateSteps(raw: unknown, file: string, runbookFile: string): Step[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new RunbookValidationError(file, "steps must be a non-empty array");
  const seen = new Set<string>();
  const steps: Step[] = [];
  for (const [i, raw_] of raw.entries()) {
    const ctx = `steps[${i}]`;
    let step: Step;
    if (isObject(raw_) && "claude_agent" in raw_) {
      step = validateClaudeAgentStep(raw_, file, ctx, runbookFile);
    } else if (isObject(raw_) && "claude" in raw_) {
      step = validateClaudeStep(raw_, file, ctx, runbookFile);
    } else {
      step = validateBashStep(raw_, file, ctx);
    }
    if (seen.has(step.id))
      throw new RunbookValidationError(file, `duplicate step id: ${step.id}`);
    seen.add(step.id);
    steps.push(step);
  }
  return steps;
}
