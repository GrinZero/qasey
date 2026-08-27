export class ReconcilerLoop {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private lastError: Error | undefined;
  private lastSuccessAt?: Date;

  constructor(
    private readonly operation: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 5_000) throw new Error("Reconciler interval must be at least five seconds");
  }

  start(): this {
    if (this.timer || this.closed) return this;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
    this.tick();
    return this;
  }

  async healthCheck(): Promise<void> {
    if (this.closed) throw new Error("Run reconciler is closed");
    if (this.lastError && (!this.lastSuccessAt || this.lastSuccessAt.getTime() < this.lastErrorTimestamp)) throw this.lastError;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }

  private lastErrorTimestamp = 0;

  private tick(): void {
    if (this.closed || this.active) return;
    this.active = this.operation()
      .then(() => {
        this.lastSuccessAt = new Date();
        this.lastError = undefined;
      })
      .catch(error => {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.lastErrorTimestamp = Date.now();
        this.onError(this.lastError);
      })
      .finally(() => { this.active = undefined; });
  }
}
