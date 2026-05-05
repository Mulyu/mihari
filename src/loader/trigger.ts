import { Cron } from "croner";
import type { Trigger } from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import { isObject, mustString } from "./primitives.js";

export function validateTrigger(raw: unknown, file: string): Trigger {
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
  throw new RunbookValidationError(
    file,
    `trigger.source must be "file" or "cron" (got: ${source})`,
  );
}
