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
      description: "Writes Playwright or Maestro E2E code inside an isolated repository workspace",
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
      `Framework: ${request.framework}`,
      `QA case IDs: ${request.sourceCaseIds.join(", ")}`,
      `Allowed paths: ${workspace.repository.allowedPaths.join(", ")}`,
      "Read repository Skills before editing. Do not change application behavior or QA expectations.",
      request.instruction,
    ].join("\n"));
    return { summary: output.text };
  }
}

export class NoopCodingHarness implements CodingHarness {
  async author(): Promise<AuthoringResult> {
    return { summary: "Authoring disabled. Set QASEY_ENABLE_EXECUTION=true and configure an ACP command." };
  }
}
