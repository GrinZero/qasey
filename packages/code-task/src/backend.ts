import { createOpenAI } from "@ai-sdk/openai";
import { Agent, type MastraLanguageModel } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import type { ObservabilityExporter, TracingEvent } from "@mastra/core/observability";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { Observability } from "@mastra/observability";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { CodeTaskTraceContext } from "../../contracts/src/index.ts";
import { qaseyE2EAuthorAgent } from "../../../src/mastra/agents/qasey-e2e-author/agent.ts";
import { QASEY_E2E_AUTHOR_ID, QASEY_E2E_AUTHOR_MAX_STEPS } from "../../../src/mastra/agents/qasey-e2e-author/config.ts";
import {
  bindE2EAuthorRuntime,
  type E2ECandidateValidationResult,
} from "../../../src/mastra/agents/qasey-e2e-author/runtime-bindings.ts";
import type { ExecutionProfile } from "./profiles.ts";

export const QASEY_E2E_CODE_AUTHOR_ID = QASEY_E2E_AUTHOR_ID;
export const QASEY_CODE_REVIEWER_ID = "qasey-code-reviewer";

export type CandidateValidationResult = E2ECandidateValidationResult;

export interface CodingAgentRequest {
  taskId: string;
  workspaceRoot: string;
  context: string;
  allowedPaths: string[];
  profile: ExecutionProfile;
  e2eSkillPath?: string;
  traceContext: CodeTaskTraceContext;
  traceMetadata?: Record<string, string | number | boolean | undefined>;
  validateCandidate?: () => Promise<CandidateValidationResult>;
  onTracingEvent?: (event: TracingEvent) => Promise<void> | void;
  credentials?: {
    openaiApiKey?: string;
    openaiBaseUrl?: string;
  };
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
 * Registered Mastra coding backend used inside one isolated CodeTask checkout.
 *
 * Repository lifecycle, checks, and patch collection stay outside the model.
 * The Agent receives only contained filesystem tools; write tools are guarded
 * again at the Workspace boundary by the frozen allowedPaths contract. Each
 * worker process owns a short-lived Mastra runtime, but E2E invocations use
 * one registered Agent identity so traces, scorers, and quality metrics
 * aggregate under a first-class E2E author rather than per-task Agent ids.
 */
export class NativeMastraCodingBackend implements CodingAgentBackend {
  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    let observability: Observability | undefined;
    let releaseE2EAuthorRuntime: (() => void) | undefined;
    const writablePaths = request.profile.writable ? normalizeAllowedPaths(request.allowedPaths) : [];
    const filesystem = new LocalFilesystem({
      basePath: request.workspaceRoot,
      contained: true,
      readOnly: !request.profile.writable,
    });
    const workspace = new Workspace({
      id: `code-task-${request.taskId}`,
      filesystem,
      skills: await repositorySkillPaths(request.workspaceRoot, request.context, request.e2eSkillPath),
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
          beforeToolCall: async ({ workspaceToolName, input }) => {
            if (!WRITE_TOOLS.has(workspaceToolName)) return;
            const path = toolPath(input);
            if (path && isAllowedPath(path, writablePaths)) {
              try {
                await assertContainedWorkspaceWritePath(request.workspaceRoot, path);
                return;
              } catch (error) {
                return {
                  proceed: false as const,
                  output: error instanceof Error ? error.message : "Write rejected by the real-path boundary.",
                };
              }
            }
            return {
              proceed: false as const,
              output: `Write rejected: ${path || "missing path"} is outside the frozen allowedPaths boundary.`,
            };
          },
        },
      },
    });

    try {
      await workspace.init();
      const requiredSkill = request.e2eSkillPath
        ? await workspace.skills?.get(request.e2eSkillPath)
        : undefined;
      if (request.e2eSkillPath && !requiredSkill) {
        throw new Error(`Required repository E2E Skill is invalid or undiscoverable: ${request.e2eSkillPath}`);
      }
      const apiKey = request.credentials?.openaiApiKey;
      const openai = createOpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...(request.credentials?.openaiBaseUrl
          ? { baseURL: request.credentials.openaiBaseUrl.replace(/\/$/u, "") }
          : {}),
      });
      const modelId = process.env.QASEY_CODE_AGENT_MODEL?.trim() || "gpt-5.6-sol";
      const isE2EAuthor = request.profile.id === "web-e2e-author" || request.profile.id === "web-e2e-repair";
      if (isE2EAuthor && !request.validateCandidate) {
        throw new Error("qasey-e2e-author requires the controlled candidate validation binding");
      }
      const model = openai.responses(modelId);
      const reviewer = !isE2EAuthor ? new Agent({
        id: QASEY_CODE_REVIEWER_ID,
        name: "Qasey Code Reviewer",
        description: "Reviews code in one read-only isolated repository checkout.",
        model: openai.responses(modelId),
        workspace,
        instructions: [
          "You are Qasey's repository coding specialist, implemented as a native Mastra Agent.",
          "Activate and follow relevant repository-local Skills before changing files.",
          "Inspect existing tests, page objects, helpers, and conventions before implementing.",
          "Use only Workspace filesystem tools. Repository checks run deterministically after you finish.",
          "Never read, print, or persist credentials. Never weaken assertions to hide a product or environment failure.",
          "Review the frozen task context and report concrete findings without modifying the repository.",
          "This execution profile is read-only; do not modify files.",
        ],
      }) : undefined;
      observability = new Observability({
        configs: {
          default: {
            serviceName: "qasey-code-task",
            requestContextKeys: ["e2eRunId", "codeTaskId", "attemptId", "executionProfile", "baseSha", "contextHash"],
            exporters: [new CodeTaskTracingExporter(request.onTracingEvent)],
          },
        },
      });
      const runtime = new Mastra({
        agents: { codeAgent: isE2EAuthor ? qaseyE2EAuthorAgent : reviewer! },
        observability,
        logger: false,
        environment: process.env.NODE_ENV ?? "development",
      });
      const requestContext = new RequestContext<Record<string, unknown>>();
      requestContext.set("codeTaskId", request.taskId);
      for (const [key, value] of Object.entries(request.traceMetadata ?? {})) {
        if (value !== undefined) requestContext.set(key, value);
      }
      if (isE2EAuthor) {
        releaseE2EAuthorRuntime = bindE2EAuthorRuntime(requestContext, {
          model: model as unknown as MastraLanguageModel,
          workspace,
          profileId: request.profile.id as "web-e2e-author" | "web-e2e-repair",
          writablePaths,
          ...(request.e2eSkillPath ? { requiredSkillPath: request.e2eSkillPath } : {}),
          ...(requiredSkill ? { requiredSkillInstructions: requiredSkill.instructions } : {}),
          validateCandidate: request.validateCandidate!,
          validation: { calls: 0 },
        });
      }
      const propagatedTracing = tracingOptions(request.traceContext);
      // Keep long coding turns on the provider's streaming transport, as in chat.
      // A buffered generation can leave a proxy connection idle during reasoning.
      const stream = await runtime.getAgent("codeAgent").stream([
        `Execution profile: ${request.profile.id}`,
        `Frozen writable paths: ${writablePaths.join(", ") || "none"}`,
        "Complete only the immutable task context below.",
        request.context,
      ].join("\n\n"), {
        runId: request.taskId,
        requestContext,
        maxSteps: codeAgentMaxSteps(),
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            serviceTier: "priority",
            store: false,
          },
        },
        ...(propagatedTracing ? { tracingOptions: propagatedTracing } : {}),
      });
      const output = await completedCodingOutput(stream);
      await observability.flush();
      return {
        summary: output.text || "Native Mastra coding task completed without a textual summary",
        backendRunId: output.runId ?? request.taskId,
      };
    } finally {
      releaseE2EAuthorRuntime?.();
      await observability?.shutdown().catch(() => undefined);
      await workspace.destroy().catch(() => undefined);
    }
  }
}

export async function completedCodingOutput(stream: {
  getFullOutput(): Promise<{ text: string; runId?: string | undefined; error?: Error | undefined; finishReason?: string | undefined }>;
}): Promise<{ text: string; runId?: string | undefined }> {
  const output = await stream.getFullOutput();
  // Streaming can finish with partial text and an error instead of rejecting.
  // Never publish that partial candidate as a successful author result.
  if (output.error) throw output.error;
  if (output.finishReason === "error") throw new Error("Coding agent stream failed before completion");
  return output;
}

class CodeTaskTracingExporter implements ObservabilityExporter {
  readonly name = "code-task-event-exporter";

  constructor(private readonly sink?: (event: TracingEvent) => Promise<void> | void) {}

  async exportTracingEvent(event: TracingEvent): Promise<void> { await this.sink?.(event); }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function tracingOptions(context: CodeTaskTraceContext): { traceId: string; parentSpanId?: string; metadata: Record<string, string> } | undefined {
  const carried = codeTaskTraceIds(context);
  if (!carried) return undefined;
  return {
    traceId: carried.traceId,
    ...(carried.parentSpanId ? { parentSpanId: carried.parentSpanId } : {}),
    metadata: { codeTaskTrace: "propagated" },
  };
}

export function codeTaskTraceIds(context: CodeTaskTraceContext): { traceId: string; parentSpanId?: string } | undefined {
  const traceparent = context.traceparent?.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/iu);
  const traceId = context.traceId ?? traceparent?.[1];
  const parentSpanId = context.parentSpanId ?? traceparent?.[2];
  if (!traceId || !/^[a-f0-9]{32}$/iu.test(traceId)) return undefined;
  if (parentSpanId && !/^[a-f0-9]{16}$/iu.test(parentSpanId)) return { traceId };
  return { traceId, ...(parentSpanId ? { parentSpanId } : {}) };
}

/**
 * Validate the nearest existing ancestor, not only the lexical target. This
 * closes the classic `allowed/path -> /host/path` ancestor-symlink escape
 * before a workspace write tool gets a chance to follow it.
 */
export async function assertContainedWorkspaceWritePath(workspaceRootInput: string, pathInput: string): Promise<void> {
  const workspaceRoot = await realpath(workspaceRootInput);
  const target = resolve(workspaceRoot, pathInput);
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Write rejected: ${pathInput} escaped the task workspace.`);
  }
  let ancestor = target;
  while (ancestor !== workspaceRoot && !await access(ancestor).then(() => true).catch(() => false)) {
    ancestor = dirname(ancestor);
  }
  const resolvedAncestor = await realpath(ancestor);
  if (resolvedAncestor !== workspaceRoot && !resolvedAncestor.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Write rejected: ${pathInput} has an ancestor symlink outside the task workspace.`);
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

export async function repositorySkillPaths(workspaceRoot: string, context: string, requiredSkillPath?: string): Promise<string[]> {
  const configured = taskSkillPaths(context);
  const candidates = [...new Set([...(requiredSkillPath ? [requiredSkillPath] : []), ...configured])];
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const paths: string[] = [];
  for (const candidate of candidates) {
    const absolute = resolve(workspaceRoot, candidate);
    const rel = relative(workspaceRoot, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
      throw new Error(`Repository Skill path escaped the task workspace: ${candidate}`);
    }
    const canonical = await realpath(absolute).catch(() => undefined);
    if (!canonical) {
      if (candidate === requiredSkillPath) throw new Error(`Required repository E2E Skill was not found: ${candidate}`);
      continue;
    }
    if (canonical !== canonicalWorkspaceRoot && !canonical.startsWith(`${canonicalWorkspaceRoot}${sep}`)) {
      throw new Error(`Repository Skill path resolves outside the task workspace: ${candidate}`);
    }
    if (candidate === requiredSkillPath && !(await stat(canonical)).isFile()) {
      throw new Error(`Required repository E2E Skill must be a SKILL.md file: ${candidate}`);
    }
    paths.push(candidate);
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
  const value = Number(process.env.QASEY_CODE_AGENT_MAX_STEPS || String(QASEY_E2E_AUTHOR_MAX_STEPS));
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : QASEY_E2E_AUTHOR_MAX_STEPS;
}

export const nativeCodingBackendPolicy = {
  isAllowedPath,
  normalizeAllowedPaths,
  taskSkillPaths,
};
