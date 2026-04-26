import { match } from "./matcher.js";
import type { Executor } from "./executor.js";
import type { CronScheduler } from "../pollers/cron.js";
import type { FilePoller } from "../pollers/file.js";
import type { Runbook } from "../types.js";

export interface DispatcherInput {
  runbooks: Runbook[];
  pollers: FilePoller[];
  cronSchedulers: CronScheduler[];
  executor: Executor;
}

export interface TickOptions {
  dryRun?: boolean;
  onDryRun?: (msg: string) => void;
}

export interface TickResult {
  ok: boolean;
  fired: number;
}

export async function tick(
  input: DispatcherInput,
  opts: TickOptions = {},
): Promise<TickResult> {
  let ok = true;
  let fired = 0;

  for (const poller of input.pollers) {
    const events = await poller.tick();
    for (const event of events) {
      const matches = match(event, input.runbooks);
      for (const m of matches) {
        fired++;
        if (opts.dryRun) {
          opts.onDryRun?.(`${m.runbook.id} <- ${event.path}: ${event.content}`);
          continue;
        }
        const result = await input.executor.execute(m.runbook, m.event);
        if (!result.ok) ok = false;
      }
    }
  }

  for (const scheduler of input.cronSchedulers) {
    const event = await scheduler.tick();
    if (!event) continue;
    fired++;
    if (opts.dryRun) {
      opts.onDryRun?.(`${scheduler.runbook.id} <- cron@${event.timestamp}`);
      continue;
    }
    const result = await input.executor.execute(scheduler.runbook, event);
    if (!result.ok) ok = false;
  }

  return { ok, fired };
}
