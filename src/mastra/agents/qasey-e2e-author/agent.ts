import { assembleAgentFromFsEntry } from "@mastra/core/agent";
import config from "./config.ts";
import instructions from "./instructions.ts";
import validateE2ECandidate from "./tools/validate-e2e-candidate.ts";

/**
 * The execution-plane instance assembled from the same file-based definition
 * that Mastra registers for Studio and runtime metadata.
 */
export const qaseyE2EAuthorAgent = assembleAgentFromFsEntry({
  name: "qasey-e2e-author",
  config,
  instructions,
  tools: [{ key: "validate-e2e-candidate", tool: validateE2ECandidate }],
});
