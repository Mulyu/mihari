import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentContext, TriggerEvent } from "../src/types/index.js";
import { fakeAgent } from "./_fixtures.js";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

const { runAgent, composeSystemPrompt, matchesAllowedTools } = await import(
  "../src/agent/runner.js"
);

const cronEvent: TriggerEvent = {
  type: "cron",
  timestamp: "2026-04-26T00:00:00Z",
};

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return { event: cronEvent, idempotencyKey: "test-key", ...over };
}

function successAsync(text: string) {
  return (async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: text,
      num_turns: 1,
      duration_ms: 5,
    };
  })();
}

function errorAsync(subtype: string) {
  return (async function* () {
    yield {
      type: "result",
      subtype,
      num_turns: 1,
      duration_ms: 5,
    };
  })();
}

describe("matchesAllowedTools", () => {
  it("matches plain tool names", () => {
    expect(matchesAllowedTools("Read", {}, ["Read"])).toBe(true);
    expect(matchesAllowedTools("Write", {}, ["Read"])).toBe(false);
  });

  it("matches Bash exact and prefix patterns", () => {
    const patterns = ["Bash(git status)", "Bash(curl:*)"];
    expect(matchesAllowedTools("Bash", { command: "git status" }, patterns)).toBe(true);
    expect(matchesAllowedTools("Bash", { command: "git status -s" }, patterns)).toBe(false);
    expect(matchesAllowedTools("Bash", { command: "curl -s https://x" }, patterns)).toBe(true);
    expect(matchesAllowedTools("Bash", { command: "curl" }, patterns)).toBe(true);
    expect(matchesAllowedTools("Bash", { command: "curling" }, patterns)).toBe(false);
  });
});

describe("composeSystemPrompt", () => {
  it("returns undefined when nothing is set", () => {
    const a: Agent = fakeAgent({ providers: [], conventions: false });
    expect(composeSystemPrompt(a, undefined)).toBeUndefined();
  });

  it("includes conventions preamble when conventions=true", () => {
    const a: Agent = fakeAgent({ conventions: true });
    const out = composeSystemPrompt(a, undefined);
    expect(out).toContain("MIHARI_IDEMPOTENCY_KEY");
    expect(out).toContain("git status --porcelain");
  });

  it("appends provider preambles in declared order", () => {
    const a: Agent = fakeAgent({ providers: ["jira", "datadog"] });
    const out = composeSystemPrompt(a, undefined);
    const jiraIdx = out!.indexOf("Jira provider");
    const ddIdx = out!.indexOf("Datadog provider");
    expect(jiraIdx).toBeGreaterThanOrEqual(0);
    expect(ddIdx).toBeGreaterThan(jiraIdx);
  });

  it("appends user system prompt last", () => {
    const a: Agent = fakeAgent({ providers: ["slack"] });
    const out = composeSystemPrompt(a, "Custom user system");
    const slackIdx = out!.indexOf("Slack provider");
    const userIdx = out!.indexOf("Custom user system");
    expect(slackIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(slackIdx);
  });
});

describe("runAgent: result handling", () => {
  beforeEach(() => mockQuery.mockReset());
  afterEach(() => mockQuery.mockReset());

  it("treats success as ok with trimmed stdout", async () => {
    mockQuery.mockReturnValueOnce(successAsync("done\n\n"));
    const r = await runAgent(fakeAgent(), ctx());
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe("done");
    expect(r.error).toBeNull();
  });

  it("treats non-success subtype as failure with descriptive error", async () => {
    mockQuery.mockReturnValueOnce(errorAsync("error_max_turns"));
    const r = await runAgent(fakeAgent(), ctx());
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(1);
    expect(r.error).toContain("error_max_turns");
  });

  it("returns timed_out=true when SDK throws AbortError", async () => {
    mockQuery.mockImplementationOnce(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const r = await runAgent(fakeAgent({ timeout_sec: 1 }), ctx());
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(r.error).toContain("timeout");
  });

  it("returns ok=false with the SDK error message on a thrown error", async () => {
    mockQuery.mockImplementationOnce(() => {
      throw new Error("auth fail");
    });
    const r = await runAgent(fakeAgent(), ctx());
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(false);
    expect(r.error).toBe("auth fail");
  });
});

describe("runAgent: SDK options wiring", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env["MIHARI_TEST_HOST"] = "host-from-env";
  });
  afterEach(() => {
    delete process.env["MIHARI_TEST_HOST"];
  });

  it("substitutes templates in prompt and system before calling SDK", async () => {
    mockQuery.mockReturnValueOnce(successAsync("ok"));
    await runAgent(
      fakeAgent({
        prompt: "host={{ env.MIHARI_TEST_HOST }} ts={{ event.timestamp }}",
        system: "sys={{ event.timestamp }}",
        providers: [],
        conventions: false,
      }),
      ctx(),
    );
    const args = mockQuery.mock.calls[0]?.[0] as { prompt: string; options: Record<string, unknown> };
    expect(args.prompt).toBe("host=host-from-env ts=2026-04-26T00:00:00Z");
    const sysOpt = args.options["systemPrompt"] as { append: string };
    expect(sysOpt.append).toBe("sys=2026-04-26T00:00:00Z");
  });

  it("forwards permission_mode=bypass with allowDangerouslySkipPermissions", async () => {
    mockQuery.mockReturnValueOnce(successAsync("ok"));
    await runAgent(fakeAgent({ permission_mode: "bypass" }), ctx());
    const opts = mockQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(opts["permissionMode"]).toBe("bypassPermissions");
    expect(opts["allowDangerouslySkipPermissions"]).toBe(true);
    expect(opts["canUseTool"]).toBeUndefined();
  });

  it("installs canUseTool that denies tools outside allowed_tools when strict", async () => {
    mockQuery.mockReturnValueOnce(successAsync("ok"));
    await runAgent(
      fakeAgent({ permission_mode: "strict", allowed_tools: ["Read"] }),
      ctx(),
    );
    const opts = mockQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    const canUseTool = opts["canUseTool"] as (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    expect((await canUseTool("Read", {})).behavior).toBe("allow");
    expect((await canUseTool("Write", {})).behavior).toBe("deny");
  });

  it("passes MIHARI_IDEMPOTENCY_KEY to the agent env", async () => {
    mockQuery.mockReturnValueOnce(successAsync("ok"));
    await runAgent(fakeAgent(), ctx({ idempotencyKey: "key-123" }));
    const opts = mockQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    const env = opts["env"] as Record<string, string>;
    expect(env["MIHARI_IDEMPOTENCY_KEY"]).toBe("key-123");
  });
});
