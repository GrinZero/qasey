import type { QaseyE2ETask } from "@qasey/contracts";

export function e2eTaskUrl(task: Pick<QaseyE2ETask, "conversationId" | "turnId">): string {
  return `/admin/apps/qasey?conversation=${encodeURIComponent(task.conversationId)}&turn=${encodeURIComponent(task.turnId)}`;
}

export function caseReviewUrl(planId: string, versionId?: string): string {
  return `/admin/apps/qasey/reviews?plan=${encodeURIComponent(planId)}${versionId ? `&version=${encodeURIComponent(versionId)}` : ""}#review-plan-${encodeURIComponent(planId)}`;
}
