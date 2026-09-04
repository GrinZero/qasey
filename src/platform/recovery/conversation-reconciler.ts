import type { QaseyConversationRepository } from "../../../packages/domain/src/index.ts";

/**
 * Converts conversation turns abandoned by a crashed or replaced runtime into
 * retryable failures. The grace period is intentionally separate from the
 * polling interval so a normal Agent deadline has time to finalize itself.
 */
export class StaleConversationReconciler {
  constructor(
    private readonly conversations: Pick<QaseyConversationRepository, "failStale">,
    private readonly staleAfterMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new Error("Conversation stale threshold must be positive");
    }
  }

  runOnce(): Promise<number> {
    return this.conversations.failStale(new Date(this.now().getTime() - this.staleAfterMs));
  }
}
