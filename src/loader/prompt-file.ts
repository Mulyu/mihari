import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RunbookValidationError } from "./error.js";
import { mustString } from "./primitives.js";

// "<key>" / "<key>_file" の相互排他読み出し。
// 両方指定したらエラー、どちらも無ければ undefined。
// `_file` が指定されたらランブック YAML からの相対パスとして読み出す。
export function readPromptOrFile(
  cfgRaw: Record<string, unknown>,
  file: string,
  ctxBase: string,
  runbookFile: string,
  key: string,
  fileKey: string,
): string | undefined {
  const hasInline = key in cfgRaw;
  const hasFile = fileKey in cfgRaw;
  if (hasInline && hasFile)
    throw new RunbookValidationError(
      file,
      `${ctxBase} cannot have both "${key}" and "${fileKey}"`,
    );
  if (!hasInline && !hasFile) return undefined;
  if (hasFile) {
    const relPath = mustString(cfgRaw, fileKey, file, `${ctxBase}.${fileKey}`);
    const absPath = resolve(dirname(runbookFile), relPath);
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      throw new RunbookValidationError(
        file,
        `${ctxBase}.${fileKey}: cannot read file: ${absPath}`,
      );
    }
  }
  return mustString(cfgRaw, key, file, `${ctxBase}.${key}`);
}
