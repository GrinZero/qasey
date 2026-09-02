export interface ConversationScopeInput {
  applicationId: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  externalThreadId: string;
  kind: "private" | "shared";
}

export interface ConversationScope {
  resourceId: string;
  threadId: string;
}

export function conversationScope(input: ConversationScopeInput): ConversationScope {
  const values = Object.values(input);
  if (values.some(value => !value.trim())) throw new Error("Conversation scope values must be non-empty");
  const owner = input.kind === "private" ? input.userId : input.conversationId;
  return {
    resourceId: joinScope(input.applicationId, input.tenantId, owner),
    threadId: joinScope(input.applicationId, input.tenantId, input.kind, input.externalThreadId),
  };
}

function joinScope(...parts: string[]): string {
  return parts.map(part => encodeURIComponent(part.trim())).join(":");
}

