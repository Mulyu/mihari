export class RunbookValidationError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "RunbookValidationError";
  }
}
