import { Cron } from "croner";
import pino from "pino";
import type { CronTrigger, LogLine, Runbook, TriggerState } from "../types.js";
import type { StateStore } from "../core/state.js";

const log = pino({ name: "mihari.poller.cron" });

export interface CronDecision {
  fire: boolean;
  // Updated last_fired_at to persist (only updated when fire is true or on first observation).
  newLastFiredAt: string | null;
}

export function decideCronFire(
  schedule: Cron,
  prev: TriggerState | null,
  now: Date,
): CronDecision {
  if (prev === null) {
    // 初回は発火せず、次のスロットを待つ。`mihari run <id>` で手動発火可能。
    return { fire: false, newLastFiredAt: now.toISOString() };
  }
  const prevDate = new Date(prev.last_fired_at);
  const next = schedule.nextRun(prevDate);
  if (next === null) return { fire: false, newLastFiredAt: null };
  if (next.getTime() <= now.getTime()) {
    return { fire: true, newLastFiredAt: now.toISOString() };
  }
  return { fire: false, newLastFiredAt: null };
}

export class CronScheduler {
  private readonly schedule: Cron;
  constructor(
    public readonly runbook: Runbook,
    private readonly state: StateStore,
  ) {
    if (runbook.trigger.source !== "cron") {
      throw new Error(`runbook ${runbook.id} is not a cron trigger`);
    }
    const cronTrigger = runbook.trigger as CronTrigger;
    this.schedule = new Cron(cronTrigger.schedule);
  }

  async tick(now: Date = new Date()): Promise<LogLine | null> {
    const prev = this.state.loadTriggerState(this.runbook.id);
    const decision = decideCronFire(this.schedule, prev, now);

    if (decision.newLastFiredAt) {
      await this.state.saveTriggerState({
        runbook_id: this.runbook.id,
        last_fired_at: decision.newLastFiredAt,
      });
    }

    if (!decision.fire) return null;

    log.info(
      { runbook_id: this.runbook.id, fired_at: decision.newLastFiredAt },
      "cron trigger fired",
    );
    return { path: "", content: "", timestamp: decision.newLastFiredAt ?? now.toISOString() };
  }
}

export function cronRunbooks(runbooks: Runbook[]): Runbook[] {
  return runbooks.filter((r) => r.trigger.source === "cron");
}
