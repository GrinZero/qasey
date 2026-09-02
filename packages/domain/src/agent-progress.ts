import type {
  AgentProgressInput, AgentProgressReport,
} from "../../contracts/src/index.ts";
import { AgentProgressInputSchema } from "../../contracts/src/index.ts";

export interface AgentProgressResult {
  accepted: boolean;
  milestone: string;
  sequence?: number;
  reason?: "duplicate" | "limit_reached" | "reserved_milestone" | "unverified_completion_claim";
}

export const MAX_AGENT_PROGRESS_REPORTS = 4;

export class AgentProgressSession {
  private readonly accepted = new Map<string, AgentProgressReport>();

  constructor(
    private readonly deliver: (report: AgentProgressReport) => void | Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return true;
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
    if (this.accepted.size >= MAX_AGENT_PROGRESS_REPORTS) {
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
