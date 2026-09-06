import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  isE2EAuthorStudioRequest,
  requireE2EAuthorRuntime,
  resolveE2EAuthorRuntime,
} from "../runtime-bindings.ts";

export const E2ECandidateValidationResultSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  changedPaths: z.array(z.string()),
}).strict();

export default createTool({
  id: "validate_e2e_candidate",
  description: "Run Qasey's fixed, credential-free E2E candidate validation in a managed CodeTask. Direct Studio sessions should run repository checks with their Workspace command tools.",
  inputSchema: z.object({}).strict(),
  outputSchema: E2ECandidateValidationResultSchema,
  execute: async (_input, { requestContext }) => {
    const runtime = resolveE2EAuthorRuntime(requestContext);
    if (!runtime && isE2EAuthorStudioRequest(requestContext)) {
      return {
        passed: true,
        summary: "Direct Studio session: no managed CodeTask validation gate applies; run the repository checks with the available Workspace tools.",
        changedPaths: [],
      };
    }
    const boundRuntime = runtime ?? requireE2EAuthorRuntime(requestContext);
    boundRuntime.validation.calls += 1;
    const result = await boundRuntime.validateCandidate();
    boundRuntime.validation.lastResult = result;
    return result;
  },
});
