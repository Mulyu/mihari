import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import pino from "pino";
import type { PollerState, RunResult } from "../types.js";

const log = pino({ name: "mihari.state" });

export interface StateStoreOptions {
  baseDir?: string;
}

export class StateStore {
  readonly baseDir: string;

  constructor(opts: StateStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultStateDir();
    mkdirSync(join(this.baseDir, "pollers"), { recursive: true });
    mkdirSync(join(this.baseDir, "runs"), { recursive: true });
  }

  pollerStateFile(filePath: string): string {
    const hash = createHash("sha1").update(resolve(filePath)).digest("hex").slice(0, 16);
    return join(this.baseDir, "pollers", `${hash}.json`);
  }

  loadPollerState(filePath: string): PollerState | null {
    const file = this.pollerStateFile(filePath);
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text);
      if (!validatePollerState(obj)) {
        log.warn({ file }, "poller state invalid, ignoring");
        return null;
      }
      return obj;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      log.warn({ file, err: err.message }, "poller state read failed, treating as empty");
      return null;
    }
  }

  async savePollerState(state: PollerState): Promise<void> {
    const file = this.pollerStateFile(state.path);
    try {
      await writeAtomic(file, JSON.stringify(state, null, 2));
    } catch (e) {
      // fail-open: state破損で全ポーリングが止まるほうが運用上のリスクが大きい
      log.warn({ file, err: (e as Error).message }, "poller state write failed");
    }
  }

  async appendRunResult(result: RunResult): Promise<void> {
    const date = result.started_at.slice(0, 10);
    const dir = join(this.baseDir, "runs", date);
    const file = join(dir, `${result.run_id}.jsonl`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(result) + "\n", { flag: "a" });
    } catch (e) {
      log.warn({ file, err: (e as Error).message }, "run result write failed");
    }
  }
}

export function defaultStateDir(): string {
  return process.env["MIHARI_STATE_DIR"] ?? join(homedir(), ".mihari", "state");
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  // Pre-create the file so proper-lockfile can lock on it.
  writeFileSync(file, "", { flag: "a" });
  const release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } });
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  } finally {
    await release();
  }
}

function validatePollerState(v: unknown): v is PollerState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["path"] === "string" &&
    typeof o["inode"] === "number" &&
    typeof o["size"] === "number" &&
    typeof o["offset"] === "number" &&
    typeof o["updated_at"] === "string"
  );
}
