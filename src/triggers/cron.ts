import { Cron } from "croner";
import { logger } from "../lib/logger.js";
import type { CronTrigger, Runbook, TriggerEvent, TriggerState } from "../types/index.js";
import type { StateStore } from "../state/store.js";

const log = logger("trigger.cron");

export type CronEvent = Extract<TriggerEvent, { type: "cron" }>;

export interface CronDecision {
  fire: boolean;
  // newLastFiredAt が null のときは state を更新しない。
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

type CronRunbook = Runbook & { trigger: CronTrigger };

function isCronRunbook(rb: Runbook): rb is CronRunbook {
  return rb.trigger.source === "cron";
}

export class CronScheduler {
  private readonly schedule: Cron;
  constructor(
    public readonly runbook: CronRunbook,
    private readonly state: StateStore,
  ) {
    this.schedule = new Cron(runbook.trigger.schedule);
  }

  async tick(now: Date = new Date(), dryRun = false): Promise<CronEvent | null> {
    const prev = this.state.loadTriggerState(this.runbook.id);
    const decision = decideCronFire(this.schedule, prev, now);

    if (!dryRun && decision.newLastFiredAt) {
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
    return { type: "cron", timestamp: decision.newLastFiredAt ?? now.toISOString() };
  }
}

export function cronRunbooks(runbooks: Runbook[]): CronRunbook[] {
  return runbooks.filter(isCronRunbook);
}
