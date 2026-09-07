import { z } from "zod";

export const MAIN_AGENT_ID = "qasey-main";
export const E2E_AGENT_ID = "qasey-e2e-author";
export const ConversationParticipantSchema = z.object({
  agentId: z.string().min(1), name: z.string().min(1), description: z.string(),
  introducedBy: z.string(), joinedAt: z.iso.datetime(),
});
export type ConversationParticipant = z.infer<typeof ConversationParticipantSchema>;
export const ConversationAddressSchema = z.object({
  recipientAgentIds: z.array(z.string().min(1)).min(1).max(8).optional(),
  targetRunId: z.string().min(1).optional(),
});
export const ExecutionToolCallSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(160), title: z.string().min(1).max(100),
  status: z.enum(["running", "completed", "failed"]),
});
export type ExecutionToolCall = z.infer<typeof ExecutionToolCallSchema>;
export const CollaborationMessageSchema = z.object({
  id: z.string(), authorAgentId: z.string().optional(), recipientAgentIds: z.array(z.string()),
  role: z.enum(["user", "assistant"]), kind: z.enum(["message", "handoff", "execution"]),
  text: z.string(), status: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.iso.datetime(), replyTo: z.string().optional(), runId: z.string().optional(),
  turnId: z.string().optional(), rootMessageId: z.string(),
  toolCalls: z.array(ExecutionToolCallSchema).optional(),
});
export type CollaborationMessage = z.infer<typeof CollaborationMessageSchema>;
export const CollaborationSnapshotSchema = z.object({
  revision: z.number().int(), participants: z.array(ConversationParticipantSchema),
  messages: z.array(CollaborationMessageSchema),
});
export type CollaborationSnapshot = z.infer<typeof CollaborationSnapshotSchema>;
