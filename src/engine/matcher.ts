import { resolve } from "node:path";
import type { FileTrigger, Match, Runbook, TriggerEvent } from "../types/index.js";

type FileRunbook = Runbook & { trigger: FileTrigger };

function isFileRunbook(rb: Runbook): rb is FileRunbook {
  return rb.trigger.source === "file";
}

export function match(
  event: Extract<TriggerEvent, { type: "file" }>,
  runbooks: Runbook[],
): Match[] {
  const eventPath = resolve(event.path);
  return runbooks
    .filter(isFileRunbook)
    .filter(
      (r) =>
        resolve(r.trigger.path) === eventPath && r.trigger.pattern.test(event.content),
    )
    .map((r) => ({ runbook: r, event }));
}

export function uniqueTriggerPaths(runbooks: Runbook[]): string[] {
  return Array.from(
    new Set(runbooks.filter(isFileRunbook).map((r) => resolve(r.trigger.path))),
  );
}
