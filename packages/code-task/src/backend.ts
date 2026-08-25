import { AcpAgent } from "@mastra/acp";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import type { CodeTaskTraceContext } from "../../contracts/src/index.ts";
import type { ExecutionProfile } from "./profiles.ts";

export interface CodingAgentRequest {
  taskId: string;
  workspaceRoot: string;
  context: string;
  allowedPaths: string[];
  profile: ExecutionProfile;
  traceContext: CodeTaskTraceContext;
  abortSignal?: AbortSignal;
}

export interface CodingAgentResult {
  summary: string;
  backendRunId: string;
}

export interface CodingAgentBackend {
  run(request: CodingAgentRequest): Promise<CodingAgentResult>;
}

/** The first backend implementation. The runner contract does not expose ACP- or Codex-specific details. */
export class MastraAcpCodexBackend implements CodingAgentBackend {
  constructor(
    private readonly command = "codex-acp",
    private readonly args: string[] = [],
  ) {}

  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    const filesystem = new LocalFilesystem({ basePath: request.workspaceRoot, contained: true });
    await filesystem.init();
    const workspace = new Workspace({ id: `code-task-${request.taskId}`, filesystem });
    const agent = new AcpAgent({
      id: `code-task-${request.taskId}`,
      name: "Qasey Code Task Worker",
      description: "Execute one isolated repository coding task",
      command: this.command,
      args: this.args,
      cwd: request.workspaceRoot,
      workspace,
      persistSession: false,
      ...(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY ? { authMethodId: "api-key" } : {}),
      env: { INITIAL_AGENT_MODE: request.profile.initialAgentMode ?? "read-only", NO_BROWSER: "1" },
      onPermissionRequest: async permission => {
        if (request.profile.permission === "reject") return { outcome: { outcome: "cancelled" as const } };
        const allowOnce = permission.options.find(option => option.kind === "allow_once");
        return allowOnce
          ? { outcome: { outcome: "selected" as const, optionId: allowOnce.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      },
    });
    const output = await agent.generate([
      `Execution profile: ${request.profile.id}`,
      `Writable paths: ${request.allowedPaths.join(", ") || "none"}`,
      "Read repository-local Skills before acting. Do not print or persist credentials.",
      "Complete only the frozen task context below.",
      request.context,
    ].join("\n\n"), {
      runId: request.taskId,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });
    return { summary: output.text || "ACP task completed without a textual summary", backendRunId: output.runId ?? request.taskId };
  }
}
