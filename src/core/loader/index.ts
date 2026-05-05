import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { Runbook } from "../../types.js";
import { RunbookValidationError } from "./error.js";
import { validateRunbook } from "./runbook.js";

export { RunbookValidationError } from "./error.js";

export function loadRunbooks(dir: string): Runbook[] {
  const files = listYamlFiles(dir);
  const runbooks = files.map((f) => parseRunbookFile(f));
  assertUniqueIds(runbooks);
  return runbooks;
}

export function loadRunbookFile(path: string): Runbook {
  return parseRunbookFile(resolve(path));
}

function listYamlFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) continue;
    if (!/\.ya?ml$/.test(entry.name)) continue;
    out.push(full);
  }
  return out.sort();
}

function parseRunbookFile(file: string): Runbook {
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new RunbookValidationError(file, `YAML parse error: ${(e as Error).message}`);
  }
  return validateRunbook(raw, file);
}

function assertUniqueIds(rbs: Runbook[]): void {
  const seen = new Map<string, string>();
  for (const rb of rbs) {
    const prev = seen.get(rb.id);
    if (prev) {
      throw new RunbookValidationError(
        rb.sourcePath,
        `duplicate runbook id "${rb.id}" (also in ${prev})`,
      );
    }
    seen.set(rb.id, rb.sourcePath);
  }
}
