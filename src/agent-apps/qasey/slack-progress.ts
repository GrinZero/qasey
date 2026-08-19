export type QaseyPhase = "routing" | "agent" | "workflow" | "finalizing";

/** Keep Slack's visible status aligned with the phase the backend is actually running. */
export function slackPhaseMessage(phase: QaseyPhase): string | undefined {
  if (phase === "routing") return "正在识别任务类型…";
  if (phase === "agent") return "任务类型已识别，正在分析请求并准备所需能力…";
  if (phase === "workflow") return "分析计划已冻结，正在执行并回查外部变更…";
  return undefined;
}
