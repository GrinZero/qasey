import { describe, expect, it, vi } from "vitest";
import { cancelReviewChangeSet } from "../../src/mastra/applications/qasey/review-cancellation.ts";
import type { CaseHubRepository } from "../../packages/domain/src/case-hub-repository.ts";
import type { RunRepository } from "../../packages/domain/src/run-repository.ts";

const owner = { applicationId: "qasey", tenantId: "public-tenant" };
function setup(status = "running", runId: string | undefined = "run-1") {
  const change = { id: "change-1", status: "verifying", revision: 1, runId };
  const hub = {
    getChangeSet: vi.fn(async () => ({ ...change })),
    updateChangeSet: vi.fn(async (_owner, _id, revision, patch) => Object.assign(change, patch, { revision: revision + 1 })),
  };
  const runs = { get: vi.fn(async () => ({ id: "run-1", changeSetId: "change-1", status })) };
  const stop = vi.fn(async () => { change.status = "cancelled"; change.revision++; });
  const cancel = () => cancelReviewChangeSet(hub as unknown as CaseHubRepository, runs as unknown as RunRepository, owner, change.id, stop);
  return { hub, runs, stop, cancel, change };
}
describe("review cancellation", () => {
  it("stops a live run and reloads its changed revision; repeating is safe", async () => {
    const f = setup();
    expect(await f.cancel()).toMatchObject({ status: "cancelled", revision: 2 });
    expect(f.stop).toHaveBeenCalledWith("run-1");
    expect(f.hub.updateChangeSet).not.toHaveBeenCalled();
  });
  it.each(["failed", "succeeded", "cancelled"])("closes stale verifying records with a %s run", async status => {
    const f = setup(status);
    expect(await f.cancel()).toMatchObject({ status: "cancelled" });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.hub.updateChangeSet).toHaveBeenCalledWith(owner, "change-1", 1, { status: "cancelled" });
    await f.cancel();
    expect(f.hub.updateChangeSet).toHaveBeenCalledTimes(1);
  });
  it("closes a stranded verification that never acquired a run", async () => {
    const f = setup("running", "");
    expect(await f.cancel()).toMatchObject({ status: "cancelled" });
    expect(f.runs.get).not.toHaveBeenCalled();
  });
  it("keeps the card actionable when stopping fails", async () => {
    const f = setup(); f.stop.mockRejectedValue(new Error("Runner unavailable"));
    await expect(f.cancel()).rejects.toThrow("Runner unavailable");
    expect(f.hub.updateChangeSet).not.toHaveBeenCalled();
  });
  it("does not cancel a mismatched run or a merged change", async () => {
    const f = setup(); f.runs.get.mockResolvedValue({ id: "run-1", changeSetId: "another-change", status: "running" });
    await expect(f.cancel()).rejects.toThrow(/不匹配/);
    f.change.status = "merged";
    await expect(f.cancel()).rejects.toThrow(/不能取消/);
    expect(f.stop).not.toHaveBeenCalled();
  });
});
