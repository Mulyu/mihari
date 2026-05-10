import type { Runbook } from "../types/index.js";
import { validateAgent } from "./agent.js";
import { RunbookValidationError } from "./error.js";
import {
  isObject,
  mustString,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./primitives.js";
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

  if ("steps" in raw)
    throw new RunbookValidationError(
      file,
      `"steps" was removed in 1.0; use "agent:" with optional providers (see doc/runbook-spec.md)`,
    );

  const trigger = validateTrigger(raw["trigger"], file);
  if (!("agent" in raw))
    throw new RunbookValidationError(file, `"agent" is required`);
  const agent = validateAgent(raw["agent"], file, file);

  const rb: Runbook = { id, trigger, agent, sourcePath: file };
  if (description !== undefined) rb.description = description;
  if (enabled !== undefined) rb.enabled = enabled;
  if (cooldown_sec !== undefined) rb.cooldown_sec = cooldown_sec;
  return rb;
}
