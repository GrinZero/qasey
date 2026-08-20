import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { LocalFilesystem, LocalSandbox, Workspace, type WorkspaceFilesystem, type WorkspaceSandbox } from "@mastra/core/workspace";
import type { RequestContext } from "@mastra/core/request-context";
import { PlatformRequestContextSchema } from "../context/schema.ts";
import { SubjectSandboxCache } from "./sandbox-lifecycle.ts";

export interface ScopedWorkspaceOptions {
  root: string;
  production: boolean;
  enableCodeExecution: boolean;
  remoteFilesystem?: (scope: WorkspaceScope, requestContext: RequestContext) => WorkspaceFilesystem | Promise<WorkspaceFilesystem>;
  remoteSandbox?: (scope: WorkspaceScope, requestContext: RequestContext) => WorkspaceSandbox | Promise<WorkspaceSandbox>;
}

export interface WorkspaceScope {
  applicationId: string;
  tenantId: string;
  sessionId: string;
}

export type ManagedWorkspace = Workspace & { close(): Promise<void> };

export function createScopedWorkspace(options: ScopedWorkspaceOptions): ManagedWorkspace {
  const root = resolve(options.root);
  const scopeFor = (requestContext: RequestContext) => workspaceScope(requestContext);
  const sandboxCache = new SubjectSandboxCache(32, 15 * 60_000);
  const sandbox = !options.enableCodeExecution
    ? undefined
    : options.remoteSandbox
      ? async ({ requestContext }: { requestContext: RequestContext }) => {
          const scope = scopeFor(requestContext);
          return sandboxCache.get(scopeKey(scope), () => Promise.resolve(options.remoteSandbox?.(scope, requestContext)).then(value => {
            if (!value) throw new Error("Remote sandbox resolver returned no sandbox");
            return value;
          }));
        }
      : options.production
        ? undefined
      : ({ requestContext }: { requestContext: RequestContext }) => {
          const directory = scopedPath(root, scopeFor(requestContext));
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          return sandboxCache.get(scopeKey(scopeFor(requestContext)), async () => new LocalSandbox({ workingDirectory: directory }));
        };
  const workspace = new Workspace({
    id: "shared-scoped-workspace",
    filesystem: ({ requestContext }) => options.remoteFilesystem
      ? options.remoteFilesystem(scopeFor(requestContext), requestContext)
      : localFilesystem(root, scopeFor(requestContext)),
    ...(sandbox ? {
      sandbox,
      sandboxCacheKey: ({ requestContext }: { requestContext: RequestContext }) => scopeKey(scopeFor(requestContext)),
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
    sessionId: context.sessionId,
  };
}

function scopedPath(root: string, scope: WorkspaceScope): string {
  const path = resolve(root, safeSegment(scope.applicationId), safeSegment(scope.tenantId), safeSegment(scope.sessionId));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Workspace path escaped configured root");
  return path;
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+$/u, "-").slice(0, 120);
  if (!segment) throw new Error("Workspace scope contains an empty path segment");
  return segment;
}

function scopeKey(scope: WorkspaceScope): string {
  return `${scope.applicationId}:${scope.tenantId}:${scope.sessionId}`;
}

function localFilesystem(root: string, scope: WorkspaceScope): LocalFilesystem {
  const directory = scopedPath(root, scope);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return new LocalFilesystem({ basePath: directory });
}
