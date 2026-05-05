import { RunbookValidationError } from "./error.js";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mustString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0)
    throw new RunbookValidationError(file, `${ctx ?? key} must be a non-empty string`);
  return v;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string")
    throw new RunbookValidationError(file, `${ctx ?? key} must be a string`);
  return v;
}

export function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new RunbookValidationError(file, `${ctx ?? key} must be a finite number`);
  return v;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  ctx?: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean")
    throw new RunbookValidationError(file, `${ctx ?? key} must be a boolean`);
  return v;
}
