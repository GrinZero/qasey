import { describe, expect, it } from "vitest";
import { CollaborationRepository } from "../../packages/domain/src/collaboration-repository.ts";
import { InMemoryQaseyConversationRepository } from "../../packages/domain/src/conversation-repository.ts";
import { collaborationUIMessages } from "../../src/mastra/applications/qasey/collaboration-view.ts";
import { QaseyUIMessageSchema, E2E_AGENT_ID } from "../../packages/contracts/src/index.ts";
import { evidenceStageState } from "../../apps/admin-ui/src/components/evidence-stage.ts";

it("does not turn failure into six completed evidence stages", () => {
  expect(Array.from({ length: 6 }, (_, i) => evidenceStageState({ status: "failed" }, i))).toEqual(Array(6).fill("unknown"));
  const run = { status: "failed" as const, statusHistory: ["queued", "preparing_workspace", "authoring", "author_running", "failed"] as const };
  expect(Array.from({ length: 6 }, (_, i) => evidenceStageState({ ...run, statusHistory: [...run.statusHistory] }, i))).toEqual(["completed", "completed", "completed", "failed", "waiting", "waiting"]);
});

it("projects named responses with valid metadata and preserves review parts without duplicating user messages", async () => {
  const conversations = new InMemoryQaseyConversationRepository();
  const owner = { applicationId: "qasey", tenantId: "tenant-public" };
  const conversation = await conversations.createConversation(owner, "user-public");
  const scope = { ...owner, subjectId: "user-public", conversationId: conversation.id };
  const mailbox = new CollaborationRepository();
  const runId = "33333333-3333-4333-8333-333333333333";
  await mailbox.joinRun(scope, runId);
  await mailbox.send(scope, { id: "11111111-1111-4111-8111-111111111111", text: "status", recipients: [E2E_AGENT_ID], principal: {}, context: "shared" });
  const [delivery] = await mailbox.claim(scope);
  const started = await conversations.startTurn(owner, scope.subjectId, conversation.id, delivery!.responseId, "status");
  await mailbox.change(scope, state => { state.messages.find(m => m.id === delivery!.responseId)!.turnId = started.turn.id; });
  await conversations.appendEvent(owner, scope.subjectId, conversation.id, started.turn.id, "completed", { text: "正在验证" });
  await mailbox.finish(scope, delivery!, "正在验证");
  const turns = await conversations.listTurns(owner, scope.subjectId, conversation.id);
  const groups = new Map([[started.turn.id, await conversations.events(owner, scope.subjectId, conversation.id, started.turn.id)]]);
  const messages = collaborationUIMessages(await mailbox.read(scope), turns, groups, conversation.id);
  messages.forEach(m => QaseyUIMessageSchema.parse(m));
  expect(messages.filter(m => m.role === "user")).toHaveLength(1);
  expect(messages.find(m => m.id === delivery!.responseId)?.metadata).toMatchObject({ authorAgentId: E2E_AGENT_ID, collaborationStatus: "completed", conversationId: conversation.id });
});
