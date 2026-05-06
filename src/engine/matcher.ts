import { resolve } from "node:path";
import type {
  AwsCloudWatchLogsTrigger,
  FileTrigger,
  Match,
  Runbook,
  TriggerEvent,
} from "../types/index.js";

type FileRunbook = Runbook & { trigger: FileTrigger };
type AwsCloudWatchLogsRunbook = Runbook & { trigger: AwsCloudWatchLogsTrigger };

function isFileRunbook(rb: Runbook): rb is FileRunbook {
  return rb.trigger.source === "file";
}

function isAwsCloudWatchLogsRunbook(rb: Runbook): rb is AwsCloudWatchLogsRunbook {
  return rb.trigger.source === "aws_cloudwatch_logs";
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

export function matchAwsCloudWatchLogs(
  event: Extract<TriggerEvent, { type: "aws_cloudwatch_logs" }>,
  runbooks: Runbook[],
): Match[] {
  return runbooks
    .filter(isAwsCloudWatchLogsRunbook)
    .filter(
      (r) =>
        r.trigger.region === event.region &&
        r.trigger.log_group === event.log_group &&
        (r.trigger.pattern === undefined || r.trigger.pattern.test(event.message)),
    )
    .map((r) => ({ runbook: r, event }));
}

export function uniqueTriggerPaths(runbooks: Runbook[]): string[] {
  return Array.from(
    new Set(runbooks.filter(isFileRunbook).map((r) => resolve(r.trigger.path))),
  );
}
