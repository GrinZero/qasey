import type { QaseyRun, RunStatus } from "../types";
export type EvidenceStageState = "completed" | "running" | "failed" | "waiting" | "unknown";
const completionStatus: RunStatus[] = ["preparing_workspace", "authoring", "author_running", "clean_verifying", "awaiting_qa", "succeeded"];
const stages: Record<RunStatus, number> = { queued: 0, preparing_workspace: 1, authoring: 2, author_running: 3, repairing: 3, clean_verifying: 4, awaiting_qa: 5, succeeded: 6, failed: -1, cancelled: -1 };
export function evidenceStageState(run: Pick<QaseyRun, "status" | "statusHistory">, index: number): EvidenceStageState {
  if (run.status === "succeeded") return "completed";
  const terminal = run.status === "failed" || run.status === "cancelled";
  const current = terminal ? stages[run.statusHistory?.findLast(s => stages[s] >= 0) ?? run.status] : stages[run.status];
  // A failed/cancelled legacy run has no evidence of which stages completed.
  if (terminal && !run.statusHistory?.length) return "unknown";
  if (run.statusHistory?.includes(completionStatus[index]!) && index < current) return "completed";
  if (!run.statusHistory && index < current) return "completed";
  if (index === current) return run.status === "failed" ? "failed" : terminal ? "unknown" : "running";
  return "waiting";
}
