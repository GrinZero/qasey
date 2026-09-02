import { createHash } from "node:crypto";
import type { CommandResult, ExecuteCommandOptions, SandboxInfo, WorkspaceSandbox } from "@mastra/core/workspace";
import type {
  CopyOptions, FileContent, FileEntry, FileStat, FilesystemInfo, ListOptions, ReadOptions,
  RemoveOptions, WorkspaceFilesystem, WriteOptions,
} from "@mastra/core/workspace";
import {
  CodeTaskEventPageSchema,
  CodeTaskStateSchema,
  type CodeTaskEventPage,
  type CodeTaskSpec,
  type CodeTaskState,
} from "../../../packages/contracts/src/index.ts";
import type { CodeTaskSecrets } from "../../../packages/code-task/src/index.ts";
import type {
  SandboxBrowserActionSchema, SandboxDesktopActionSchema, SandboxDesktopApplicationSchema,
  SandboxDesktopStartSchema, SandboxDesktopToolSchema, SandboxLease, SandboxLeaseScope,
  SandboxSessionState,
} from "./sandbox-protocol.ts";
import { assertSandboxControlKey, signSandboxControlToken } from "./sandbox-control-token.ts";
import { SandboxCapacityError, type SandboxLeaseStore } from "./sandbox-lease-store.ts";
import type { z } from "zod";

export interface SandboxPoolOptions {
  endpointTemplate: string;
  controlKey: string;
  replicas?: number;
  requestTimeoutMs?: number;
  githubTokenForScope?(scope: SandboxLeaseScope): Promise<string>;
}

export interface SandboxPoolCapacity {
  replicas: number;
  active: number;
  maximum: number;
  available: number;
  unavailableReplicas: number;
}

export class SandboxPoolClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly leases: SandboxLeaseStore, private readonly options: SandboxPoolOptions) {
    assertSandboxControlKey(options.controlKey);
    if (options.replicas !== undefined && (!Number.isInteger(options.replicas) || options.replicas < 1)) {
      throw new RangeError("Sandbox replica count must be a positive integer");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async healthCheck(): Promise<void> {
    await this.leases.healthCheck();
    const results = await Promise.allSettled(this.endpoints().map(async (endpoint, ordinal) => {
      const response = await fetch(`${endpoint}/readyz`, {
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 2_000)),
      });
      if (!response.ok) throw new Error(`Sandbox replica ${ordinal} is not ready`);
      const readiness = await response.json() as { capabilities?: unknown };
      if (!Array.isArray(readiness.capabilities) || !readiness.capabilities.includes("native-mastra")) {
        throw new Error(`Sandbox replica ${ordinal} does not advertise native-mastra`);
      }
    }));
    const failed = results.flatMap((result, ordinal) => result.status === "rejected" ? [ordinal] : []);
    if (failed.length > 0) throw new Error(`Sandbox replicas are not ready: ${failed.join(",")}`);
  }

  async capacity(): Promise<SandboxPoolCapacity> {
    const results = await Promise.allSettled(this.endpoints().map(async endpoint => {
      const response = await fetch(`${endpoint}/capacity`, {
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 2_000)),
      });
      if (!response.ok) throw new Error("Sandbox capacity endpoint is unavailable");
      const value = await response.json() as Record<string, unknown>;
      const active = finiteNonNegativeInteger(value.active);
      const maximum = finiteNonNegativeInteger(value.maximum);
      const available = finiteNonNegativeInteger(value.available);
      if (active + available !== maximum) throw new Error("Sandbox capacity response is inconsistent");
      return { active, maximum, available };
    }));
    const available = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    return {
      replicas: results.length,
      active: available.reduce((total, replica) => total + replica.active, 0),
      maximum: available.reduce((total, replica) => total + replica.maximum, 0),
      available: available.reduce((total, replica) => total + replica.available, 0),
      unavailableReplicas: results.length - available.length,
    };
  }

  async session(scope: SandboxLeaseScope): Promise<SandboxRuntimeSession> {
    const lease = await this.acquireLease(scope);
    const session = await this.runtimeSession(scope, lease);
    try {
      await session.claim();
      return session;
    } catch {
      const reassigned = await this.leases.reassign(scope, lease.ordinal);
      const fallback = await this.runtimeSession(scope, reassigned);
      await fallback.claim();
      return fallback;
    }
  }

  filesystem(scope: SandboxLeaseScope): RemoteWorkspaceFilesystem {
    return new RemoteWorkspaceFilesystem(() => this.session(scope));
  }

  sandbox(scope: SandboxLeaseScope): RemoteWorkspaceSandbox {
    return new RemoteWorkspaceSandbox(() => this.session(scope));
  }

  async release(scope: SandboxLeaseScope): Promise<void> {
    const session = await this.session(scope);
    await session.stop();
    await this.leases.release(scope);
  }

  async startDesktop(scope: SandboxLeaseScope, input: z.input<typeof SandboxDesktopStartSchema> = {}): Promise<{ session: SandboxRuntimeSession; state: SandboxSessionState }> {
    const session = await this.session(scope);
    try {
      return { session, state: await session.desktopStart(input) };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("desktop is currently leased")) throw error;
      await session.stop().catch(() => undefined);
      const reassigned = await this.leases.reassign(scope, session.lease.ordinal);
      const fallback = await this.runtimeSession(scope, reassigned);
      await fallback.claim();
      try {
        return { session: fallback, state: await fallback.desktopStart(input) };
      } catch (fallbackError) {
        await fallback.stop().catch(() => undefined);
        throw fallbackError;
      }
    }
  }

  private async runtimeSession(scope: SandboxLeaseScope, lease: SandboxLease): Promise<SandboxRuntimeSession> {
    const endpoint = this.endpoint(lease.ordinal);
    const githubToken = await this.options.githubTokenForScope?.(scope);
    return new SandboxRuntimeSession(endpoint, lease, this.requestTimeoutMs, () => this.leases.touch(scope), this.options.controlKey, githubToken);
  }

  private async acquireLease(scope: SandboxLeaseScope): Promise<SandboxLease> {
    const deadline = Date.now() + this.requestTimeoutMs;
    while (true) {
      try {
        return await this.leases.acquire(scope);
      } catch (error) {
        if (!(error instanceof SandboxCapacityError) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
      }
    }
  }

  private endpoint(ordinal: number): string {
    return this.options.endpointTemplate.replace("{ordinal}", String(ordinal)).replace(/\/$/u, "");
  }

  private endpoints(): string[] {
    return Array.from({ length: this.options.replicas ?? 1 }, (_value, ordinal) => this.endpoint(ordinal));
  }
}

function finiteNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error("Sandbox capacity response is invalid");
  }
  return value;
}

export class SandboxRuntimeSession {
  constructor(
    readonly endpoint: string,
    readonly lease: SandboxLease,
    private readonly requestTimeoutMs: number,
    private readonly touchLease: () => Promise<void>,
    private readonly controlKey: string,
    private readonly githubToken?: string,
  ) {}

  async claim(): Promise<SandboxSessionState> {
    const claim = {
      sessionId: this.lease.sessionId,
      workspaceId: this.lease.workspaceId,
      generation: this.lease.generation,
      token: this.lease.token,
      repositoryCacheNamespace: repositoryCacheNamespace(this.lease),
      ...(this.githubToken ? { githubToken: this.githubToken } : {}),
    };
    const controlToken = await signSandboxControlToken({ controlKey: this.controlKey, scope: this.lease, claim });
    return this.request("/v1/sessions/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
      body: JSON.stringify(claim),
    }, false);
  }

  async filesystem<T>(body: object): Promise<T> {
    return this.request<T>(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/filesystem`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async execute(body: object, signal?: AbortSignal): Promise<CommandResult> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/execute`, {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  async codeTaskStart(spec: CodeTaskSpec, context: string, secrets?: CodeTaskSecrets): Promise<CodeTaskState> {
    const result = await this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/code-tasks`, {
      method: "POST",
      body: JSON.stringify({ spec, context, ...(secrets ? { secrets } : {}) }),
    });
    return CodeTaskStateSchema.parse(result);
  }

  async codeTaskState(taskId: string): Promise<CodeTaskState> {
    const result = await this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/code-tasks/${encodeURIComponent(taskId)}`, { method: "GET" });
    return CodeTaskStateSchema.parse(result);
  }

  async codeTaskEvents(taskId: string, after?: string): Promise<CodeTaskEventPage> {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const result = await this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/code-tasks/${encodeURIComponent(taskId)}/events${query}`, { method: "GET" });
    return CodeTaskEventPageSchema.parse(result);
  }

  async codeTaskCancel(taskId: string, reason: string): Promise<CodeTaskState> {
    const result = await this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/code-tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    return CodeTaskStateSchema.parse(result);
  }

  async browserStart(input: { url?: string; width?: number; height?: number } = {}): Promise<SandboxSessionState> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/browser/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async browserAction(input: z.infer<typeof SandboxBrowserActionSchema>): Promise<SandboxSessionState> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/browser/action`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async browserFrame(): Promise<{ image: Buffer; url?: string; title?: string }> {
    const response = await this.fetch(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/browser/frame`, { method: "GET" });
    if (!response.ok) throw await responseError(response);
    await this.touchLease();
    return {
      image: Buffer.from(await response.arrayBuffer()),
      ...(response.headers.get("x-qasey-browser-url") ? { url: decodeURIComponent(response.headers.get("x-qasey-browser-url") ?? "") } : {}),
      ...(response.headers.get("x-qasey-browser-title") ? { title: decodeURIComponent(response.headers.get("x-qasey-browser-title") ?? "") } : {}),
    };
  }

  async desktopStart(input: z.input<typeof SandboxDesktopStartSchema> = {}): Promise<SandboxSessionState> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async desktopAction(input: z.infer<typeof SandboxDesktopActionSchema>): Promise<SandboxSessionState & { result?: unknown }> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/action`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async desktopTool(input: z.infer<typeof SandboxDesktopToolSchema>): Promise<{ result: unknown; state: SandboxSessionState }> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/tool`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async desktopApplication(input: z.infer<typeof SandboxDesktopApplicationSchema>): Promise<SandboxSessionState> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/app`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async desktopFrame(): Promise<Buffer> {
    const response = await this.fetch(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/frame`, { method: "GET" });
    if (!response.ok) throw await responseError(response);
    await this.touchLease();
    return Buffer.from(await response.arrayBuffer());
  }

  async desktopStop(): Promise<SandboxSessionState> {
    return this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/desktop/stop`, { method: "POST" });
  }

  async stop(): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(this.lease.sessionId)}/stop`, { method: "POST" });
  }

  private async request<T>(path: string, init: RequestInit, authenticate = true): Promise<T> {
    const response = await this.fetch(path, init, authenticate);
    if (!response.ok) throw await responseError(response);
    if (authenticate) await this.touchLease();
    return await response.json() as T;
  }

  private fetch(path: string, init: RequestInit, authenticate = true): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(`${this.endpoint}${path}`, {
      ...init,
      signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(authenticate ? {
          "x-qasey-session-token": this.lease.token,
          "x-qasey-lease-generation": String(this.lease.generation),
        } : {}),
        ...init.headers,
      },
    });
  }
}

function repositoryCacheNamespace(scope: SandboxLeaseScope): string {
  return createHash("sha256")
    .update(scope.applicationId).update("\0")
    .update(scope.tenantId)
    .digest("hex");
}

export class RemoteWorkspaceFilesystem implements WorkspaceFilesystem {
  readonly id = "qasey-remote-filesystem";
  readonly name = "Qasey Remote Filesystem";
  readonly provider = "qasey-sandbox";
  status: "pending" | "ready" | "error" | "destroyed" = "pending";

  constructor(private readonly resolveSession: () => Promise<SandboxRuntimeSession>) {}

  async init(): Promise<void> { await this.resolveSession(); this.status = "ready"; }
  async destroy(): Promise<void> { this.status = "destroyed"; }
  async isReady(): Promise<boolean> { return this.status === "ready"; }
  async getInfo(): Promise<FilesystemInfo> { return { id: this.id, name: this.name, provider: this.provider, status: this.status }; }
  getInstructions(): string { return "Files persist for this Qasey conversation and are isolated from other session workspaces."; }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const result = await this.call<{ content: string; encoding: "utf8" | "base64" }>({ operation: "readFile", path, ...(options?.encoding ? { encoding: options.encoding } : {}) });
    return result.encoding === "utf8" ? result.content : Buffer.from(result.content, "base64");
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const encoded = encodeContent(content);
    await this.call({ operation: "writeFile", path, ...encoded,
      ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
      ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
      ...(options?.expectedMtime ? { expectedMtime: options.expectedMtime.toISOString() } : {}),
    });
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    await this.call({ operation: "appendFile", path, ...encodeContent(content) });
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    await this.call({ operation: "deleteFile", path, ...removeOptions(options) });
  }

  async copyFile(source: string, destination: string, options?: CopyOptions): Promise<void> {
    await this.call({ operation: "copyFile", source, destination, ...copyOptions(options) });
  }

  async moveFile(source: string, destination: string, options?: CopyOptions): Promise<void> {
    await this.call({ operation: "moveFile", source, destination, ...copyOptions(options) });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.call({ operation: "mkdir", path, ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}) });
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.call({ operation: "rmdir", path, ...removeOptions(options) });
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    return this.call({ operation: "readdir", path,
      ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
      ...(options?.extension !== undefined ? { extension: options.extension } : {}),
      ...(options?.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    });
  }

  async exists(path: string): Promise<boolean> {
    return (await this.call<{ exists: boolean }>({ operation: "exists", path })).exists;
  }

  async stat(path: string): Promise<FileStat> {
    const result = await this.call<Omit<FileStat, "createdAt" | "modifiedAt"> & { createdAt: string; modifiedAt: string }>({ operation: "stat", path });
    return { ...result, createdAt: new Date(result.createdAt), modifiedAt: new Date(result.modifiedAt) };
  }

  async realpath(path: string): Promise<string> {
    return (await this.call<{ path: string }>({ operation: "realpath", path })).path;
  }

  private async call<T = { ok: true }>(body: object): Promise<T> {
    const session = await this.resolveSession();
    return session.filesystem<T>(body);
  }
}

export class RemoteWorkspaceSandbox implements WorkspaceSandbox {
  readonly id = "qasey-remote-sandbox";
  readonly name = "Qasey Remote Sandbox";
  readonly provider = "qasey-sandbox";
  status: SandboxInfo["status"] = "pending";

  constructor(private readonly resolveSession: () => Promise<SandboxRuntimeSession>) {}

  async start(): Promise<void> { await this.resolveSession(); this.status = "running"; }
  async stop(): Promise<void> { const session = await this.resolveSession(); await session.stop(); this.status = "stopped"; }
  async destroy(): Promise<void> { await this.stop(); this.status = "destroyed"; }
  async snapshot(): Promise<void> {}
  async isReady(): Promise<boolean> { return this.status === "running"; }
  getInstructions(): string { return "Commands run in a persistent Qasey session directory inside an isolated remote sandbox runtime."; }
  getInfo(): SandboxInfo { return { id: this.id, name: this.name, provider: this.provider, status: this.status, createdAt: new Date() }; }

  async executeCommand(command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<CommandResult> {
    const session = await this.resolveSession();
    const result = await session.execute({ command, args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: definedEnvironment(options.env) } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.maxRetainedBytes !== undefined && Number.isFinite(options.maxRetainedBytes) ? { maxRetainedBytes: options.maxRetainedBytes } : {}),
    }, options.abortSignal);
    if (result.stdout) options.onStdout?.(result.stdout);
    if (result.stderr) options.onStderr?.(result.stderr);
    this.status = "running";
    return result;
  }
}

function encodeContent(content: FileContent): { content: string; encoding: "utf8" | "base64" } {
  return typeof content === "string"
    ? { content, encoding: "utf8" }
    : { content: Buffer.from(content).toString("base64"), encoding: "base64" };
}

function removeOptions(options?: RemoveOptions): object {
  return {
    ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
    ...(options?.force !== undefined ? { force: options.force } : {}),
  };
}

function copyOptions(options?: CopyOptions): object {
  return {
    ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
    ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
  };
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as { error?: unknown; message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message
    : typeof body?.error === "string" ? body.error
      : `Sandbox runtime request failed with ${response.status}`;
  return new Error(message);
}
