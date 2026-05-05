import type { BashStep } from "../types.js";
import { RunbookValidationError } from "./error.js";
import { isObject, mustString } from "./primitives.js";
import { validateCommonStepFields, validateEnv } from "./step-common.js";

export function validateBashStep(raw: unknown, file: string, ctx: string): BashStep {
  if (!isObject(raw)) throw new RunbookValidationError(file, `${ctx} must be a mapping`);
  if (!("bash" in raw))
    throw new RunbookValidationError(
      file,
      `${ctx} must have a bash field (only bash steps are supported in MVP)`,
    );
  const bash = mustString(raw, "bash", file, `${ctx}.bash`);
  const env = validateEnv(raw["env"], file, `${ctx}.env`);
  const common = validateCommonStepFields(raw, file, ctx);
  const step: BashStep = {
    id: common.id,
    bash,
    timeout_sec: common.timeout_sec,
    on_error: common.on_error,
    env,
    capture: common.capture,
  };
  if (common.condition !== undefined) step.condition = common.condition;
  return step;
}
