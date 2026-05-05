import { RunbookValidationError } from "./error.js";
import {
  isObject,
  mustString,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./primitives.js";

// 全ステップ種別で共通する id / timeout_sec / on_error / capture / condition のパース。
// 各 validate*Step 関数はこれを呼び、種別固有のフィールドは個別に組み立てる。
export interface CommonStepFields {
  id: string;
  timeout_sec: number;
  on_error: "stop" | "continue";
  capture: boolean;
  condition?: "always" | "on_success" | "on_failure";
}

export function validateCommonStepFields(
  raw: Record<string, unknown>,
  file: string,
  ctx: string,
): CommonStepFields {
  const id = mustString(raw, "id", file, `${ctx}.id`);
  const timeout_sec = optionalNumber(raw, "timeout_sec", file, `${ctx}.timeout_sec`) ?? 60;
  if (timeout_sec <= 0)
    throw new RunbookValidationError(file, `${ctx}.timeout_sec must be > 0`);
  const onErrorRaw = optionalString(raw, "on_error", file, `${ctx}.on_error`) ?? "stop";
  if (onErrorRaw !== "stop" && onErrorRaw !== "continue")
    throw new RunbookValidationError(file, `${ctx}.on_error must be "stop" or "continue"`);
  const capture = optionalBoolean(raw, "capture", file, `${ctx}.capture`) ?? false;
  const conditionRaw = optionalString(raw, "condition", file, `${ctx}.condition`);
  if (
    conditionRaw !== undefined &&
    conditionRaw !== "always" &&
    conditionRaw !== "on_success" &&
    conditionRaw !== "on_failure"
  )
    throw new RunbookValidationError(
      file,
      `${ctx}.condition must be "always", "on_success", or "on_failure"`,
    );
  const condition = conditionRaw as CommonStepFields["condition"];
  const out: CommonStepFields = { id, timeout_sec, on_error: onErrorRaw, capture };
  if (condition !== undefined) out.condition = condition;
  return out;
}

export function validateEnv(
  raw: unknown,
  file: string,
  ctx: string,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
      throw new RunbookValidationError(file, `${ctx}.${k} must be a string/number/boolean`);
    out[k] = String(v);
  }
  return out;
}
