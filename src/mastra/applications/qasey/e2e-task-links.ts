import { QaseyE2EContextSchema, type OwnerScope, type QaseyE2ETask } from "../../../../packages/contracts/src/index.ts";
import type { QaseyConversationRepository, StartedConversationTurn } from "../../../../packages/domain/src/conversation-repository.ts";

export function e2eTaskFromTurn(started: Pick<StartedConversationTurn, "turn" | "accepted">): QaseyE2ETask | undefined {
  const parsed = QaseyE2EContextSchema.safeParse(started.accepted.payload.e2eContext);
  if (!parsed.success) return undefined;
  return {
    conversationId: started.turn.conversationId, turnId: started.turn.id,
    status: started.turn.status, createdAt: started.turn.createdAt, context: parsed.data,
  };
}

export async function reviewPlanTasks(repository: QaseyConversationRepository, owner: OwnerScope, subjectId: string, conversationId: string, planId: string): Promise<QaseyE2ETask[]> {
  const turns = await repository.listTurns(owner, subjectId, conversationId);
  const tasks = await Promise.all(turns.map(async turn => {
    const events = await repository.events(owner, subjectId, conversationId, turn.id);
    const accepted = events.find(event => event.type === "accepted");
    return accepted ? e2eTaskFromTurn({ turn, accepted }) : undefined;
  }));
  return tasks.flatMap(task => task?.context.planId === planId ? [task] : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
