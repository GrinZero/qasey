export type ScopeAccessLevel = "只读" | "执行" | "写入";

export interface ScopePresentation {
  label: string;
  description: string;
  accessLevel: ScopeAccessLevel;
}

const SCOPE_PRESENTATIONS: Readonly<Record<string, ScopePresentation>> = {
  "platform.background-tasks.read": {
    label: "后台任务",
    description: "查看 Mastra 后台任务的运行状态和结果。",
    accessLevel: "只读",
  },
  "platform.catalog.read": {
    label: "资源目录",
    description: "查看可用的 Agent、Workflow 和 Scorer 列表。",
    accessLevel: "只读",
  },
  "platform.internal-workflow.read": {
    label: "内部工作流",
    description: "查看 Mastra 框架内部 Workflow 的定义和运行信息。",
    accessLevel: "只读",
  },
  "platform.runtime.inspect": {
    label: "运行时诊断",
    description: "查看 Trace、存储、Channel 配置等运行时调试信息。",
    accessLevel: "只读",
  },
  "platform.schedules.read": {
    label: "定时任务",
    description: "查看定时任务及状态，不能创建、执行、暂停或删除。",
    accessLevel: "只读",
  },
  "qasey.agent.execute": {
    label: "运行 Qasey Agent",
    description: "通过公开任务入口向 Qasey Agent 提交任务。",
    accessLevel: "执行",
  },
  "qasey.runs.read": {
    label: "运行记录",
    description: "查看自动化运行、进度事件和生成的产物。",
    accessLevel: "只读",
  },
  "qasey.runs.write": {
    label: "管理运行",
    description: "创建、重新执行或取消自动化运行。",
    accessLevel: "写入",
  },
  "qasey.runs.approve": {
    label: "QA 审核",
    description: "为自动化运行提交 QA 审核结论。",
    accessLevel: "写入",
  },
  "qasey.sandbox.use": {
    label: "操作沙箱",
    description: "查看并操作运行中的浏览器或桌面沙箱。",
    accessLevel: "执行",
  },
};

export function presentScope(scope: string): ScopePresentation {
  return SCOPE_PRESENTATIONS[scope] ?? {
    label: "其他 API 权限",
    description: `访问 ${scope} 对应的 API；签发前请向维护者确认具体范围。`,
    accessLevel: scope.endsWith(".read") || scope.endsWith(".inspect")
      ? "只读"
      : scope.endsWith(".execute") || scope.endsWith(".use")
        ? "执行"
        : "写入",
  };
}
