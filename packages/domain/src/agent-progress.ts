import type {
  AgentProgressInput, AgentProgressReport, Intent, IntentRoute,
} from "../../contracts/src/index.ts";
import { AgentProgressInputSchema } from "../../contracts/src/index.ts";

export interface AgentProgressPolicy {
  maxReports: number;
  guidance: string;
}

export interface AgentProgressResult {
  accepted: boolean;
  milestone: string;
  sequence?: number;
  reason?: "duplicate" | "limit_reached" | "reserved_milestone" | "unverified_completion_claim";
}

export const AGENT_PROGRESS_POLICIES: Record<Intent, AgentProgressPolicy> = {
  qa_quick_query: {
    maxReports: 1,
    guidance: "通常不报告过程；只有需要跨多个来源、预计等待较久时，最多报告一次，建议 milestone 为 research。",
  },
  qa_review: {
    maxReports: 2,
    guidance: "只在发现具体证据差异、明确风险或阻塞时报告；不要按“范围确认→证据核对→风险评审”逐阶段打卡。可使用 evidence_gap、risk_found 等稳定 milestone。",
  },
  case_create_full: {
    maxReports: 4,
    guidance: "从需求分歧、关键风险、用例方案变化和即将执行的写入中，只选择 2–4 个对用户真正有信息增量的节点；不要把每个内部步骤都报一遍。可使用 requirement_gap、coverage_decision、writing 等稳定 milestone。",
  },
  case_maintain_fast: {
    maxReports: 3,
    guidance: "只报告已有用例与当前需求的实质差异、维护决策或即将执行的写入；不要逐阶段复述内部流程。可使用 case_gap、update_decision、writing 等稳定 milestone。",
  },
  experience_read: {
    maxReports: 2,
    guidance: "仅在经验检索范围较大时报告检索和当前需求校验，建议 milestone 为 experience_search、current_validation。",
  },
  experience_write: {
    maxReports: 3,
    guidance: "围绕候选经验整理、等待审批和开始写入报告，建议 milestone 为 candidate_review、approval_wait、writing。",
  },
  meta_or_out_of_scope: {
    maxReports: 0,
    guidance: "不要报告过程，直接回答。",
  },
  unknown: {
    maxReports: 1,
    guidance: "只有在恢复上下文或澄清目标需要明显等待时报告一次，建议 milestone 为 context_recovery。",
  },
  e2e_generate: {
    maxReports: 4,
    guidance: "围绕用例读取、仓库分析、代码生成、开始验证和准备 PR 报告，建议 milestone 为 case_review、repo_analysis、generation、validation、publishing。",
  },
  e2e_rerun: {
    maxReports: 2,
    guidance: "围绕运行定位、开始执行和 artifacts 整理报告，建议 milestone 为 run_lookup、execution、artifacts。",
  },
  e2e_repair: {
    maxReports: 4,
    guidance: "围绕失败证据、根因分析、修复、开始验证和 PR 更新报告，建议 milestone 为 failure_evidence、root_cause、repair、validation、publishing。",
  },
  e2e_status: {
    maxReports: 1,
    guidance: "通常直接返回状态；只有查询多个运行或 artifacts 较慢时报告一次，建议 milestone 为 status_lookup。",
  },
};

export function agentProgressPolicy(route: IntentRoute): AgentProgressPolicy {
  return AGENT_PROGRESS_POLICIES[route.intent];
}

export class AgentProgressSession {
  private readonly accepted = new Map<string, AgentProgressReport>();

  constructor(
    private readonly route: IntentRoute,
    private readonly deliver: (report: AgentProgressReport) => void | Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return agentProgressPolicy(this.route).maxReports > 0;
  }

  reports(): AgentProgressReport[] {
    return [...this.accepted.values()];
  }

  async report(candidate: AgentProgressInput): Promise<AgentProgressResult> {
    const input = AgentProgressInputSchema.parse(candidate);
    if (RESERVED_MILESTONES.has(input.milestone) || input.milestone.startsWith("system_")) {
      return { accepted: false, milestone: input.milestone, reason: "reserved_milestone" };
    }
    if (containsUnverifiedCompletionClaim(`${input.title}\n${input.detail}`)) {
      return { accepted: false, milestone: input.milestone, reason: "unverified_completion_claim" };
    }
    const existing = this.accepted.get(input.milestone);
    if (existing) {
      return { accepted: false, milestone: input.milestone, sequence: existing.sequence, reason: "duplicate" };
    }
    const policy = agentProgressPolicy(this.route);
    if (this.accepted.size >= policy.maxReports) {
      return { accepted: false, milestone: input.milestone, reason: "limit_reached" };
    }
    const report: AgentProgressReport = {
      ...input,
      sequence: this.accepted.size + 1,
      occurredAt: this.now().toISOString(),
    };
    await this.deliver(report);
    this.accepted.set(report.milestone, report);
    return { accepted: true, milestone: report.milestone, sequence: report.sequence };
  }
}

const RESERVED_MILESTONES = new Set(["completed", "failed", "retrying", "success", "verified", "write_complete"]);

function containsUnverifiedCompletionClaim(text: string): boolean {
  return [
    /(?:已|已经)?成功写入/u,
    /写入(?:已|已经)?(?:完成|成功)/u,
    /回查(?:已|已经)?(?:完成|通过|成功)/u,
    /(?:已|已经)?回查通过/u,
    /(?:验证|校验)(?:已|已经)?通过/u,
    /(?:发布|合并)(?:已|已经)?成功/u,
    /(?:write|verification|validation|publish|merge)\s+(?:completed|succeeded|passed)/iu,
    /successfully\s+(?:wrote|written|published|merged|verified)/iu,
  ].some(pattern => pattern.test(text));
}
