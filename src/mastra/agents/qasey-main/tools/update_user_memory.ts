import { createTool } from "@mastra/core/tools";
import { UserMemoryChangeSchema, UserMemorySchema } from "../../../applications/qasey/user-memory.ts";
import { requireUserMemoryService } from "../user-memory-runtime.ts";

export default createTool({
  id: "update_user_memory",
  description: "Set an explicitly stated stable user preference, forget a preference by key, or clear all user preferences when requested. Read the latest revision first. Does not delete conversation history or modify current task memory.",
  inputSchema: UserMemoryChangeSchema,
  outputSchema: UserMemorySchema,
  execute: async (input, { requestContext }) => requireUserMemoryService().change(input, requestContext),
});
