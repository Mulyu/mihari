import { logger } from "../lib/logger.js";
import type { Agent, AgentContext, AgentResult } from "../types/index.js";
import { composePreambles } from "./providers/index.js";
import { captureStdout, substituteTemplate } from "./template.js";

const log = logger("agent");

const CONVENTIONS_PREAMBLE = `# mihari conventions

You are running as a mihari agent. The following operational conventions
apply WHEN your task involves opening a pull request in a git repository
— for non-PR tasks ignore them and proceed normally.

A deterministic key for this run is exposed as $MIHARI_IDEMPOTENCY_KEY.
The same trigger observed twice produces the same key, so the conventions
below let you detect and skip duplicate work.

Before making any change, run these checks in order and stop early on a hit:
  1. \`git status --porcelain\` — if it prints anything, stop and report
     "skip: dirty tree". Do not modify any file.
  2. \`git ls-remote --exit-code origin "refs/heads/claude/fix-$MIHARI_IDEMPOTENCY_KEY"\`
     — if it succeeds, stop and report "skip: branch exists".
  3. \`gh pr list --state open --search "$MIHARI_IDEMPOTENCY_KEY in:title"\` —
     if any PR is returned, stop and report "skip: PR exists <url>".

If all three checks pass:
  - Use exactly \`claude/fix-$MIHARI_IDEMPOTENCY_KEY\` as the branch name.
  - Include \`[$MIHARI_IDEMPOTENCY_KEY]\` somewhere in the PR title so future
    runs can recognise the duplicate.

Set \`conventions: false\` on the agent to disable this preamble entirely.`;

export function matchesAllowedTools(
  toolName: string,
  input: Record<string, unknown>,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p === toolName) return true;
    const m = /^([A-Za-z][A-Za-z0-9]*)\((.+)\)$/.exec(p);
    if (!m) continue;
    if (m[1] !== toolName) continue;
    if (toolName !== "Bash") continue;
    const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
    const spec = m[2] as string;
    if (spec.endsWith(":*")) {
      const prefix = spec.slice(0, -2);
      if (command === prefix || command.startsWith(prefix + " ")) return true;
    } else if (spec === command) {
      return true;
    }
  }
  return false;
}

export function composeSystemPrompt(agent: Agent, userSystem: string | undefined): string | undefined {
  const parts: string[] = [];
  if (agent.conventions) parts.push(CONVENTIONS_PREAMBLE);
  if (agent.providers.length > 0) parts.push(composePreambles(agent.providers));
  if (userSystem !== undefined) parts.push(userSystem);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n---\n\n");
}

export async function runAgent(agent: Agent, ctx: AgentContext): Promise<AgentResult> {
  const start = Date.now();
  const prompt = substituteTemplate(agent.prompt, ctx);
  const userSystem = agent.system !== undefined ? substituteTemplate(agent.system, ctx) : undefined;
  const composedSystem = composeSystemPrompt(agent, userSystem);

  const cwd = agent.cwd ?? process.cwd();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agent.timeout_sec * 1000);

  let stdout = "";
  let ok = false;
  let errorMessage: string | null = null;
  let timedOut = false;

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const sdkPermissionMode = agent.permission_mode === "bypass" ? "bypassPermissions" : "default";
    const baseOptions: Record<string, unknown> = {
      cwd,
      model: agent.model,
      abortController: controller,
      permissionMode: sdkPermissionMode,
      allowedTools: agent.allowed_tools,
      maxTurns: agent.max_turns,
      env: { ...process.env, MIHARI_IDEMPOTENCY_KEY: ctx.idempotencyKey },
    };
    if (composedSystem !== undefined) {
      baseOptions["systemPrompt"] = {
        type: "preset",
        preset: "claude_code",
        append: composedSystem,
      };
    }
    if (agent.permission_mode === "bypass") {
      baseOptions["allowDangerouslySkipPermissions"] = true;
    } else {
      const allowed = agent.allowed_tools;
      baseOptions["canUseTool"] = async (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        if (matchesAllowedTools(toolName, input, allowed)) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return {
          behavior: "deny" as const,
          message: `tool ${toolName} not in allowed_tools`,
        };
      };
    }

    const q = query({
      prompt,
      options: baseOptions as import("@anthropic-ai/claude-agent-sdk").Options,
    });

    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          stdout = msg.result;
          ok = true;
        } else {
          ok = false;
          errorMessage = `agent ${msg.subtype}: num_turns=${msg.num_turns}`;
        }
        log.debug(
          {
            subtype: msg.subtype,
            num_turns: msg.num_turns,
            duration_ms: msg.duration_ms,
          },
          "agent done",
        );
        break;
      }
    }
  } catch (err) {
    timedOut = (err as Error).name === "AbortError";
    errorMessage = timedOut
      ? `timeout after ${agent.timeout_sec}s`
      : (err as Error).message;
    log.warn({ err: errorMessage }, "agent error");
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  return {
    ok,
    exit_code: ok ? 0 : 1,
    stdout: ok ? captureStdout(stdout) : stdout,
    duration_ms: Date.now() - start,
    timed_out: timedOut,
    error: errorMessage,
  };
}
