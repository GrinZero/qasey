import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { describe, expect, it } from "vitest";
import { createSharedMastraConfig } from "../../src/runtime/create-runtime.ts";
import { flattenApplicationRegistry } from "../../src/runtime/registry-validator.ts";
import type { AgentApplicationBundle } from "../../src/runtime/application.ts";
import { alphaApplication, betaApplication, internalAlphaWorkflow } from "../fixtures/applications.ts";

describe("shared application registry", () => {
  it("registers and executes two independent applications without publishing internal primitives", async () => {
    const runtime = createSharedMastraConfig({ applications: [alphaApplication, betaApplication] });
    const mastra = new Mastra(runtime.config);
    const alpha = await (await mastra.getWorkflow("alpha-echo").createRun()).start({ inputData: { value: "x" } });
    const beta = await (await mastra.getWorkflow("beta-echo").createRun()).start({ inputData: { value: "x" } });

    expect(alpha).toMatchObject({ status: "success", result: { value: "A:x" } });
    expect(beta).toMatchObject({ status: "success", result: { value: "B:x" } });
    expect(runtime.catalog.map(entry => entry.resourceId)).toEqual(["alpha-echo", "beta-echo"]);
    expect(() => mastra.getWorkflow(internalAlphaWorkflow.id)).toThrow();
  });

  it("fails startup on duplicate application ids", () => {
    expect(() => flattenApplicationRegistry([alphaApplication, alphaApplication])).toThrow(/Duplicate application id/u);
  });

  it("fails startup when registered permission metadata is missing", () => {
    const invalid: AgentApplicationBundle = { ...alphaApplication, access: { agents: {}, workflows: {} } };
    expect(() => flattenApplicationRegistry([invalid])).toThrow(/missing permission metadata/u);
  });

  it("fails startup when a key differs from its canonical id or crosses application ownership", () => {
    const fakeAgent = { id: "alpha-other" } as unknown as Agent;
    const invalid: AgentApplicationBundle = {
      id: "alpha",
      agents: { "alpha-main": fakeAgent },
      workflows: {},
      access: { agents: { "alpha-main": { permission: "alpha.execute", audiences: ["api"] } }, workflows: {} },
    };
    expect(() => flattenApplicationRegistry([invalid])).toThrow(/must equal canonical id/u);
    const wrongOwner = { ...invalid, agents: { "beta-main": { id: "beta-main" } as unknown as Agent }, access: {
      ...invalid.access, agents: { "beta-main": { permission: "alpha.execute", audiences: ["api"] as const } },
    } };
    expect(() => flattenApplicationRegistry([wrongOwner])).toThrow(/must start with "alpha-"/u);
  });
});
