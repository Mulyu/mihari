#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { Cron } from "croner";
import { logger, setLogLevel } from "../lib/logger.js";
import {
  loadRunbookFile,
  loadRunbooks,
  RunbookValidationError,
} from "../loader/index.js";
import { uniqueTriggerPaths } from "../engine/matcher.js";
import { StateStore, defaultStateDir } from "../state/store.js";
import { createExecutor, type Executor } from "../engine/executor.js";
import { tick } from "../engine/dispatcher.js";
import { FilePoller } from "../triggers/file.js";
import { CronScheduler, cronRunbooks } from "../triggers/cron.js";
import {
  CloudWatchLogsPoller,
  createCloudWatchLogsApiFactory,
  uniqueCloudWatchLogsTriggers,
} from "../triggers/cloudwatch-logs.js";
import type { Runbook, Trigger, TriggerEvent } from "../types/index.js";

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
    let sigint = false;
    const stop = (sig: NodeJS.Signals) => {
      log.info({ sig }, "shutdown requested");
      stopping = true;
      if (sig === "SIGINT") sigint = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      await tick(ctx);
      if (stopping) break;
      await sleep(intervalSec * 1000);
    }
    log.info("daemon stopped");
    process.exit(sigint ? 130 : 0);
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
      console.log(`${rb.id}\t${triggerSummary(rb.trigger)}\t${rb.description ?? ""}`);
    }
  });

program
  .command("history [run_id]")
  .description("show run history (or details of a single run)")
  .option("--runbook <id>", "filter by runbook id")
  .option("--limit <n>", "max records (default 20)", "20")
  .option("--since <date>", "only show runs on or after YYYY-MM-DD")
  .option("--json", "emit JSON")
  .action(
    async (
      runId: string | undefined,
      cmdOpts: { runbook?: string; limit: string; since?: string; json?: boolean },
    ) => {
      const ctx = await bootstrap(program.opts<GlobalOpts>());
      if (runId) {
        const run = ctx.state.getRun(runId);
        if (!run) {
          console.error(`run not found: ${runId}`);
          process.exit(1);
        }
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      const limit = Number(cmdOpts.limit);
      if (!Number.isFinite(limit) || limit <= 0) {
        console.error("--limit must be > 0");
        process.exit(2);
      }
      const runs = ctx.state.listRuns({
        limit,
        ...(cmdOpts.runbook ? { runbookId: cmdOpts.runbook } : {}),
        ...(cmdOpts.since ? { since: cmdOpts.since } : {}),
      });
      if (cmdOpts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("(no runs)");
        return;
      }
      for (const r of runs) {
        const status = r.ok ? "ok" : "FAIL";
        const dur = r.steps.reduce((s, x) => s + x.duration_ms, 0);
        console.log(
          `${r.started_at}\t${r.run_id}\t${r.runbook_id}\t${status}\t${dur}ms`,
        );
      }
    },
  );

program
  .command("status")
  .description("show last run and next scheduled fire for each runbook")
  .action(async () => {
    const ctx = await bootstrap(program.opts<GlobalOpts>());
    if (ctx.runbooks.length === 0) {
      console.log("(no runbooks)");
      return;
    }
    for (const rb of ctx.runbooks) {
      const [lastRun] = ctx.state.listRuns({ limit: 1, runbookId: rb.id });
      const lastAt = lastRun?.started_at ?? "(never)";
      const status = lastRun ? (lastRun.ok ? "ok" : "FAIL") : "-";
      let next = "-";
      if (rb.trigger.source === "cron") {
        const trigState = ctx.state.loadTriggerState(rb.id);
        if (trigState) {
          const cronObj = new Cron(rb.trigger.schedule);
          const nextDate = cronObj.nextRun(new Date(trigState.last_fired_at));
          if (nextDate) next = nextDate.toISOString();
        }
      }
      const prefix = rb.enabled === false ? "[disabled] " : "";
      console.log(
        `${prefix}${rb.id}\t${triggerSummary(rb.trigger)}\t${lastAt}\t${status}\t${next}`,
      );
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
  cloudWatchLogsPollers: CloudWatchLogsPoller[];
}

function triggerSummary(t: Trigger): string {
  if (t.source === "file") return `file:${t.path}`;
  if (t.source === "cron") return `cron:${t.schedule}`;
  return `cloudwatch_logs:${t.region}/${t.log_group}`;
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

  const cwGroups = uniqueCloudWatchLogsTriggers(runbooks);
  const cloudWatchLogsPollers: CloudWatchLogsPoller[] = [];
  if (cwGroups.length > 0) {
    const factory = await createCloudWatchLogsApiFactory();
    for (const g of cwGroups) {
      cloudWatchLogsPollers.push(
        new CloudWatchLogsPoller(
          { region: g.region, logGroup: g.logGroup },
          g.intervalSec,
          state,
          factory.forRegion(g.region),
        ),
      );
    }
  }

  return { runbooks, state, executor, pollers, cronSchedulers, cloudWatchLogsPollers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

program.parseAsync(process.argv).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
