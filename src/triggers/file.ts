import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";
import type { PollerState, TriggerEvent } from "../types/index.js";
import type { StateStore } from "../state/store.js";

const log = logger("trigger.file");

export type FileEvent = Extract<TriggerEvent, { type: "file" }>;

export interface PollDecision {
  startOffset: number;
  reason: "new" | "rotated" | "truncated" | "appended" | "noop";
}

export function decideStartOffset(
  prev: PollerState | null,
  current: { inode: number; size: number },
): PollDecision {
  if (prev === null) {
    // 初回は末尾起点。過去ログを巻き戻して実行しない。
    return { startOffset: current.size, reason: "new" };
  }
  if (prev.inode !== current.inode) {
    return { startOffset: 0, reason: "rotated" };
  }
  if (current.size < prev.offset) {
    return { startOffset: 0, reason: "truncated" };
  }
  if (current.size === prev.offset) {
    return { startOffset: prev.offset, reason: "noop" };
  }
  return { startOffset: prev.offset, reason: "appended" };
}

export function splitCompleteLines(buf: Buffer): { lines: string[]; consumed: number } {
  // 末尾の改行未確定行はバッファに残し、次回ティックで連結（v1: 改行が来てから処理）
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], consumed: 0 };
  const slice = buf.subarray(0, lastNl + 1).toString("utf8");
  const lines = slice.split("\n");
  // 最後の split 結果は ""（末尾改行直後）なので捨てる
  lines.pop();
  return { lines, consumed: lastNl + 1 };
}

export class FilePoller {
  constructor(
    public readonly path: string,
    private readonly state: StateStore,
  ) {}

  async tick(dryRun = false): Promise<FileEvent[]> {
    const absPath = resolve(this.path);
    let stats;
    try {
      stats = await stat(absPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        log.warn({ path: absPath }, "log file missing, skipping tick");
        return [];
      }
      throw e;
    }

    const prev = this.state.loadPollerState(absPath);
    const decision = decideStartOffset(prev, { inode: Number(stats.ino), size: stats.size });
    if (decision.reason === "rotated" || decision.reason === "truncated") {
      log.info({ path: absPath, reason: decision.reason }, "log file change detected");
    }

    if (decision.reason === "noop" || decision.reason === "new") {
      if (!dryRun) {
        const next: PollerState = {
          path: absPath,
          inode: Number(stats.ino),
          size: stats.size,
          offset: decision.startOffset,
          updated_at: new Date().toISOString(),
        };
        await this.state.savePollerState(next);
      }
      return [];
    }

    const length = stats.size - decision.startOffset;
    const buf = Buffer.alloc(length);
    const fh = await open(absPath, "r");
    try {
      await fh.read(buf, 0, length, decision.startOffset);
    } finally {
      await fh.close();
    }

    const { lines, consumed } = splitCompleteLines(buf);
    const timestamp = new Date().toISOString();
    const out: FileEvent[] = lines.map((content) => ({
      type: "file",
      path: absPath,
      content,
      timestamp,
    }));

    if (!dryRun) {
      const newOffset = decision.startOffset + consumed;
      const next: PollerState = {
        path: absPath,
        inode: Number(stats.ino),
        size: stats.size,
        offset: newOffset,
        updated_at: timestamp,
      };
      await this.state.savePollerState(next);
    }
    return out;
  }
}
