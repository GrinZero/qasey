import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { AgentApplicationBundle } from "../../src/runtime/application.ts";

function application(id: "alpha" | "beta", suffix: string): AgentApplicationBundle {
  const schema = z.object({ value: z.string() });
  const workflowId = `${id}-echo`;
  const step = createStep({
    id: `${id}-reply`,
    inputSchema: schema,
    outputSchema: schema,
    execute: async ({ inputData }) => ({ value: `${suffix}:${inputData.value}` }),
  });
  const workflow = createWorkflow({ id: workflowId, inputSchema: schema, outputSchema: schema })
    .then(step)
    .commit();
  return {
    id,
    agents: {},
    workflows: { [workflowId]: workflow },
    access: {
      agents: {},
      workflows: { [workflowId]: { permission: `${id}.workflow.execute`, audiences: ["api"] } },
    },
  };
}

export const alphaApplication = application("alpha", "A");
export const betaApplication = application("beta", "B");

export const internalAlphaWorkflow = createWorkflow({
  id: "alpha-internal",
  inputSchema: z.object({}),
  outputSchema: z.object({ internal: z.literal(true) }),
}).then(createStep({
  id: "alpha-internal-step",
  inputSchema: z.object({}),
  outputSchema: z.object({ internal: z.literal(true) }),
  execute: async () => ({ internal: true as const }),
})).commit();
