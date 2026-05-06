import { describe, expect, it } from "vitest";
import { computeIdempotencyKey } from "../src/lib/idempotency.js";
import type { TriggerEvent } from "../src/types/index.js";

const fileEvent = (overrides: Partial<Extract<TriggerEvent, { type: "file" }>> = {}) =>
  ({
    type: "file" as const,
    path: "/var/log/app.log",
    content: "ERROR: db connection refused",
    timestamp: "2026-05-05T00:00:00.000Z",
    ...overrides,
  }) satisfies TriggerEvent;

describe("computeIdempotencyKey", () => {
  it("produces 12 hex chars", () => {
    const k = computeIdempotencyKey("rb", fileEvent());
    expect(k).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same (runbook, file event)", () => {
    expect(computeIdempotencyKey("rb", fileEvent())).toBe(
      computeIdempotencyKey("rb", fileEvent()),
    );
  });

  it("differs across runbook ids", () => {
    expect(computeIdempotencyKey("rb-a", fileEvent())).not.toBe(
      computeIdempotencyKey("rb-b", fileEvent()),
    );
  });

  it("differs when the file path differs", () => {
    expect(
      computeIdempotencyKey("rb", fileEvent({ path: "/var/log/a.log" })),
    ).not.toBe(computeIdempotencyKey("rb", fileEvent({ path: "/var/log/b.log" })));
  });

  it("differs when the matched line content differs", () => {
    expect(
      computeIdempotencyKey("rb", fileEvent({ content: "ERROR: x" })),
    ).not.toBe(computeIdempotencyKey("rb", fileEvent({ content: "ERROR: y" })));
  });

  it("ignores file event timestamp", () => {
    // 同じ行が再観測されたとき同じキーを出す保証。timestamp はキーに混ぜない。
    expect(
      computeIdempotencyKey("rb", fileEvent({ timestamp: "2026-05-05T00:00:00Z" })),
    ).toBe(
      computeIdempotencyKey("rb", fileEvent({ timestamp: "2026-05-05T01:00:00Z" })),
    );
  });

  it("cron events sharing a minute slot collapse to one key", () => {
    const a: TriggerEvent = { type: "cron", timestamp: "2026-05-05T00:00:12.000Z" };
    const b: TriggerEvent = { type: "cron", timestamp: "2026-05-05T00:00:48.000Z" };
    expect(computeIdempotencyKey("rb", a)).toBe(computeIdempotencyKey("rb", b));
  });

  it("cron events from different minutes get different keys", () => {
    const a: TriggerEvent = { type: "cron", timestamp: "2026-05-05T00:00:00.000Z" };
    const b: TriggerEvent = { type: "cron", timestamp: "2026-05-05T00:01:00.000Z" };
    expect(computeIdempotencyKey("rb", a)).not.toBe(computeIdempotencyKey("rb", b));
  });

  it("manual events vary with timestamp", () => {
    const a: TriggerEvent = { type: "manual", timestamp: "2026-05-05T00:00:00.000Z" };
    const b: TriggerEvent = { type: "manual", timestamp: "2026-05-05T00:00:01.000Z" };
    expect(computeIdempotencyKey("rb", a)).not.toBe(computeIdempotencyKey("rb", b));
  });
});
