import { agentConfig } from "@mastra/core/agent";
import { qaseyResponsesModel } from "../../applications/qasey/models.ts";
import { RequirePassingE2ECandidateValidation } from "./processors.ts";
import {
  isE2EAuthorStudioRequest,
  requireE2EAuthorRuntime,
  resolveE2EAuthorRuntime,
} from "./runtime-bindings.ts";

export const QASEY_E2E_AUTHOR_ID = "qasey-e2e-author";
export const QASEY_E2E_AUTHOR_MAX_STEPS = 80;

export const qaseyE2EAuthorConfig = agentConfig({
  id: QASEY_E2E_AUTHOR_ID,
  name: "Qasey E2E Author",
  description: "编写、校验和修复 Playwright E2E；托管流程中使用冻结 Case Hub 版本和隔离仓库。",
  metadata: { applicationId: "qasey", role: "e2e-author" },
  model: ({ requestContext }) => resolveE2EAuthorRuntime(requestContext)?.model
    ?? ((isE2EAuthorStudioRequest(requestContext) || requestContext.get("qasey-conversation-agent") === "qasey-e2e-author")
      ? qaseyResponsesModel
      : requireE2EAuthorRuntime(requestContext).model),
  workspace: ({ requestContext, mastra }) => resolveE2EAuthorRuntime(requestContext)?.workspace
    ?? ((isE2EAuthorStudioRequest(requestContext) || requestContext.get("qasey-conversation-agent") === "qasey-e2e-author")
      ? (isE2EAuthorStudioRequest(requestContext) ? mastra?.getWorkspace() : undefined)
      : requireE2EAuthorRuntime(requestContext).workspace),
  outputProcessors: [new RequirePassingE2ECandidateValidation()],
  maxProcessorRetries: 2,
  defaultOptions: { maxSteps: QASEY_E2E_AUTHOR_MAX_STEPS },
});

export default qaseyE2EAuthorConfig;
