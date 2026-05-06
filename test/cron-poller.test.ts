import { describe, expect, it } from "vitest";
import { Cron } from "croner";
import { decideCronFire } from "../src/triggers/cron.js";
import type { TriggerState } from "../src/types/index.js";

const schedule = (expr: string) => new Cron(expr);

const trig = (last: string): TriggerState => ({
  runbook_id: "rb",
  last_fired_at: last,
});

describe("decideCronFire", () => {
  it("does not fire on first observation, but seeds last_fired_at", () => {
    const now = new Date("2026-04-26T00:00:30Z");
    const r = decideCronFire(schedule("*/5 * * * *"), null, now);
    expect(r.fire).toBe(false);
    expect(r.newLastFiredAt).toBe(now.toISOString());
  });

  it("does not fire if next slot is in the future", () => {
    // last fired at 12:00:00, schedule every 5min, now is 12:02
    const now = new Date("2026-04-26T12:02:00Z");
    const r = decideCronFire(
      schedule("*/5 * * * *"),
      trig("2026-04-26T12:00:00Z"),
      now,
    );
    expect(r.fire).toBe(false);
    expect(r.newLastFiredAt).toBeNull();
  });

  it("fires when the next slot has passed", () => {
    const now = new Date("2026-04-26T12:05:30Z");
    const r = decideCronFire(
      schedule("*/5 * * * *"),
      trig("2026-04-26T12:00:00Z"),
      now,
    );
    expect(r.fire).toBe(true);
    expect(r.newLastFiredAt).toBe(now.toISOString());
  });

  it("fires only once per tick even if multiple slots elapsed", () => {
    // last fired at 12:00, now is 12:30 — many slots elapsed but we fire once
    const now = new Date("2026-04-26T12:30:00Z");
    const r = decideCronFire(
      schedule("*/5 * * * *"),
      trig("2026-04-26T12:00:00Z"),
      now,
    );
    expect(r.fire).toBe(true);
    expect(r.newLastFiredAt).toBe(now.toISOString());
  });
});
