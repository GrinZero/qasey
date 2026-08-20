import { agentConfig } from "@mastra/core/agent";
import { intentResponsesModel } from "../../applications/qasey/models.ts";
import { PlatformRequestContextSchema } from "../../../platform/context/schema.ts";

/** Declarative file-based Agent configuration. Prompt and execution logic live in sibling files. */
export default agentConfig({
  id: "qasey-intent-router",
  name: "Qasey Intent Router",
  description: "将 Qasey 请求分类为安全、类型明确的业务意图。",
  model: intentResponsesModel,
  requestContextSchema: PlatformRequestContextSchema,
});
