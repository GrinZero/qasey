import { E2E_AGENT_ID, type E2ERun, type OwnerScope } from "../../contracts/src/index.ts";
import { type CollaborationScope, CollaborationRepository } from "./collaboration-repository.ts";

/** Durable instruction receipts shared by the conversation worker and lifecycle worker. */
export class CollaborationExecutionBridge {
  constructor(private repository: CollaborationRepository) {}
  private async scope(run: E2ERun): Promise<CollaborationScope | undefined> {
    return (await this.repository.scopes()).find(s => s.applicationId === run.applicationId && s.tenantId === run.tenantId && s.conversationId === run.sourceSessionId);
  }
  async take(run: E2ERun, attemptId: string): Promise<Array<{ id: string; text: string }>> {
    const scope = await this.scope(run);
    if (!scope) return [];
    return this.repository.change(scope, state => {
      const link = state.runs.find(r => r.runId === run.id);
      if (link) link.acceptingInstructions = true;
      return state.instructions.filter(i => i.runId === run.id && i.status !== "applied").map(i => {
      i.status = "applying"; i.attemptId = attemptId;
      return { id: i.id, text: i.text };
      });
    });
  }
  async applied(run: E2ERun, attemptId: string): Promise<void> {
    const scope = await this.scope(run);
    if (!scope) return;
    await this.repository.change(scope, state => {
      for (const i of state.instructions.filter(i => i.runId === run.id && i.attemptId === attemptId && i.status === "applying")) {
        i.status = "applied";
        state.messages.push({ id: `instruction:${i.id}:applied`, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: "completed", text: `补充要求已应用于本次编写，接下来进行独立验证。\n${i.text}`, createdAt: new Date().toISOString(), replyTo: i.messageId, runId: run.id, rootMessageId: i.messageId });
      }
    });
  }
  async sealForReview(run: E2ERun): Promise<boolean> {
    const scope = await this.scope(run);
    if (!scope) return true;
    return this.repository.change(scope, state => {
      if (state.instructions.some(i => i.runId === run.id && i.status !== "applied")) return false;
      const link = state.runs.find(r => r.runId === run.id);
      if (link) link.acceptingInstructions = false;
      return true;
    });
  }
  async pending(run: E2ERun): Promise<boolean> {
    const scope = await this.scope(run);
    if (!scope) return false;
    return (await this.repository.read(scope)).instructions.some(i => i.runId === run.id && i.status !== "applied");
  }
}
