import { Agent } from "@mastra/core/agent";
import { TokenLimiter } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import { buildSystemPrompt } from "../../packages/domain/src/index.ts";
import { logError, logInfo } from "../../packages/adapters/src/index.ts";
import { config, getRuntimeContext, mastraStorage, toolsForRequest } from "./runtime.ts";
import { createResponsesModel, qaseyResponsesModel } from "./models.ts";

const statelessResponsesOptions = {
  openai: {
    reasoningEffort: "low",
    // Mastra owns durable history. Our OpenAI-compatible Responses gateway
    // deliberately does not retain response items for later item_reference use.
    store: false,
  },
};

const workingMemoryTemplate = `# Active QA task
- Goal:
- Scope and non-goals:
- Source requirements and links:
- Confirmed decisions and constraints:
- Test coverage and important edge cases:
- E2E platform, framework, and repository:
- Current progress:
- Open blockers or questions:
- QA acceptance status:`;

const memoryModel = createResponsesModel(config.QASEY_MEMORY_MODEL);

export const qaseyMemory = mastraStorage ? new Memory({
  storage: mastraStorage,
  options: {
    workingMemory: {
      enabled: true,
      scope: "thread",
      template: workingMemoryTemplate,
    },
    observationalMemory: {
      model: memoryModel,
      scope: "thread",
      retrieval: {
        scope: "thread",
        instructions: "Recall raw messages when exact requirements, test steps, tool output, or prior decisions matter.",
      },
      observation: {
        messageTokens: config.QASEY_MEMORY_MESSAGE_TOKENS,
        manageWorkingMemory: true,
        observeAttachments: "auto",
        providerOptions: statelessResponsesOptions,
      },
      reflection: {
        observationTokens: config.QASEY_MEMORY_OBSERVATION_TOKENS,
        providerOptions: statelessResponsesOptions,
      },
      hooks: {
        onObservationStart: info => logInfo("memory.observation.started", {
          threadId: info?.threadId,
          resourceId: info?.resourceId,
          trigger: info?.trigger,
        }),
        onObservationEnd: result => {
          const fields = {
            threadId: result.threadId,
            resourceId: result.resourceId,
            trigger: result.trigger,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            totalTokens: result.usage?.totalTokens,
          };
          if (result.error) logError("memory.observation.failed", result.error, fields);
          else logInfo("memory.observation.completed", fields);
        },
        onReflectionStart: info => logInfo("memory.reflection.started", {
          threadId: info?.threadId,
          resourceId: info?.resourceId,
          trigger: info?.trigger,
        }),
        onReflectionEnd: result => {
          const fields = {
            threadId: result.threadId,
            resourceId: result.resourceId,
            trigger: result.trigger,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            totalTokens: result.usage?.totalTokens,
          };
          if (result.error) logError("memory.reflection.failed", result.error, fields);
          else logInfo("memory.reflection.completed", fields);
        },
      },
    },
  },
}) : undefined;

export const qaseyAgent = new Agent({
  id: "qasey",
  name: "Qasey",
  description: "MoeGo QA requirement analysis, test case design, and E2E authoring agent",
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
  instructions: async ({ requestContext }) => {
    const runtime = getRuntimeContext(requestContext, { allowStudioPreview: config.NODE_ENV === "development" });
    return buildSystemPrompt(runtime["qasey-context"], runtime["intent-route"]).text;
  },
  ...(qaseyMemory ? { memory: qaseyMemory } : {}),
  inputProcessors: [new TokenLimiter({ limit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT })],
  tools: async ({ requestContext }) => toolsForRequest(requestContext),
});
