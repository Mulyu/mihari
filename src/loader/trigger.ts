import { Cron } from "croner";
import type { Trigger } from "../types/index.js";
import { RunbookValidationError } from "./error.js";
import { isObject, mustString, optionalNumber, optionalString } from "./primitives.js";

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
  if (source === "cloudwatch_logs") {
    const region = mustString(raw, "region", file, "trigger.region");
    const log_group = mustString(raw, "log_group", file, "trigger.log_group");
    const interval_sec = optionalNumber(raw, "interval_sec", file, "trigger.interval_sec");
    if (interval_sec === undefined) {
      throw new RunbookValidationError(file, "trigger.interval_sec is required");
    }
    if (interval_sec <= 0) {
      throw new RunbookValidationError(file, "trigger.interval_sec must be > 0");
    }
    const patternStr = optionalString(raw, "pattern", file, "trigger.pattern");
    let pattern: RegExp | undefined;
    if (patternStr !== undefined) {
      try {
        pattern = new RegExp(patternStr);
      } catch (e) {
        throw new RunbookValidationError(
          file,
          `trigger.pattern is not a valid regex: ${(e as Error).message}`,
        );
      }
    }
    const t: Trigger = {
      source: "cloudwatch_logs",
      region,
      log_group,
      interval_sec,
    };
    if (pattern !== undefined) t.pattern = pattern;
    return t;
  }
  throw new RunbookValidationError(
    file,
    `trigger.source must be "file", "cron", or "cloudwatch_logs" (got: ${source})`,
  );
}
