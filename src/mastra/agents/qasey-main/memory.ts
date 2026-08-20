import { Memory } from "@mastra/memory";
import { logError, logInfo } from "../../../../packages/adapters/src/index.ts";
import { config, mastraStorage } from "../../runtime.ts";
import { createResponsesModel } from "../../applications/qasey/models.ts";

const statelessResponsesOptions = {
  openai: {
    reasoningEffort: "low",
    // Mastra owns durable history. Our OpenAI-compatible Responses gateway
    // deliberately does not retain response items for later item_reference use.
    store: false,
  },
};

const workingMemoryTemplate = `# 当前 QA 任务
- 目标：
- 范围与非目标：
- 需求来源与链接：
- 已确认的决策与约束：
- 测试覆盖与重要边界：
- E2E 平台、框架与仓库：
- 当前进度：
- 未解决的阻塞或问题：
- QA 验收状态：`;

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
        instructions: "当精确需求、测试步骤、工具输出或先前决策很重要时，回忆原始消息。",
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

export default qaseyMemory;
