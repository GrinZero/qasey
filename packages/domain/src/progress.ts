export type QaseyProgressPhase =
  | "retrying"
  | "failed";

export interface QaseyProgressEvent {
  phase: QaseyProgressPhase;
  attempt?: number;
  error?: string;
}

export function formatQaseyProgress(event: QaseyProgressEvent): string {
  switch (event.phase) {
    case "retrying":
      return `*Qasey 进度 · 执行中断，准备重试*\n第 ${event.attempt ?? 1} 次执行在当前阶段未完成：${event.error ?? "未知错误"}。系统只会继续尚未确认完成的步骤。`;
    case "failed":
      return `*Qasey 进度 · 执行未完成*\n${event.error ?? "执行遇到未知错误"}。请使用随后提供的 Request ID 查看完整执行记录。`;
  }
}
