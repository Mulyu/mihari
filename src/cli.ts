#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { logger, setLogLevel } from "./core/logger.js";
import {
  loadRunbookFile,
  loadRunbooks,
  RunbookValidationError,
} from "./core/runbook-loader.js";
import { uniqueTriggerPaths } from "./core/matcher.js";
import { StateStore, defaultStateDir } from "./core/state.js";
import { createExecutor, type Executor } from "./core/executor.js";
import { tick } from "./core/dispatcher.js";
import { FilePoller } from "./pollers/file.js";
import { CronScheduler, cronRunbooks } from "./pollers/cron.js";
import type { Runbook, TriggerEvent } from "./types.js";

const log = logger("cli");

interface GlobalOpts {
  runbooksDir: string;
  stateDir: string;
  logLevel: string;
}

const program = new Command();
program
  .name("mihari")
  .description("Local log file polling + bash runbook engine")
  .option("--runbooks-dir <path>", "runbook directory", "./runbooks")
  .option("--state-dir <path>", "state directory", defaultStateDir())
  .option("--log-level <level>", "pino log level", process.env["MIHARI_LOG_LEVEL"] ?? "info")
  .hook("preAction", () => {
    setLogLevel(program.opts<GlobalOpts>().logLevel);
  });

program
  .command("daemon")
  .description("loop polling all runbooks at --interval seconds")
  .option("--interval <sec>", "polling interval seconds", "10")
  .action(async (cmdOpts: { interval: string }) => {
    const intervalSec = Number(cmdOpts.interval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      console.error("--interval must be > 0");
      process.exit(2);
    }
    const ctx = await bootstrap(program.opts<GlobalOpts>());
    log.info({ interval_sec: intervalSec, runbooks: ctx.runbooks.length }, "daemon started");
    let stopping = false;
    const stop = (sig: NodeJS.Signals) => {
      log.info({ sig }, "shutdown requested");
      stopping = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      await tick(ctx);
      if (stopping) break;
      await sleep(intervalSec * 1000);
    }
    log.info("daemon stopped");
  });

program
  .command("poll")
  .description("run all pollers once and execute matched runbooks")
  .option("--dry-run", "list matches without executing", false)
  .action(async (cmdOpts: { dryRun: boolean }) => {
    const ctx = await bootstrap(program.opts<GlobalOpts>());
    const result = await tick(ctx, {
      ...(cmdOpts.dryRun ? { dryRun: true, onDryRun: (m) => console.log(`[dry-run] ${m}`) } : {}),
    });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("run <id>")
  .description("execute a runbook by id without a trigger")
  .action(async (id: string) => {
    const ctx = await bootstrap(program.opts<GlobalOpts>());
    const rb = ctx.runbooks.find((r) => r.id === id);
    if (!rb) {
      console.error(`runbook not found: ${id}`);
      process.exit(1);
    }
    const event: TriggerEvent = { type: "manual", timestamp: new Date().toISOString() };
    const result = await ctx.executor.execute(rb, event);
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("list")
  .description("list runbooks")
  .action(async () => {
    const ctx = await bootstrap(program.opts<GlobalOpts>());
    if (ctx.runbooks.length === 0) {
      console.log("(no runbooks)");
      return;
    }
    for (const rb of ctx.runbooks) {
      const triggerSummary =
        rb.trigger.source === "file"
          ? `file:${rb.trigger.path}`
          : `cron:${rb.trigger.schedule}`;
      console.log(`${rb.id}\t${triggerSummary}\t${rb.description ?? ""}`);
    }
  });

program
  .command("validate <path>")
  .description("validate a runbook file or directory")
  .action(async (path: string) => {
    const abs = resolve(path);
    if (!existsSync(abs)) {
      console.error(`not found: ${abs}`);
      process.exit(1);
    }
    try {
      if (statSync(abs).isDirectory()) {
        const rbs = loadRunbooks(abs);
        console.log(`${rbs.length} runbook(s) ok`);
      } else {
        loadRunbookFile(abs);
        console.log("ok");
      }
    } catch (e) {
      if (e instanceof RunbookValidationError) {
        console.error(e.message);
      } else {
        console.error((e as Error).message);
      }
      process.exit(1);
    }
  });

interface Ctx {
  runbooks: Runbook[];
  state: StateStore;
  executor: Executor;
  pollers: FilePoller[];
  cronSchedulers: CronScheduler[];
}

async function bootstrap(opts: GlobalOpts): Promise<Ctx> {
  const runbooksDir = resolve(opts.runbooksDir);
  let runbooks: Runbook[] = [];
  if (existsSync(runbooksDir) && statSync(runbooksDir).isDirectory()) {
    try {
      runbooks = loadRunbooks(runbooksDir);
    } catch (e) {
      if (e instanceof RunbookValidationError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  } else {
    log.warn({ runbooksDir }, "runbook directory not found, continuing with no runbooks");
  }
  const state = new StateStore({ baseDir: opts.stateDir });
  const executor = createExecutor(state);
  const pollers = uniqueTriggerPaths(runbooks).map((p) => new FilePoller(p, state));
  const cronSchedulers = cronRunbooks(runbooks).map((rb) => new CronScheduler(rb, state));
  return { runbooks, state, executor, pollers, cronSchedulers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

program.parseAsync(process.argv).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
