import { describe, expect, it } from "vitest";
import { decideStartOffset, splitCompleteLines } from "../src/triggers/file.js";
import type { PollerState } from "../src/types.js";

function st(over: Partial<PollerState> = {}): PollerState {
  return {
    path: "/tmp/x.log",
    inode: 100,
    size: 50,
    offset: 50,
    updated_at: "2026-04-26T00:00:00Z",
    ...over,
  };
}

describe("decideStartOffset", () => {
  it("first observation starts at end of file", () => {
    expect(decideStartOffset(null, { inode: 100, size: 1234 })).toEqual({
      startOffset: 1234,
      reason: "new",
    });
  });

  it("inode change is treated as rotation", () => {
    expect(decideStartOffset(st({ inode: 100, size: 50, offset: 50 }), { inode: 200, size: 30 })).toEqual({
      startOffset: 0,
      reason: "rotated",
    });
  });

  it("size shrinking is truncation", () => {
    expect(decideStartOffset(st({ inode: 100, size: 100, offset: 100 }), { inode: 100, size: 40 })).toEqual({
      startOffset: 0,
      reason: "truncated",
    });
  });

  it("appended is normal append", () => {
    expect(decideStartOffset(st({ inode: 100, size: 100, offset: 80 }), { inode: 100, size: 200 })).toEqual({
      startOffset: 80,
      reason: "appended",
    });
  });

  it("unchanged size is noop", () => {
    expect(decideStartOffset(st({ inode: 100, size: 100, offset: 100 }), { inode: 100, size: 100 })).toEqual({
      startOffset: 100,
      reason: "noop",
    });
  });
});

describe("splitCompleteLines", () => {
  it("returns complete lines and bytes consumed", () => {
    const buf = Buffer.from("a\nbb\nccc\n");
    expect(splitCompleteLines(buf)).toEqual({
      lines: ["a", "bb", "ccc"],
      consumed: 9,
    });
  });

  it("withholds an unterminated trailing line", () => {
    const buf = Buffer.from("a\nbb\nccc");
    expect(splitCompleteLines(buf)).toEqual({
      lines: ["a", "bb"],
      consumed: 5,
    });
  });

  it("returns nothing when no newline exists yet", () => {
    expect(splitCompleteLines(Buffer.from("partial"))).toEqual({ lines: [], consumed: 0 });
  });

  it("empty buffer", () => {
    expect(splitCompleteLines(Buffer.from(""))).toEqual({ lines: [], consumed: 0 });
  });
});
