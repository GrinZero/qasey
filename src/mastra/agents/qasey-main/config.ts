import { agentConfig } from "@mastra/core/agent";
import { TokenLimiter } from "@mastra/core/processors";
import { config } from "../../runtime.ts";
import { qaseyResponsesModel } from "../../applications/qasey/models.ts";
import { PlatformRequestContextSchema } from "../../../platform/context/schema.ts";
import { qaseyChannels } from "../../applications/qasey/channels.ts";
import { resolveQaseyMainTools } from "./tools.ts";
import { QASEY_MAIN_SKILLS_PATH } from "../../skill-paths.ts";

export default agentConfig({
  id: "qasey-main",
  name: "Qasey",
  durable: true,
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
  ...(qaseyChannels ? { channels: qaseyChannels } : {}),
  inputProcessors: [new TokenLimiter({ limit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT })],
  skills: [QASEY_MAIN_SKILLS_PATH],
  tools: resolveQaseyMainTools,
});
