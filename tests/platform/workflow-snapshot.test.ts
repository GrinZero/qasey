import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertJsonSafeSnapshot } from "../../src/platform/workflows/durability.ts";

const Input = z.object({ runId: z.string() });
const Resume = z.object({ verdict: z.enum(["approve", "reject"]) });
const Output = z.object({ runId: z.string(), verdict: Resume.shape.verdict });
const approvalStep = createStep({
  id: "fixture-await-approval",
  inputSchema: Input,
  outputSchema: Output,
  resumeSchema: Resume,
  suspendSchema: Input,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend(inputData);
    const snapshot = { runId: inputData.runId, verdict: resumeData.verdict };
    assertJsonSafeSnapshot(snapshot);
    return snapshot;
  },
});
const approvalWorkflow = createWorkflow({ id: "fixture-approval", inputSchema: Input, outputSchema: Output })
  .then(approvalStep)
  .commit();

describe("native workflow snapshot", () => {
  it("suspends and resumes the same stable run without a custom queue/checkpoint", async () => {
    const mastra = new Mastra({ workflows: { "fixture-approval": approvalWorkflow } });
    const run = await mastra.getWorkflow("fixture-approval").createRun({ runId: "stable-run" });
    const suspended = await run.start({ inputData: { runId: "domain-run" } });
    expect(suspended.status).toBe("suspended");
    const resumed = await run.resume({ step: approvalStep, resumeData: { verdict: "approve" as const } });
    expect(resumed).toMatchObject({ status: "success", result: { runId: "domain-run", verdict: "approve" } });
  });
});
