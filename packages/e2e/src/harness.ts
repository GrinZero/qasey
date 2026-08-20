import { AcpAgent } from "@mastra/acp";
import type { E2EFramework } from "./runner.ts";
import type { WorkspaceRef } from "./workspace.ts";

export interface AuthoringRequest {
  runId: string;
  framework: E2EFramework;
  sourceCaseIds: string[];
  instruction: string;
}

export interface AuthoringResult { summary: string; }

export interface CodingHarness {
  author(request: AuthoringRequest, workspace: WorkspaceRef): Promise<AuthoringResult>;
}

export class AcpCodingHarness implements CodingHarness {
  constructor(private readonly command: string, private readonly args: string[] = []) {}

  async author(request: AuthoringRequest, workspace: WorkspaceRef): Promise<AuthoringResult> {
    const agent = new AcpAgent({
      id: `qasey-code-${request.runId}`,
      name: "Qasey E2E Author",
      description: "在隔离的仓库工作区中编写 Playwright 或 Maestro E2E 代码",
      command: this.command,
      args: this.args,
      cwd: workspace.root,
      persistSession: false,
      onPermissionRequest: async permission => {
        const allow = permission.options.find(option => /allow|approve|yes/i.test(option.name));
        return allow
          ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      },
    });
    const output = await agent.generate([
      `框架：${request.framework}`,
      `QA 用例 ID：${request.sourceCaseIds.join(", ")}`,
      `允许修改的路径：${workspace.repository.allowedPaths.join(", ")}`,
      "编辑前先读取仓库中的 Skills。不要改变应用行为或 QA 预期。",
      request.instruction,
    ].join("\n"));
    return { summary: output.text };
  }
}

export class NoopCodingHarness implements CodingHarness {
  async author(): Promise<AuthoringResult> {
    return { summary: "代码编写已禁用。请设置 QASEY_ENABLE_EXECUTION=true 并配置 ACP 命令。" };
  }
}
