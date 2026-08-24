import { agentConfig } from "@mastra/core/agent";
import { qaseyResponsesModel } from "../../applications/qasey/models.ts";
import { PlatformRequestContextSchema } from "../../../platform/context/schema.ts";
import { qaseyChannels } from "../../applications/qasey/channels.ts";
import { config } from "../../runtime.ts";
import {
  createQaseyStreamBatcher,
  QASEY_AGENT_SAFETY_MAX_STEPS,
  resolveQaseyMainInputProcessors,
} from "./processors.ts";

export default agentConfig({
  id: "qasey-main",
  name: "Qasey",
  durable: { maxSteps: QASEY_AGENT_SAFETY_MAX_STEPS },
  description: "MoeGo QA 需求分析、测试用例设计与 E2E 编写智能体",
  model: [{
    model: qaseyResponsesModel,
    maxRetries: 2,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        serviceTier: "priority",
        // Conversation history is persisted by Mastra in Postgres. Keeping
        // Responses API items server-side makes the SDK replay old messages as
        // `item_reference`s, which OpenAI-compatible gateways may not retain.
        store: false,
      },
    },
  }],
  requestContextSchema: PlatformRequestContextSchema,
  defaultOptions: () => ({
    maxSteps: QASEY_AGENT_SAFETY_MAX_STEPS,
    abortSignal: AbortSignal.timeout(config.QASEY_AGENT_TIMEOUT_MS),
  }),
  ...(qaseyChannels ? { channels: qaseyChannels } : {}),
  inputProcessors: resolveQaseyMainInputProcessors,
  outputProcessors: [createQaseyStreamBatcher()],
  // Disable Mastra's static file-based default workspace. Once registered,
  // Qasey inherits the global request-scoped workspace from the Mastra runtime.
  workspace: undefined,
});
