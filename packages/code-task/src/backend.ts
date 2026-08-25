import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { LocalFilesystem, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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

/**
 * Native Mastra coding backend used inside one isolated CodeTask worktree.
 *
 * Repository lifecycle, checks, and patch collection stay outside the model.
 * The Agent receives only contained filesystem tools; write tools are guarded
 * again at the Workspace boundary by the frozen allowedPaths contract.
 */
export class NativeMastraCodingBackend implements CodingAgentBackend {
  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    const writablePaths = request.profile.writable ? normalizeAllowedPaths(request.allowedPaths) : [];
    const filesystem = new LocalFilesystem({
      basePath: request.workspaceRoot,
      contained: true,
      readOnly: !request.profile.writable,
    });
    const workspace = new Workspace({
      id: `code-task-${request.taskId}`,
      filesystem,
      skills: await existingSkillPaths(request.workspaceRoot, request.context),
      tools: {
        requireApproval: false,
        [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
          enabled: request.profile.writable,
          requireReadBeforeWrite: true,
        },
        [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
          enabled: request.profile.writable,
          requireReadBeforeWrite: true,
        },
        [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { enabled: request.profile.writable },
        [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { enabled: request.profile.writable },
        [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
        hooks: {
          beforeToolCall: ({ workspaceToolName, input }) => {
            if (!WRITE_TOOLS.has(workspaceToolName)) return;
            const path = toolPath(input);
            if (path && isAllowedPath(path, writablePaths)) return;
            return {
              proceed: false as const,
              output: `Write rejected: ${path || "missing path"} is outside the frozen allowedPaths boundary.`,
            };
          },
        },
      },
    });

    const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    const openai = createOpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL.replace(/\/$/u, "") }
        : {}),
    });
    const modelId = process.env.QASEY_CODE_AGENT_MODEL?.trim() || "gpt-5.6-sol";
    const agent = new Agent({
      id: `qasey-e2e-code-author-${request.taskId}`,
      name: "Qasey E2E Code Author",
      description: "Writes or reviews E2E implementation in one isolated repository worktree.",
      model: openai.responses(modelId),
      workspace,
      instructions: [
        "You are Qasey's repository coding specialist, implemented as a native Mastra Agent.",
        "Activate and follow relevant repository-local Skills before changing files.",
        "Inspect existing tests, page objects, helpers, and conventions before implementing.",
        "Use only Workspace filesystem tools. Repository checks run deterministically after you finish.",
        "Never read, print, or persist credentials. Never weaken assertions to hide a product or environment failure.",
        request.profile.writable
          ? `You may write only under: ${writablePaths.join(", ") || "no paths"}.`
          : "This execution profile is read-only; do not modify files.",
      ],
    });

    try {
      await workspace.init();
      const output = await agent.generate([
        `Execution profile: ${request.profile.id}`,
        `Frozen writable paths: ${writablePaths.join(", ") || "none"}`,
        "Complete only the immutable task context below.",
        request.context,
      ].join("\n\n"), {
        runId: request.taskId,
        maxSteps: codeAgentMaxSteps(),
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            serviceTier: "priority",
            store: false,
          },
        },
      });
      return {
        summary: output.text || "Native Mastra coding task completed without a textual summary",
        backendRunId: output.runId ?? request.taskId,
      };
    } finally {
      await workspace.destroy().catch(() => undefined);
    }
  }
}

const WRITE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

function normalizeAllowedPaths(paths: string[]): string[] {
  return [...new Set(paths.map(path => path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "")))]
    .filter(Boolean)
    .sort();
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function isAllowedPath(pathInput: string, allowedPaths: string[]): boolean {
  const path = pathInput.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!path || path.startsWith("/") || path.split("/").some(segment => segment === ".." || segment === "." || !segment)) return false;
  return allowedPaths.some(allowed => path === allowed || path.startsWith(`${allowed}/`));
}

async function existingSkillPaths(workspaceRoot: string, context: string): Promise<string[]> {
  const configured = taskSkillPaths(context);
  const paths: string[] = [];
  for (const candidate of configured) {
    const absolute = resolve(workspaceRoot, candidate);
    const rel = relative(workspaceRoot, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) continue;
    if (await access(absolute).then(() => true).catch(() => false)) paths.push(candidate);
  }
  return paths;
}

function taskSkillPaths(context: string): string[] {
  try {
    const parsed = JSON.parse(context) as {
      brief?: { repository?: { skillPaths?: unknown } };
    };
    const skillPaths = parsed.brief?.repository?.skillPaths;
    return Array.isArray(skillPaths) && skillPaths.every(path => typeof path === "string")
      ? normalizeAllowedPaths(skillPaths)
      : [];
  } catch {
    return [];
  }
}

function codeAgentMaxSteps(): number {
  const value = Number(process.env.QASEY_CODE_AGENT_MAX_STEPS || "80");
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : 80;
}

export const nativeCodingBackendPolicy = {
  isAllowedPath,
  normalizeAllowedPaths,
  taskSkillPaths,
};
