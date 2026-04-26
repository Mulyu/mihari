#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import pino from "pino";
import {
  loadRunbookFile,
  loadRunbooks,
  RunbookValidationError,
} from "./core/runbook-loader.js";
import { match, uniqueTriggerPaths } from "./core/matcher.js";
import { StateStore, defaultStateDir } from "./core/state.js";
import { createExecutor } from "./core/executor.js";
import { FilePoller } from "./pollers/file.js";
import { CronScheduler, cronRunbooks } from "./pollers/cron.js";
import type { Runbook } from "./types.js";

const log = pino({ name: "mihari" });

interface GlobalOpts {
  runbooksDir: string;
  stateDir: string;
  logLevel: string;
}

function applyGlobals(opts: GlobalOpts): void {
  pino.levels.values; // ensure module is initialized
  log.level = opts.logLevel;
}

const program = new Command();
program
  .name("mihari")
  .description("Local log file polling + bash runbook engine")
  .option("--runbooks-dir <path>", "runbook directory", "./runbooks")
  .option("--state-dir <path>", "state directory", defaultStateDir())
  .option("--log-level <level>", "pino log level", process.env["MIHARI_LOG_LEVEL"] ?? "info");

program
  .command("daemon")
  .description("loop polling all runbooks at --interval seconds")
  .option("--interval <sec>", "polling interval seconds", "10")
  .action(async (cmdOpts: { interval: string }) => {
    const opts = program.opts<GlobalOpts>();
    applyGlobals(opts);
    const intervalSec = Number(cmdOpts.interval);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      console.error("--interval must be > 0");
      process.exit(2);
    }
    const ctx = await bootstrap(opts);
    log.info({ interval_sec: intervalSec, runbooks: ctx.runbooks.length }, "daemon started");
    let stopping = false;
    const stop = (sig: NodeJS.Signals) => {
      log.info({ sig }, "shutdown requested");
      stopping = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      await runOneTick(ctx);
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
    const opts = program.opts<GlobalOpts>();
    applyGlobals(opts);
    const ctx = await bootstrap(opts);
    const ok = await runOneTick(ctx, { dryRun: cmdOpts.dryRun });
    process.exit(ok ? 0 : 1);
  });

program
  .command("run <id>")
  .description("execute a runbook by id without a trigger")
  .action(async (id: string) => {
    const opts = program.opts<GlobalOpts>();
    applyGlobals(opts);
    const ctx = await bootstrap(opts);
    const rb = ctx.runbooks.find((r) => r.id === id);
    if (!rb) {
      console.error(`runbook not found: ${id}`);
      process.exit(1);
    }
    const result = await ctx.executor.executeBare(rb);
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("list")
  .description("list runbooks")
  .action(async () => {
    const opts = program.opts<GlobalOpts>();
    applyGlobals(opts);
    const ctx = await bootstrap(opts);
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
  executor: ReturnType<typeof createExecutor>;
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

async function runOneTick(ctx: Ctx, opts: { dryRun?: boolean } = {}): Promise<boolean> {
  let allOk = true;
  for (const poller of ctx.pollers) {
    const lines = await poller.tick();
    for (const line of lines) {
      const matches = match(line, ctx.runbooks);
      for (const m of matches) {
        if (opts.dryRun) {
          console.log(`[dry-run] ${m.runbook.id} <- ${line.path}: ${line.content}`);
          continue;
        }
        const result = await ctx.executor.execute(m);
        if (!result.ok) allOk = false;
      }
    }
  }
  for (const scheduler of ctx.cronSchedulers) {
    const fired = await scheduler.tick();
    if (!fired) continue;
    if (opts.dryRun) {
      console.log(`[dry-run] ${scheduler.runbook.id} <- cron@${fired.timestamp}`);
      continue;
    }
    const result = await ctx.executor.execute({ runbook: scheduler.runbook, line: fired });
    if (!result.ok) allOk = false;
  }
  return allOk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

program.parseAsync(process.argv).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
