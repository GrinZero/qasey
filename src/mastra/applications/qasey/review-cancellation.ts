import type { CaseHubRepository } from "../../../../packages/domain/src/case-hub-repository.ts";
import type { RunRepository } from "../../../../packages/domain/src/run-repository.ts";
import type { OwnerScope } from "../../../../packages/contracts/src/index.ts";

export async function cancelReviewChangeSet(
  hub: CaseHubRepository, runs: RunRepository, owner: OwnerScope, id: string,
  stopRun: (runId: string) => Promise<unknown>,
) {
  let changeSet = await hub.getChangeSet(owner, id);
  if (!changeSet) return undefined;
  if (["merged", "ready_to_merge"].includes(changeSet.status)) throw new Error("已经完成验证的变更不能取消。");
  if (changeSet.runId) {
    const run = await runs.get(owner, changeSet.runId);
    if (run && run.changeSetId !== id) throw new Error("运行与验证记录不匹配，未执行取消。");
    if (run && !["succeeded", "failed", "cancelled"].includes(run.status)) await stopRun(run.id);
  }
  // Stopping a live workflow can itself update the Change Set revision.
  changeSet = await hub.getChangeSet(owner, id);
  if (!changeSet || ["cancelled", "abandoned", "failed"].includes(changeSet.status)) return changeSet;
  return hub.updateChangeSet(owner, id, changeSet.revision, { status: "cancelled" });
}
