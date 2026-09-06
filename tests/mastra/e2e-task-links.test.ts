import { describe, expect, it } from "vitest";
import { InMemoryQaseyConversationRepository } from "../../packages/domain/src/conversation-repository.ts";
import { QaseyUIMessageSchema } from "../../packages/contracts/src/index.ts";
import { e2eTaskFromTurn, reviewPlanTasks } from "../../src/mastra/applications/qasey/e2e-task-links.ts";
import { conversationEventStreamResponse, conversationTurnsToUIMessages } from "../../src/mastra/applications/qasey/ui-message.ts";

const owner = { applicationId: "qasey", tenantId: "public-test" };
const context = { planId: "11111111-1111-4111-8111-111111111111", cases: [{ caseId: "QASEY-1", caseVersionId: "22222222-2222-4222-8222-222222222222", version: 3, title: "Public example" }] };

describe("E2E task conversation links", () => {
  it("persists the exact selection with acceptance, deduplicates retries and restores a tenant-scoped link", async () => {
    const repository = new InMemoryQaseyConversationRepository();
    const conversation = await repository.createConversation(owner, "qa-user");
    const clientId = "33333333-3333-4333-8333-333333333333";
    const started = await repository.startTurn(owner, "qa-user", conversation.id, clientId, "Generate E2E", context);
    const duplicate = await repository.startTurn(owner, "qa-user", conversation.id, clientId, "Different input", { ...context, cases: [{ ...context.cases[0]!, version: 4 }] });
    expect(duplicate.created).toBe(false);
    expect(e2eTaskFromTurn(duplicate)).toEqual(e2eTaskFromTurn(started));
    expect((await reviewPlanTasks(repository, owner, "qa-user", conversation.id, context.planId))[0]).toMatchObject({ turnId: started.turn.id, context });
    expect(await reviewPlanTasks(repository, owner, "other-user", conversation.id, context.planId)).toEqual([]);
    expect(await reviewPlanTasks(repository, { ...owner, tenantId: "other-tenant" }, "qa-user", conversation.id, context.planId)).toEqual([]);
    expect(await reviewPlanTasks(repository, owner, "qa-user", conversation.id, "other-plan")).toEqual([]);
  });

  it("projects context in history and resumed streams after the accepted cursor", async () => {
    const repository = new InMemoryQaseyConversationRepository();
    const conversation = await repository.createConversation(owner, "qa-user");
    const started = await repository.startTurn(owner, "qa-user", conversation.id, "44444444-4444-4444-8444-444444444444", "Generate E2E", context);
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "completed", { text: "Ready for review" });
    const turns = await repository.listTurns(owner, "qa-user", conversation.id);
    const events = await repository.events(owner, "qa-user", conversation.id, started.turn.id);
    const messages = conversationTurnsToUIMessages(turns, new Map([[started.turn.id, events]]));
    expect(messages[1]?.metadata?.e2eContext).toEqual(context);
    expect(QaseyUIMessageSchema.safeParse(messages[1]).success).toBe(true);
    const response = conversationEventStreamResponse({ repository, owner, subjectId: "qa-user", conversationId: conversation.id, turn: turns[0]!, after: 1, signal: new AbortController().signal });
    const stream = await response.text();
    expect(stream).toContain('"e2eContext"');
    expect(stream).toContain('"version":3');
    expect((await reviewPlanTasks(repository, owner, "qa-user", conversation.id, context.planId))[0]?.status).toBe("completed");
  });
});
