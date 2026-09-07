import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { UserMemorySchema } from "../../../applications/qasey/user-memory.ts";
import { requireUserMemoryService } from "../user-memory-runtime.ts";

export default createTool({
  id: "read_user_memory",
  description: "Read the authenticated user's long-term preferences and current revision. Available in private Qasey conversations, including Studio.",
  inputSchema: z.object({}).strict(),
  outputSchema: UserMemorySchema,
  execute: async (_input, { requestContext }) => requireUserMemoryService().read(requestContext),
});
