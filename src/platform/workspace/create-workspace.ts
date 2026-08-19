import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { LocalFilesystem, LocalSandbox, Workspace, type WorkspaceSandbox } from "@mastra/core/workspace";
import type { RequestContext } from "@mastra/core/request-context";
import { PlatformRequestContextSchema } from "../context/schema.ts";
import { SubjectSandboxCache } from "./sandbox-lifecycle.ts";

export interface ScopedWorkspaceOptions {
  root: string;
  production: boolean;
  enableCodeExecution: boolean;
  remoteSandbox?: (scope: WorkspaceScope, requestContext: RequestContext) => WorkspaceSandbox | Promise<WorkspaceSandbox>;
}

export interface WorkspaceScope {
  applicationId: string;
  tenantId: string;
  taskId: string;
  executionId: string;
  role: string;
}

export type ManagedWorkspace = Workspace & { close(): Promise<void> };

export function createScopedWorkspace(options: ScopedWorkspaceOptions): ManagedWorkspace {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const scopeFor = (requestContext: RequestContext) => workspaceScope(requestContext);
  const sandboxCache = new SubjectSandboxCache(32, 15 * 60_000);
  const sandbox = !options.enableCodeExecution
    ? undefined
    : options.production
      ? options.remoteSandbox
        ? async ({ requestContext }: { requestContext: RequestContext }) => {
            const scope = scopeFor(requestContext);
            return sandboxCache.get(scopeKey(scope), () => Promise.resolve(options.remoteSandbox!(scope, requestContext)));
          }
        : undefined
      : ({ requestContext }: { requestContext: RequestContext }) => {
          const directory = scopedPath(root, scopeFor(requestContext));
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          return sandboxCache.get(scopeKey(scopeFor(requestContext)), async () => new LocalSandbox({ workingDirectory: directory }));
        };
  const workspace = new Workspace({
    id: "shared-scoped-workspace",
    filesystem: ({ requestContext }) => {
      const directory = scopedPath(root, scopeFor(requestContext));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return new LocalFilesystem({ basePath: directory });
    },
    ...(sandbox ? {
      sandbox,
    } : {}),
  });
  return Object.assign(workspace, { close: () => sandboxCache.close() });
}

export function workspaceScope(requestContext: RequestContext): WorkspaceScope {
  const values = Object.fromEntries([
    "requestId", "applicationId", "channel", "ingressSource", "identity", "sessionId",
    "taskId", "executionId", "mastra__resourceId", "mastra__threadId",
  ].map(key => [key, requestContext.get(key)]));
  const context = PlatformRequestContextSchema.parse(values);
  return {
    applicationId: context.applicationId,
    tenantId: context.identity.tenantId,
    taskId: context.taskId ?? context.sessionId,
    executionId: context.executionId ?? context.requestId,
    role: context.identity.roles[0] ?? "user",
  };
}

function scopedPath(root: string, scope: WorkspaceScope): string {
  const path = resolve(root, ...Object.values(scope).map(safeSegment));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Workspace path escaped configured root");
  return path;
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+$/u, "-").slice(0, 120);
  if (!segment) throw new Error("Workspace scope contains an empty path segment");
  return segment;
}

function scopeKey(scope: WorkspaceScope): string {
  return `${scope.applicationId}:${scope.tenantId}:${scope.taskId}:${scope.executionId}:${scope.role}`;
}
