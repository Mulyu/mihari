import { describe, expect, it } from "vitest";
import {
  composePreambles,
  isProvider,
  missingEnv,
  PROVIDERS,
  providerSpec,
} from "../src/agent/providers/index.js";

describe("PROVIDERS / isProvider", () => {
  it("lists the supported providers in literal lowercase", () => {
    expect([...PROVIDERS].sort()).toEqual(["datadog", "jira", "slack"]);
  });

  it("isProvider rejects unknown literals", () => {
    expect(isProvider("datadog")).toBe(true);
    expect(isProvider("jira")).toBe(true);
    expect(isProvider("slack")).toBe(true);
    expect(isProvider("Datadog")).toBe(false);
    expect(isProvider("pagerduty")).toBe(false);
    expect(isProvider("")).toBe(false);
  });
});

describe("providerSpec", () => {
  it("each provider declares required env and a non-empty preamble", () => {
    for (const name of PROVIDERS) {
      const spec = providerSpec(name);
      expect(spec.name).toBe(name);
      expect(spec.requiredEnv.length).toBeGreaterThan(0);
      expect(spec.preamble.length).toBeGreaterThan(0);
      for (const v of spec.requiredEnv) {
        expect(spec.preamble).toContain(`$${v}`);
      }
    }
  });
});

describe("composePreambles", () => {
  it("returns empty string for empty input", () => {
    expect(composePreambles([])).toBe("");
  });

  it("preserves declared order and joins with a horizontal rule", () => {
    const out = composePreambles(["jira", "datadog"]);
    const jiraIdx = out.indexOf(providerSpec("jira").preamble);
    const ddIdx = out.indexOf(providerSpec("datadog").preamble);
    expect(jiraIdx).toBeGreaterThanOrEqual(0);
    expect(ddIdx).toBeGreaterThan(jiraIdx);
    expect(out).toContain("\n\n---\n\n");
  });
});

describe("missingEnv", () => {
  it("reports providers whose required env is missing", () => {
    const env = { JIRA_BASE: "x", JIRA_USER: "u", JIRA_TOKEN: "t" } as NodeJS.ProcessEnv;
    const out = missingEnv(["datadog", "jira", "slack"], env);
    const byName = Object.fromEntries(out.map((m) => [m.provider, m.vars]));
    expect(byName["datadog"]).toEqual(["DD_API_KEY", "DD_APP_KEY", "DD_SITE"]);
    expect(byName["jira"]).toBeUndefined();
    expect(byName["slack"]).toEqual(["SLACK_WEBHOOK_URL"]);
  });

  it("returns no entries when everything is set", () => {
    const env: NodeJS.ProcessEnv = {
      DD_API_KEY: "1",
      DD_APP_KEY: "1",
      DD_SITE: "datadoghq.com",
      JIRA_BASE: "1",
      JIRA_USER: "1",
      JIRA_TOKEN: "1",
      SLACK_WEBHOOK_URL: "1",
    };
    expect(missingEnv(["datadog", "jira", "slack"], env)).toEqual([]);
  });
});
