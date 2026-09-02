export interface Closeable { close(): void | Promise<void>; }

export class LifecycleContainer implements Closeable {
  private readonly resources: Closeable[] = [];
  private closed = false;

  own<T extends Closeable>(resource: T): T {
    if (this.closed) throw new Error("Lifecycle container is already closed");
    this.resources.push(resource);
    return resource;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const resource of [...this.resources].reverse()) {
      try { await resource.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more runtime resources failed to close");
  }
}

