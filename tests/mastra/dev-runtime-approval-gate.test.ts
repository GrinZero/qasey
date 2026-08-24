import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import {
  applyDevRuntimeApprovalGate,
  DEV_RUNTIME_APPROVAL_GATE_KEY,
  DevRuntimeApprovalDeclinedError,
} from "../../src/mastra/applications/qasey/dev-runtime-approval-gate.ts";

describe("Dev Runtime approval gate", () => {
  it("leaves ordinary cloud tools unchanged", () => {
    const tools = { write: { requireApproval: true, execute: vi.fn() } } as any;
    expect(applyDevRuntimeApprovalGate(tools)).toBe(tools);
  });

  it("executes an approval tool only after the local gate approves it", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const request = vi.fn(async () => "approved" as const);
    const context = new RequestContext<any>();
    context.set(DEV_RUNTIME_APPROVAL_GATE_KEY, { request });
    const tools = applyDevRuntimeApprovalGate({
      write: { requireApproval: true, execute },
    } as any, context);

    await expect((tools.write as any).execute({ password: "secret", value: "safe" }, {})).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "write",
      argsSummary: expect.not.stringContaining("secret"),
      argsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
  });

  it("does not execute a declined tool", async () => {
    const execute = vi.fn();
    const context = new RequestContext<any>();
    context.set(DEV_RUNTIME_APPROVAL_GATE_KEY, { request: async () => "declined" as const });
    const tools = applyDevRuntimeApprovalGate({ write: { requireApproval: true, execute } } as any, context);

    await expect((tools.write as any).execute({}, {})).rejects.toBeInstanceOf(DevRuntimeApprovalDeclinedError);
    expect(execute).not.toHaveBeenCalled();
  });
});
