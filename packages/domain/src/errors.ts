export class IncompleteOutcomeError extends Error {
  readonly code = "INCOMPLETE_OUTCOME";

  constructor(message: string) {
    super(message);
    this.name = "IncompleteOutcomeError";
  }
}
