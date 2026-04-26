import { resolve } from "node:path";
import type { LogLine, Match, Runbook } from "../types.js";

export function match(line: LogLine, runbooks: Runbook[]): Match[] {
  const linePath = resolve(line.path);
  return runbooks
    .filter(
      (r) => resolve(r.trigger.path) === linePath && r.trigger.pattern.test(line.content),
    )
    .map((r) => ({ runbook: r, line }));
}

export function uniqueTriggerPaths(runbooks: Runbook[]): string[] {
  return Array.from(new Set(runbooks.map((r) => resolve(r.trigger.path))));
}
