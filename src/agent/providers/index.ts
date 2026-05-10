import type { Provider } from "../../types/index.js";
import { datadog } from "./datadog.js";
import { jira } from "./jira.js";
import { slack } from "./slack.js";

export interface ProviderSpec {
  name: Provider;
  requiredEnv: string[];
  preamble: string;
}

const SPECS: Record<Provider, ProviderSpec> = {
  datadog,
  jira,
  slack,
};

export const PROVIDERS: readonly Provider[] = ["datadog", "jira", "slack"];

export function isProvider(s: string): s is Provider {
  return (PROVIDERS as readonly string[]).includes(s);
}

export function providerSpec(name: Provider): ProviderSpec {
  return SPECS[name];
}

export function composePreambles(names: readonly Provider[]): string {
  return names.map((n) => SPECS[n].preamble).join("\n\n---\n\n");
}

export function missingEnv(
  names: readonly Provider[],
  env: NodeJS.ProcessEnv,
): { provider: Provider; vars: string[] }[] {
  const out: { provider: Provider; vars: string[] }[] = [];
  for (const n of names) {
    const vars = SPECS[n].requiredEnv.filter((v) => !env[v]);
    if (vars.length > 0) out.push({ provider: n, vars });
  }
  return out;
}
