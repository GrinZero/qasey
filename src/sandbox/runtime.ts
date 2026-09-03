import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalFilesystem, LocalSandbox, type ProcessHandle } from "@mastra/core/workspace";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  SandboxBrowserActionSchema, SandboxBrowserStartSchema, SandboxExecuteRequestSchema,
  SandboxDesktopActionSchema, SandboxDesktopApplicationSchema, SandboxDesktopStartSchema,
  SandboxDesktopToolSchema, SandboxFilesystemRequestSchema, SandboxSessionClaimSchema,
  SandboxCodeTaskCancelSchema, SandboxCodeTaskStartSchema,
} from "../platform/workspace/sandbox-protocol.ts";
import type { SandboxSessionState } from "../platform/workspace/sandbox-protocol.ts";
import { assertSandboxControlKey, verifySandboxControlToken } from "../platform/workspace/sandbox-control-token.ts";
import { CodeTaskEventSchema, CodeTaskStateSchema, type CodeTaskSpec, type CodeTaskState } from "../../packages/contracts/src/index.ts";
import {
  buildFreshDeviceBwrapArgs,
  CodeTaskWorkerCredentialsSchema,
  executionProfile,
  writeCodeTaskState,
  type CodeTaskWorkerManifest,
} from "../../packages/code-task/src/index.ts";
import { DesktopController, type DesktopToolResult } from "./desktop.ts";
import { SharedRepositoryCache } from "../../packages/e2e/src/repository-cache.ts";

export const SANDBOX_READINESS_PROBE =
  "test -w . && test -c /dev/null && test -c /dev/urandom && test -d /dev/shm && printf ready";
const SANDBOX_READINESS_RECHECK_MS = 30_000;

interface SandboxRuntimeOptions {
  dataRoot: string;
  port: number;
  host?: string;
  maxSessions: number;
  idleTtlMs: number;
  isolation: "bwrap" | "none";
  controlKey: string;
  egressProxyUrl?: string;
  browserAllowedOrigins?: readonly string[];
  commandTimeoutMs: number;
  workspaceRetentionMs: number;
  desktopEnabled?: boolean;
  desktopDisplay?: number;
  desktopWidth?: number;
  desktopHeight?: number;
  driverWorkerPath?: string;
  codeTaskWorkerPath?: string;
  codeTaskEnvAllowlist?: string[];
  shutdownTimeoutMs?: number;
  imageDigest?: string;
  codeTaskRepositoryPreparer?(repositoryRoot: string, spec: CodeTaskSpec, taskRoot: string): Promise<string>;
  headlessBrowserLauncher?(options: Parameters<typeof chromium.launch>[0]): Promise<Browser>;
}

export interface SandboxBrowserRequestPolicyInput {
  url: string;
  resourceType: string;
  isNavigationRequest: boolean;
  redirectedFromUrl?: string;
}

export type SandboxBrowserRequestPolicyDecision =
  | { allowed: true; reason: "allowed-origin" | "browser-internal"; origin?: string }
  | { allowed: false; reason: "invalid-url" | "unsupported-scheme" | "origin-not-allowed" | "url-credentials-not-allowed"; origin?: string };

const SANDBOX_LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";
const SANDBOX_PROXY_ENVIRONMENT_KEYS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

/**
 * Decide whether one browser request may leave the sandbox browser context.
 * Redirect targets and subresources are evaluated independently by the
 * BrowserContext route handler, so an allowed document cannot widen policy.
 */
export function evaluateSandboxBrowserRequestPolicy(
  input: SandboxBrowserRequestPolicyInput,
  allowedOrigins: readonly string[],
): SandboxBrowserRequestPolicyDecision {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }

  if (target.protocol === "about:") {
    return target.pathname === "blank" || target.pathname === "srcdoc"
      ? { allowed: true, reason: "browser-internal" }
      : { allowed: false, reason: "unsupported-scheme" };
  }
  if (target.protocol === "data:") return { allowed: true, reason: "browser-internal" };
  if (target.protocol === "blob:") {
    const origin = target.origin;
    return origin !== "null" && allowedOrigins.includes(origin)
      ? { allowed: true, reason: "browser-internal", origin }
      : { allowed: false, reason: "origin-not-allowed", ...(origin !== "null" ? { origin } : {}) };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:" && target.protocol !== "ws:" && target.protocol !== "wss:") {
    return { allowed: false, reason: "unsupported-scheme" };
  }
  const origin = target.protocol === "ws:" || target.protocol === "wss:"
    ? `${target.protocol === "wss:" ? "https:" : "http:"}//${target.host}`
    : target.origin;
  if (target.username || target.password) {
    return { allowed: false, reason: "url-credentials-not-allowed", origin };
  }
  return allowedOrigins.includes(origin)
    ? { allowed: true, reason: "allowed-origin", origin }
    : { allowed: false, reason: "origin-not-allowed", origin };
}

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sandbox: LocalSandbox;
  root: string;
  runRoot: string;
  storageStatePath: string;
}

interface SessionRequestLease {
  controller: AbortController;
  completion: Promise<void>;
  release(): void;
}

interface ActiveSession {
  sessionId: string;
  workspaceId: string;
  generation: number;
  tokenHash: Buffer;
  environment: NodeJS.ProcessEnv;
  githubToken?: string;
  githubTokenHash?: Buffer;
  root: string;
  filesystem: LocalFilesystem;
  sandbox: LocalSandbox;
  inFlightRequests: Set<SessionRequestLease>;
  browser?: BrowserSession;
  browserStartReservation?: object;
  activeCodeTask?: ActiveCodeTask;
  codeTaskStartReservation?: CodeTaskStartReservation;
  closing?: boolean;
  closePromise?: Promise<void>;
  lastActivityAt: number;
}

interface CodeTaskStartReservation {
  taskId: string;
  attemptId: string;
  taskRoot?: string;
}

interface ActiveCodeTask {
  taskId: string;
  attemptId: string;
  process: ProcessHandle;
  sandbox: LocalSandbox;
  taskRoot: string;
  statePath: string;
  eventsPath: string;
  heartbeat: NodeJS.Timeout;
  hardDeadline: NodeJS.Timeout;
  finalization?: Promise<void>;
  cancellation?: Promise<CodeTaskState>;
}

interface PreparedCodeTaskRepositories {
  primaryRoot: string;
  primaryMode: "read" | "write";
  readOnlyRoots: string[];
  readWriteRoots: string[];
  mounts: CodeTaskWorkerManifest["repositoryMounts"];
}

const CODE_TASK_ARTIFACT_PREFIX = "code-task-artifacts";

interface DesktopLease {
  ownerSessionId: string;
  recording: boolean;
  applications: Set<string>;
  browser?: { browser: Browser; context: BrowserContext; page: Page };
}

export class QaseySandboxRuntime {
  private readonly sessions = new Map<string, ActiveSession>();
  private ready = false;
  private readinessError?: string;
  private readinessCheckedAt = 0;
  private readinessCheckInFlight?: Promise<void>;
  private gcTimer?: NodeJS.Timeout;
  private readonly dataRoot: string;
  private readonly repositoryCache: SharedRepositoryCache;
  private sessionLifecycleLock: Promise<void> = Promise.resolve();
  private boundPort?: number;
  private desktopHost?: DesktopController;
  private desktopLease?: DesktopLease;

  constructor(private readonly options: SandboxRuntimeOptions) {
    assertSandboxControlKey(options.controlKey);
    this.dataRoot = resolve(options.dataRoot);
    this.repositoryCache = new SharedRepositoryCache(join(this.dataRoot, "git-cache"));
  }

  async start(): Promise<{ port: number; close(): Promise<void> }> {
    await mkdir(join(this.dataRoot, "workspaces"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "browser"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "desktop"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "git-cache"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "code-tasks"), { recursive: true, mode: 0o700 });
    try {
      await this.startDesktopHost();
      await this.runReadinessCheck();
      this.ready = true;
      this.readinessCheckedAt = Date.now();
    } catch (error) {
      this.readinessError = error instanceof Error ? error.message : String(error);
      this.readinessCheckedAt = Date.now();
      await this.desktopHost?.close().catch(() => undefined);
      delete this.desktopHost;
    }
    const server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        const status = error instanceof HttpError ? error.status : 500;
        sendJson(response, status, { error: status === 500 ? "internal_error" : "request_error", message: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolveStart();
      });
    });
    this.gcTimer = setInterval(() => {
      void this.evictIdle().catch(error => this.reportBackgroundFailure("sandbox.gc.failed", error));
    }, Math.min(60_000, Math.max(5_000, this.options.idleTtlMs / 2)));
    this.gcTimer.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Sandbox runtime did not bind a TCP port");
    this.boundPort = (address as AddressInfo).port;
    let shutdownPromise: Promise<void> | undefined;
    return {
      port: this.boundPort,
      close: () => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
          this.ready = false;
          if (this.gcTimer) clearInterval(this.gcTimer);
          const serverClosed = new Promise<void>((resolveClose, reject) => {
            server.close(error => error ? reject(error) : resolveClose());
          });
          server.closeIdleConnections();
          const resourcesClosed = (async () => {
            await this.withSessionLifecycleLock(async () => {
              await Promise.allSettled([...this.sessions.values()].map(session => this.closeSession(session)));
              this.sessions.clear();
            });
            await this.desktopHost?.close().catch(() => undefined);
            delete this.desktopHost;
            server.closeIdleConnections();
          })();
          const cleanup = Promise.all([serverClosed, resourcesClosed]).then(() => undefined);
          const timeoutMs = this.options.shutdownTimeoutMs ?? 25_000;
          let timeout: NodeJS.Timeout | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`Sandbox shutdown exceeded ${timeoutMs}ms`)), timeoutMs);
            timeout.unref();
          });
          try {
            await Promise.race([cleanup, deadline]);
          } catch (error) {
            server.closeAllConnections();
            void cleanup.catch(cleanupError => {
              this.reportBackgroundFailure("sandbox.shutdown.cleanup_failed", cleanupError);
            });
            throw error;
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        })();
        return shutdownPromise;
      },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://sandbox.invalid");
    if (method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (method === "GET" && url.pathname === "/readyz") {
      await this.refreshReadinessIfStale();
      return sendJson(response, this.ready ? 200 : 503, {
        status: this.ready ? "ready" : "not_ready",
        isolation: this.options.isolation,
        capabilities: ["native-mastra"],
        codeAgent: { configured: Boolean(process.env.OPENAI_API_KEY) },
        ...(this.readinessError ? { error: this.readinessError } : {}),
      });
    }
    if (method === "GET" && url.pathname === "/capacity") {
      return sendJson(response, 200, {
        active: this.sessions.size,
        maximum: this.options.maxSessions,
        available: Math.max(0, this.options.maxSessions - this.sessions.size),
        desktop: { enabled: Boolean(this.desktopHost), available: Boolean(this.desktopHost && !this.desktopLease) },
      });
    }
    if (!this.ready) throw new HttpError(503, "Sandbox runtime is not ready");
    if (method === "POST" && url.pathname === "/v1/sessions/claim") {
      const controlToken = bearerToken(request.headers.authorization);
      if (!controlToken) throw new HttpError(401, "Invalid sandbox control token");
      const rawClaim = await readJson(request);
      const parsedClaim = SandboxSessionClaimSchema.safeParse(rawClaim);
      if (!parsedClaim.success) throw new HttpError(401, "Invalid sandbox control token");
      const claim = parsedClaim.data;
      try {
        await verifySandboxControlToken({ controlKey: this.options.controlKey, token: controlToken, claim });
      } catch {
        throw new HttpError(401, "Invalid sandbox control token");
      }
      const state = await this.claim(claim);
      return sendJson(response, 200, state);
    }
    const codeTaskMatch = /^\/v1\/sessions\/([^/]+)\/code-tasks(?:\/([^/]+)(?:\/(events|cancel))?)?$/u.exec(url.pathname);
    if (codeTaskMatch) {
      const sessionId = decodeURIComponent(codeTaskMatch[1] ?? "");
      const session = this.authenticate(request, sessionId);
      const lease = this.beginSessionRequest(session);
      try {
        session.lastActivityAt = Date.now();
        await this.touchWorkspace(session);
        this.assertSessionOpen(session);
        const taskId = codeTaskMatch[2] ? decodeURIComponent(codeTaskMatch[2]) : undefined;
        const action = codeTaskMatch[3];
        if (method === "POST" && !taskId) return sendJson(response, 202, await this.startCodeTask(session, await readJson(request)));
        if (method === "GET" && taskId && action === "events") {
          return sendJson(response, 200, await this.codeTaskEvents(session, taskId, url.searchParams.get("after") ?? undefined));
        }
        if (method === "POST" && taskId && action === "cancel") {
          return sendJson(response, 200, await this.cancelCodeTask(session, taskId, SandboxCodeTaskCancelSchema.parse(await readJson(request)).reason));
        }
        if (method === "GET" && taskId && !action) return sendJson(response, 200, await this.codeTaskState(session, taskId));
        throw new HttpError(405, "Method not allowed");
      } finally {
        lease.release();
      }
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(filesystem|execute|stop|browser\/start|browser\/action|browser\/frame|desktop\/start|desktop\/action|desktop\/tool|desktop\/app|desktop\/frame|desktop\/stop)$/u.exec(url.pathname);
    if (!match) throw new HttpError(404, "Route not found");
    const sessionId = decodeURIComponent(match[1] ?? "");
    const operation = match[2] ?? "";
    const session = this.authenticate(request, sessionId);
    if (operation === "stop") {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      await this.withSessionLifecycleLock(async () => {
        await this.closeSession(session);
        if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
      });
      return sendJson(response, 200, { stopped: true });
    }
    const lease = this.beginSessionRequest(session);
    try {
      session.lastActivityAt = Date.now();
      await this.touchWorkspace(session);
      this.assertSessionOpen(session);
      if (method === "POST" && operation === "filesystem") return sendJson(response, 200, await this.filesystem(session, await readJson(request)));
      if (method === "POST" && operation === "execute") return sendJson(response, 200, await this.execute(session, await readJson(request), lease.controller.signal));
      if (method === "POST" && operation === "browser/start") return sendJson(response, 200, await this.browserStart(session, await readJson(request)));
      if (method === "POST" && operation === "browser/action") return sendJson(response, 200, await this.browserAction(session, await readJson(request)));
      if (method === "GET" && operation === "browser/frame") return await this.browserFrame(session, response);
      if (method === "POST" && operation === "desktop/start") return sendJson(response, 200, await this.desktopStart(session, await readJson(request)));
      if (method === "POST" && operation === "desktop/action") return sendJson(response, 200, await this.desktopAction(session, await readJson(request)));
      if (method === "POST" && operation === "desktop/tool") return sendJson(response, 200, await this.desktopTool(session, await readJson(request)));
      if (method === "POST" && operation === "desktop/app") return sendJson(response, 200, await this.desktopApplication(session, await readJson(request)));
      if (method === "GET" && operation === "desktop/frame") return await this.desktopFrame(session, response);
      if (method === "POST" && operation === "desktop/stop") {
        await this.releaseDesktop(session);
        return sendJson(response, 200, await this.state(session));
      }
      throw new HttpError(405, "Method not allowed");
    } finally {
      lease.release();
    }
  }

  private async claim(input: ReturnType<typeof SandboxSessionClaimSchema.parse>): Promise<SandboxSessionState> {
    return this.withSessionLifecycleLock(() => this.claimExclusive(input));
  }

  private async withSessionLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.sessionLifecycleLock;
    let release!: () => void;
    this.sessionLifecycleLock = new Promise<void>(resolveLock => { release = resolveLock; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async claimExclusive(input: ReturnType<typeof SandboxSessionClaimSchema.parse>): Promise<SandboxSessionState> {
    const current = this.sessions.get(input.sessionId);
    if (current?.closing) throw new HttpError(409, "Sandbox session is closing");
    const incomingHash = hashToken(input.token);
    if (current && current.generation === input.generation && equalToken(current.tokenHash, incomingHash)) {
      if (sameOptionalToken(current.githubTokenHash, input.githubToken)) {
        current.lastActivityAt = Date.now();
        return this.state(current);
      }
    } else if (current && input.generation <= current.generation) {
      throw new HttpError(409, "Stale sandbox lease generation");
    }
    if (current) {
      await this.closeSession(current);
      if (this.sessions.get(input.sessionId) === current) this.sessions.delete(input.sessionId);
    }
    if (this.sessions.size >= this.options.maxSessions) throw new HttpError(429, "Sandbox replica is at capacity");
    const root = containedPath(join(this.dataRoot, "workspaces"), input.workspaceId);
    const home = join(root, "home");
    const repository = join(root, "repo");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(repository, { recursive: true, mode: 0o700 }),
    ]);
    const filesystem = new LocalFilesystem({ basePath: repository, contained: true });
    let sandbox: LocalSandbox | undefined;
    let installedSession: ActiveSession | undefined;
    try {
      await filesystem._init();
      const environment = sessionEnvironment(home, this.options.egressProxyUrl);
      const sessionReadOnlyPaths = sandboxRuntimeReadOnlyPaths(this.options.codeTaskWorkerPath ?? defaultCodeTaskWorkerPath());
      const sessionBwrapArgs = buildFreshDeviceBwrapArgs({
        isolation: this.options.isolation,
        workspacePath: repository,
        allowNetwork: true,
        readOnlyPaths: sessionReadOnlyPaths,
        readWritePaths: [home],
      });
      sandbox = new LocalSandbox({
        id: `qasey-${input.workspaceId}`,
        workingDirectory: repository,
        timeout: this.options.commandTimeoutMs,
        isolation: this.options.isolation,
        env: environment,
        nativeSandbox: {
          allowNetwork: true,
          allowSystemBinaries: true,
          readOnlyPaths: sessionReadOnlyPaths,
          readWritePaths: [home],
          ...(sessionBwrapArgs ? { bwrapArgs: sessionBwrapArgs } : {}),
        },
      });
      await sandbox._start();
      const session: ActiveSession = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        generation: input.generation,
        tokenHash: incomingHash,
        environment,
        ...(input.githubToken ? { githubToken: input.githubToken, githubTokenHash: hashToken(input.githubToken) } : {}),
        root,
        filesystem,
        sandbox,
        inFlightRequests: new Set(),
        lastActivityAt: Date.now(),
      };
      await this.recoverInterruptedCodeTasks(this.codeTaskWorkspaceRoot(input.workspaceId));
      this.sessions.set(input.sessionId, session);
      installedSession = session;
      await this.touchWorkspace(session);
      return await this.state(session);
    } catch (error) {
      if (installedSession) {
        if (this.sessions.get(input.sessionId) === installedSession) this.sessions.delete(input.sessionId);
        await this.closeSession(installedSession).catch(() => undefined);
      } else {
        await sandbox?._destroy().catch(() => undefined);
        await filesystem._destroy().catch(() => undefined);
      }
      throw error;
    }
  }

  private authenticate(request: IncomingMessage, sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "Sandbox session not found");
    const generation = Number(request.headers["x-qasey-lease-generation"]);
    const token = request.headers["x-qasey-session-token"];
    if (generation !== session.generation || typeof token !== "string" || !equalToken(session.tokenHash, hashToken(token))) {
      throw new HttpError(401, "Invalid sandbox session credential");
    }
    return session;
  }

  private async filesystem(session: ActiveSession, raw: unknown): Promise<unknown> {
    const input = SandboxFilesystemRequestSchema.parse(raw);
    const protectedPaths = filesystemRequestPaths(input).filter(path => isCodeTaskArtifactVirtualPath(path));
    if (protectedPaths.length > 0) {
      if (input.operation !== "readFile" || protectedPaths.length !== 1) {
        throw new HttpError(403, "Code task artifacts are read-only through the sandbox filesystem");
      }
      return this.readCompletedCodeTaskArtifact(session, input.path, input.encoding);
    }
    const filesystem = session.filesystem;
    switch (input.operation) {
      case "readFile": {
        const content = await filesystem.readFile(input.path);
        if (typeof content === "string") return { content, encoding: "utf8" };
        if (input.encoding && Buffer.isEncoding(input.encoding)) return { content: content.toString(input.encoding), encoding: "utf8" };
        return { content: content.toString("base64"), encoding: "base64" };
      }
      case "writeFile":
        await filesystem.writeFile(input.path, decodeContent(input.content, input.encoding), {
          ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
          ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
          ...(input.expectedMtime ? { expectedMtime: new Date(input.expectedMtime) } : {}),
        });
        return { ok: true };
      case "appendFile": await filesystem.appendFile(input.path, decodeContent(input.content, input.encoding)); return { ok: true };
      case "deleteFile": await filesystem.deleteFile(input.path, removeOptions(input.recursive, input.force)); return { ok: true };
      case "copyFile": await filesystem.copyFile(input.source, input.destination, copyOptions(input.recursive, input.overwrite)); return { ok: true };
      case "moveFile": await filesystem.moveFile(input.source, input.destination, copyOptions(input.recursive, input.overwrite)); return { ok: true };
      case "mkdir": await filesystem.mkdir(input.path, input.recursive === undefined ? {} : { recursive: input.recursive }); return { ok: true };
      case "rmdir": await filesystem.rmdir(input.path, removeOptions(input.recursive, input.force)); return { ok: true };
      case "readdir": return filesystem.readdir(input.path, listOptions(input.recursive, input.extension, input.maxDepth));
      case "exists": return { exists: await filesystem.exists(input.path) };
      case "stat": return filesystem.stat(input.path);
      case "realpath": return { path: await filesystem.realpath(input.path) };
    }
  }

  private async execute(session: ActiveSession, raw: unknown, abortSignal: AbortSignal): Promise<unknown> {
    const input = SandboxExecuteRequestSchema.parse(raw);
    const cwd = input.cwd ? containedPath(join(session.root, "repo"), input.cwd) : join(session.root, "repo");
    this.assertSessionOpen(session);
    return executeSandboxCommand(session.sandbox, input.command, input.args, {
      cwd,
      env: sandboxEnvironmentWithProxy(input.env ?? {}, this.options.egressProxyUrl),
      timeout: input.timeout ?? this.options.commandTimeoutMs,
      maxRetainedBytes: input.maxRetainedBytes ?? 1024 * 1024,
      abortSignal,
    });
  }

  private async startCodeTask(session: ActiveSession, raw: unknown): Promise<CodeTaskState> {
    const input = SandboxCodeTaskStartSchema.parse(raw);
    const { spec } = input;
    if (spec.scope.sessionId !== session.sessionId) throw new HttpError(403, "Code task scope does not match the authenticated sandbox session");
    this.assertSessionOpen(session);
    if (session.activeCodeTask) {
      const phase = session.activeCodeTask.process.exitCode === undefined ? "running" : "finishing";
      throw new HttpError(409, `Sandbox session is already ${phase} code task ${session.activeCodeTask.taskId}`);
    }
    if (session.codeTaskStartReservation) {
      throw new HttpError(409, `Sandbox session is already starting code task ${session.codeTaskStartReservation.taskId}`);
    }
    const reservation: CodeTaskStartReservation = { taskId: spec.taskId, attemptId: spec.attemptId };
    session.codeTaskStartReservation = reservation;
    try {
      return await this.startReservedCodeTask(session, input, reservation);
    } catch (error) {
      if (reservation.taskRoot) await rm(reservation.taskRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (session.codeTaskStartReservation === reservation) delete session.codeTaskStartReservation;
    }
  }

  private async startReservedCodeTask(
    session: ActiveSession,
    input: ReturnType<typeof SandboxCodeTaskStartSchema.parse>,
    reservation: CodeTaskStartReservation,
  ): Promise<CodeTaskState> {
    const { spec } = input;
    const taskSegment = safeTaskSegment(spec.taskId);
    const attemptSegment = safeTaskSegment(spec.attemptId);
    const taskRoot = containedPath(this.codeTaskWorkspaceRoot(session.workspaceId), join(taskSegment, attemptSegment));
    if (await fileExists(taskRoot)) throw new HttpError(409, "Code task attempt already exists");
    reservation.taskRoot = taskRoot;
    const controlRoot = join(taskRoot, "control");
    const artifactRoot = join(taskRoot, "artifacts");
    const checkRoot = join(taskRoot, "check-output");
    const home = join(taskRoot, "home");
    const packageStoreRoot = join(this.options.dataRoot, "package-cache", "pnpm");
    await Promise.all([
      mkdir(controlRoot, { recursive: true, mode: 0o700 }),
      mkdir(artifactRoot, { recursive: true, mode: 0o700 }),
      mkdir(checkRoot, { recursive: true, mode: 0o700 }),
      mkdir(join(home, ".config"), { recursive: true, mode: 0o700 }),
      mkdir(join(home, ".cache"), { recursive: true, mode: 0o700 }),
      mkdir(join(home, ".local", "share"), { recursive: true, mode: 0o700 }),
      mkdir(packageStoreRoot, { recursive: true, mode: 0o700 }),
    ]);
    const prepared = this.options.codeTaskRepositoryPreparer
      ? await this.prepareCustomCodeTaskRepository(session, spec, taskRoot)
      : await this.prepareCodeTaskRepositories(session, spec, taskRoot);
    this.assertSessionOpen(session);
    const inputPatchPath = spec.inputPatchRef ? join(controlRoot, "input.patch") : undefined;
    if (spec.inputPatchRef && inputPatchPath) {
      const source = await this.resolveSandboxArtifactPath(session, spec.inputPatchRef.uri);
      await copyFile(source, inputPatchPath);
      await chmod(inputPatchPath, 0o600);
    }
    const statePath = join(controlRoot, "state.json");
    const eventsPath = join(controlRoot, "events.ndjson");
    const createdAt = new Date().toISOString();
    const queued: CodeTaskState = { taskId: spec.taskId, attemptId: spec.attemptId, status: "queued", createdAt, updatedAt: createdAt };
    await writeCodeTaskState(statePath, queued);
    const manifestPath = join(controlRoot, "manifest.json");
    const workerPath = this.options.codeTaskWorkerPath ?? defaultCodeTaskWorkerPath();
    const checkRuntimeReadOnlyPaths = sandboxRuntimeReadOnlyPaths(workerPath);
    const manifest: CodeTaskWorkerManifest = {
      spec,
      context: input.context,
      workspaceRoot: prepared.primaryRoot,
      taskRoot,
      controlRoot,
      artifactRoot,
      artifactUriPrefix: `sandbox://${CODE_TASK_ARTIFACT_PREFIX}/${taskSegment}/${attemptSegment}`,
      checkRoot,
      packageStoreRoot,
      isolation: this.options.isolation,
      checkRuntimeReadOnlyPaths,
      statePath,
      eventsPath,
      ...(inputPatchPath ? { inputPatchPath } : {}),
      repositoryMounts: prepared.mounts,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const workerEnvironment = this.codeTaskWorkerEnvironment(session, spec, taskRoot, input.secrets?.environment);
    const taskReadOnlyPaths = [...checkRuntimeReadOnlyPaths, ...prepared.readOnlyRoots];
    const taskReadWritePaths = [controlRoot, artifactRoot, checkRoot, home, packageStoreRoot, ...prepared.readWriteRoots];
    const taskBwrapArgs = buildFreshDeviceBwrapArgs({
      isolation: this.options.isolation,
      workspacePath: prepared.primaryRoot,
      allowNetwork: true,
      readOnly: prepared.primaryMode === "read",
      readOnlyPaths: taskReadOnlyPaths,
      readWritePaths: taskReadWritePaths,
    });
    const taskSandbox = new LocalSandbox({
      id: `qasey-code-task-${safeTaskSegment(spec.taskId)}-${safeTaskSegment(spec.attemptId)}`,
      workingDirectory: prepared.primaryRoot,
      timeout: spec.deadlineMs,
      isolation: this.options.isolation,
      env: workerEnvironment,
      nativeSandbox: {
        allowNetwork: true,
        allowSystemBinaries: true,
        readOnly: prepared.primaryMode === "read",
        readOnlyPaths: taskReadOnlyPaths,
        readWritePaths: taskReadWritePaths,
        ...(taskBwrapArgs ? { bwrapArgs: taskBwrapArgs } : {}),
      },
    });
    let worker: ProcessHandle;
    let workerCompletion: ReturnType<ProcessHandle["wait"]> | undefined;
    try {
      await taskSandbox._start();
      this.assertSessionOpen(session);
      worker = await taskSandbox.processes.spawn(
        [process.execPath, workerPath, manifestPath].map(shellArgument).join(" "),
        { cwd: prepared.primaryRoot, timeout: spec.deadlineMs, maxRetainedBytes: 64 * 1024 },
      );
      this.assertSessionOpen(session);
      // Register the exit observer while the worker is still blocked on its
      // one-shot credential channel. Otherwise a fast validation failure can
      // exit between sendStdin() and wait(), leaving the active-task guard set.
      workerCompletion = worker.wait();
      await worker.sendStdin(`${JSON.stringify(this.codeTaskWorkerCredentials(spec))}\n`);
      this.assertSessionOpen(session);
    } catch (error) {
      void workerCompletion?.catch(() => undefined);
      await taskSandbox._destroy().catch(() => undefined);
      throw error;
    }
    if (!workerCompletion) {
      await taskSandbox._destroy().catch(() => undefined);
      throw new Error("Code task worker exit observer was not registered");
    }
    const heartbeat = setInterval(() => {
      void this.touchWorkspace(session).then(() => {
        if (!session.closing) session.lastActivityAt = Date.now();
      }, error => {
        this.reportBackgroundFailure("sandbox.code_task.heartbeat_failed", error, {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
        });
        if (session.activeCodeTask?.process === worker && worker.exitCode === undefined) {
          void worker.kill().catch(() => undefined);
        }
      });
    }, Math.max(5_000, Math.min(30_000, this.options.idleTtlMs / 3)));
    heartbeat.unref();
    const active: ActiveCodeTask = {
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      process: worker,
      sandbox: taskSandbox,
      taskRoot,
      statePath,
      eventsPath,
      heartbeat,
      hardDeadline: setTimeout(() => {
        if (worker.exitCode === undefined) void worker.kill().catch(() => undefined);
      }, spec.deadlineMs + 5_000),
    };
    active.hardDeadline.unref();
    session.activeCodeTask = active;
    active.finalization = workerCompletion
      .then(result => {
        const diagnostic = safeProcessDiagnostic(result.stderr || result.stdout, 2_000).trim();
        return this.finishCodeTaskProcess(
          session,
          active,
          result.exitCode === 0
            ? undefined
            : new Error(`Code task worker exited with code ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ""}`),
        );
      }, error => this.finishCodeTaskProcess(
        session,
        active,
        error instanceof Error ? error : new Error(String(error)),
      ))
      .catch(finalizationError => {
        console.error(JSON.stringify({
          event: "sandbox.code_task.finalization_callback_failed",
          taskId: active.taskId,
          attemptId: active.attemptId,
          error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError),
        }));
      });
    return queued;
  }

  private assertSessionOpen(session: ActiveSession): void {
    if (session.closing) throw new HttpError(409, "Sandbox session is closing");
  }

  private beginSessionRequest(session: ActiveSession): SessionRequestLease {
    this.assertSessionOpen(session);
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    let released = false;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    let lease!: SessionRequestLease;
    lease = {
      controller,
      completion,
      release: () => {
        if (released) return;
        released = true;
        session.inFlightRequests.delete(lease);
        resolveCompletion();
      },
    };
    session.inFlightRequests.add(lease);
    return lease;
  }

  private async codeTaskState(session: ActiveSession, taskId: string): Promise<CodeTaskState> {
    const paths = await this.findCodeTaskPaths(session, taskId);
    if (!paths) throw new HttpError(404, "Code task not found");
    const state = CodeTaskStateSchema.parse(JSON.parse(await readFile(paths.statePath, "utf8")));
    const active = session.activeCodeTask;
    if (active?.taskId === state.taskId && active.attemptId === state.attemptId
      && ["succeeded", "failed", "cancelled", "lost"].includes(state.status)) {
      // A terminal result is externally observable only after the worker and
      // its nested fixed-check namespace have exited and cleanup has removed
      // the active-task guard. This preserves the artifact read-after-state
      // contract without exposing files from a still-running process.
      return {
        taskId: state.taskId,
        attemptId: state.attemptId,
        status: "running",
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };
    }
    return state;
  }

  private async codeTaskEvents(session: ActiveSession, taskId: string, after?: string): Promise<{ events: unknown[]; nextCursor?: string }> {
    const paths = await this.findCodeTaskPaths(session, taskId);
    if (!paths) throw new HttpError(404, "Code task not found");
    const minimum = after ? Number(after) : 0;
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new HttpError(400, "Invalid code task event cursor");
    const events = (await readFile(paths.eventsPath, "utf8").catch(() => ""))
      .split("\n").filter(Boolean)
      .map(line => CodeTaskEventSchema.parse(JSON.parse(line)))
      .filter(event => Number(event.cursor) > minimum)
      .slice(0, 500);
    const nextCursor = events.at(-1)?.cursor;
    return { events, ...(nextCursor ? { nextCursor } : {}) };
  }

  private cancelCodeTask(session: ActiveSession, taskId: string, reason: string): Promise<CodeTaskState> {
    const active = session.activeCodeTask;
    if (active?.taskId === taskId) {
      if (active.cancellation) return active.cancellation;
      const cancellation = this.cancelActiveCodeTask(session, active, reason);
      active.cancellation = cancellation;
      return cancellation;
    }
    return this.cancelInactiveCodeTask(session, taskId);
  }

  private async cancelInactiveCodeTask(session: ActiveSession, taskId: string): Promise<CodeTaskState> {
    const current = await this.codeTaskState(session, taskId);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    const lost = { ...current, status: "lost" as const, updatedAt: new Date().toISOString(), error: "Code task worker is no longer active" };
    await writeCodeTaskState((await this.findCodeTaskPaths(session, taskId))!.statePath, lost);
    return lost;
  }

  private async cancelActiveCodeTask(session: ActiveSession, active: ActiveCodeTask, reason: string): Promise<CodeTaskState> {
    const current = await this.codeTaskState(session, active.taskId);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    if (active.process.exitCode !== undefined) {
      await active.finalization?.catch(() => undefined);
      return this.codeTaskState(session, active.taskId);
    }
    const requested = { ...current, status: "cancel_requested" as const, updatedAt: new Date().toISOString(), error: reason };
    await writeCodeTaskState(active.statePath, requested);
    signalProcessHandle(active.process, "SIGTERM");
    const processCompletion = active.process.wait();
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      processCompletion.then(() => true, () => true),
      new Promise<false>(resolveWait => { timeout = setTimeout(() => resolveWait(false), 5_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited && active.process.exitCode === undefined) await active.process.kill();
    await processCompletion.catch(() => undefined);
    if (!await this.codeTaskEventExists(active.eventsPath, "task.cancel_requested")) {
      await this.appendCodeTaskEvent(active, "task.cancel_requested", "Code task cancellation requested", { reason });
    }
    const observed = await readFile(active.statePath, "utf8")
      .then(value => CodeTaskStateSchema.parse(JSON.parse(value)))
      .catch(() => requested);
    if (observed.status === "succeeded" || observed.status === "failed") return observed;
    const cancelled = CodeTaskStateSchema.parse({
      ...observed,
      taskId: active.taskId,
      attemptId: active.attemptId,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      error: reason,
    });
    await writeCodeTaskState(active.statePath, cancelled);
    await this.appendCodeTaskEvent(active, "task.cancelled", "Code task process group terminated");
    return cancelled;
  }

  private async codeTaskEventExists(eventsPath: string, type: string): Promise<boolean> {
    const lines = (await readFile(eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return lines.some(line => CodeTaskEventSchema.parse(JSON.parse(line)).type === type);
  }

  private async appendCodeTaskEvent(active: Pick<ActiveCodeTask, "taskId" | "attemptId" | "eventsPath">, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const previous = (await readFile(active.eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).at(-1);
    const previousCursor = previous ? Number((JSON.parse(previous) as { cursor?: unknown }).cursor) : 0;
    const event = CodeTaskEventSchema.parse({
      cursor: String(Number.isSafeInteger(previousCursor) ? previousCursor + 1 : 1),
      taskId: active.taskId,
      at: new Date().toISOString(),
      type,
      message,
      metadata: { attemptId: active.attemptId, ...metadata },
    });
    await appendFile(active.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  private async prepareCustomCodeTaskRepository(
    session: ActiveSession,
    spec: CodeTaskSpec,
    taskRoot: string,
  ): Promise<PreparedCodeTaskRepositories> {
    if (spec.repositories.length !== 1) throw new HttpError(400, "Custom Code Task repository preparation supports exactly one mount");
    const mount = spec.repositories[0]!;
    const repositoryRoot = join(taskRoot, "repositories");
    const primaryRoot = resolve(await this.options.codeTaskRepositoryPreparer!(join(session.root, "repo"), spec, taskRoot));
    relativePath(repositoryRoot, primaryRoot);
    const canonical = await realpath(primaryRoot);
    relativePath(await realpath(repositoryRoot), canonical);
    return {
      primaryRoot: canonical,
      primaryMode: mount.mode,
      readOnlyRoots: [],
      readWriteRoots: [],
      mounts: [{ root: canonical, mode: mount.mode, baseSha: mount.baseSha }],
    };
  }

  private async prepareCodeTaskRepositories(session: ActiveSession, spec: CodeTaskSpec, taskRoot: string): Promise<PreparedCodeTaskRepositories> {
    const prepared: Array<{ root: string; mode: "read" | "write"; baseSha: string }> = [];
    for (const mount of spec.repositories) {
      const cloneUrl = `https://github.com/${mount.owner}/${mount.repository}.git`;
      const checkout = containedPath(join(taskRoot, "repositories"), mount.destination);
      await this.repositoryCache.createIsolatedCheckout({
        // The shared mirror is preparation-only. The resulting checkout owns
        // its Git metadata and object files and is the only repository mounted
        // into the task process namespace.
        namespace: "code-task-repository-pool-v1",
        owner: mount.owner,
        repository: mount.repository,
        cloneUrl,
      }, checkout, {
        ref: mount.baseRef,
        baseSha: mount.baseSha,
        detached: true,
        env: sandboxEnvironmentWithProxy(
          session.githubToken ? gitHubGitEnvironment(session.githubToken) : {},
          this.options.egressProxyUrl,
        ),
        timeoutMs: this.options.commandTimeoutMs,
      });
      prepared.push({ root: await realpath(checkout), mode: mount.mode, baseSha: mount.baseSha });
    }
    const primary = prepared.find(mount => mount.mode === "write") ?? prepared[0];
    if (!primary) throw new HttpError(400, "Code task has no primary repository mount");
    return {
      primaryRoot: primary.root,
      primaryMode: primary.mode,
      readOnlyRoots: prepared.filter(mount => mount.mode === "read" && mount !== primary).map(mount => mount.root),
      readWriteRoots: prepared.filter(mount => mount.mode === "write" && mount !== primary).map(mount => mount.root),
      mounts: prepared,
    };
  }

  private codeTaskWorkerEnvironment(
    session: ActiveSession,
    spec: CodeTaskSpec,
    taskRoot: string,
    executionSecrets?: Readonly<Record<string, string>>,
  ): NodeJS.ProcessEnv {
    const home = join(taskRoot, "home");
    const profile = executionProfile(spec.executionProfileId);
    const configured = this.options.codeTaskEnvAllowlist ? new Set(this.options.codeTaskEnvAllowlist) : undefined;
    const allowed = profile.allowedEnvironmentKeys.filter(key =>
      key !== "OPENAI_API_KEY" && key !== "OPENAI_BASE_URL" && (!configured || configured.has(key)));
    const environment: NodeJS.ProcessEnv = {
      PATH: session.environment.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CI: "true",
      NO_BROWSER: "1",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      QASEY_MASTRA_VERSION: "1.59.0",
      QASEY_CODE_AGENT_MODEL: process.env.QASEY_CODE_AGENT_MODEL?.trim() || "gpt-5.6-sol",
      QASEY_CODE_AGENT_MAX_STEPS: process.env.QASEY_CODE_AGENT_MAX_STEPS?.trim() || "80",
      ...(this.options.imageDigest ? { QASEY_IMAGE_DIGEST: this.options.imageDigest } : {}),
    };
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    if (spec.executionProfileId !== "web-e2e-verifier" && executionSecrets && Object.values(executionSecrets).some(Boolean)) {
      throw new HttpError(400, "Per-run E2E secrets are restricted to the verifier profile");
    }
    if (spec.executionProfileId === "web-e2e-verifier") {
      const allowedSecretKeys = new Set(["QASEY_E2E_BASE_URL", ...spec.e2eRequiredEnvironment]);
      const provided = Object.keys(executionSecrets ?? {});
      const unexpected = provided.filter(key => !allowedSecretKeys.has(key));
      if (unexpected.length > 0) throw new HttpError(400, `Unexpected E2E secret environment variables: ${unexpected.join(", ")}`);
      const missing = spec.e2eRequiredEnvironment.filter(key => !executionSecrets?.[key]?.trim());
      if (missing.length > 0) throw new HttpError(400, `Missing E2E secret environment variables: ${missing.join(", ")}`);
      if (executionSecrets?.QASEY_E2E_BASE_URL) new URL(executionSecrets.QASEY_E2E_BASE_URL);
      for (const [key, value] of Object.entries(executionSecrets ?? {})) environment[key] = value;
    }
    for (const [source, target] of Object.entries(profile.environmentAliases ?? {})) {
      const value = environment[source];
      if (value !== undefined) environment[target] = value;
    }
    return sandboxEnvironmentWithProxy(environment, this.options.egressProxyUrl);
  }

  private codeTaskWorkerCredentials(spec: CodeTaskSpec): ReturnType<typeof CodeTaskWorkerCredentialsSchema.parse> {
    const profile = executionProfile(spec.executionProfileId);
    const configured = this.options.codeTaskEnvAllowlist ? new Set(this.options.codeTaskEnvAllowlist) : undefined;
    const allows = (key: string) => profile.useAgent
      && profile.allowedEnvironmentKeys.includes(key)
      && (!configured || configured.has(key));
    return CodeTaskWorkerCredentialsSchema.parse({
      ...(allows("OPENAI_API_KEY") && process.env.OPENAI_API_KEY ? { openaiApiKey: process.env.OPENAI_API_KEY } : {}),
      ...(allows("OPENAI_BASE_URL") && process.env.OPENAI_BASE_URL ? { openaiBaseUrl: process.env.OPENAI_BASE_URL } : {}),
    });
  }

  private async finishCodeTaskProcess(session: ActiveSession, active: ActiveCodeTask, error?: Error): Promise<void> {
    if (session.activeCodeTask !== active) return;
    clearInterval(active.heartbeat);
    clearTimeout(active.hardDeadline);
    try {
      const current = await readFile(active.statePath, "utf8")
        .then(value => CodeTaskStateSchema.parse(JSON.parse(value)))
        .catch(() => undefined);
      if (!current || current.status === "running" || current.status === "queued") {
        const now = new Date().toISOString();
        const failed: CodeTaskState = {
          taskId: active.taskId,
          attemptId: active.attemptId,
          status: "failed",
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
          error: error?.message ?? "Code task worker stopped without a terminal result",
        };
        await writeCodeTaskState(active.statePath, failed);
      }
    } catch (stateError) {
      console.error(JSON.stringify({
        event: "sandbox.code_task.terminal_state_write_failed",
        taskId: active.taskId,
        attemptId: active.attemptId,
        error: stateError instanceof Error ? stateError.message : String(stateError),
      }));
    } finally {
      // A new task must never lose its guard if an old completion callback was
      // suspended on state I/O and resumed after the session changed owners.
      session.lastActivityAt = Date.now();
      await active.sandbox._destroy().catch(() => undefined);
      if (session.activeCodeTask === active) delete session.activeCodeTask;
    }
  }

  private async findCodeTaskPaths(session: ActiveSession, taskId: string): Promise<{ statePath: string; eventsPath: string } | undefined> {
    const taskDirectory = containedPath(this.codeTaskWorkspaceRoot(session.workspaceId), safeTaskSegment(taskId));
    const attempts = await readdir(taskDirectory, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(attempts.filter(entry => entry.isDirectory()).map(async attempt => {
      const statePath = join(taskDirectory, attempt.name, "control", "state.json");
      const state = await readFile(statePath, "utf8").then(value => CodeTaskStateSchema.parse(JSON.parse(value))).catch(() => undefined);
      return state ? { state, statePath, eventsPath: join(taskDirectory, attempt.name, "control", "events.ndjson") } : undefined;
    }));
    const latest = candidates.filter(candidate => candidate !== undefined)
      .sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt))[0];
    return latest ? { statePath: latest.statePath, eventsPath: latest.eventsPath } : undefined;
  }

  private async recoverInterruptedCodeTasks(root: string): Promise<void> {
    const taskDirectories = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const task of taskDirectories.filter(entry => entry.isDirectory())) {
      const attempts = await readdir(join(root, task.name), { withFileTypes: true }).catch(() => []);
      for (const attempt of attempts.filter(entry => entry.isDirectory())) {
        const statePath = join(root, task.name, attempt.name, "control", "state.json");
        const state = await readFile(statePath, "utf8").then(value => CodeTaskStateSchema.parse(JSON.parse(value))).catch(() => undefined);
        if (!state || !["queued", "running", "cancel_requested"].includes(state.status)) continue;
        await writeCodeTaskState(statePath, { ...state, status: "lost", updatedAt: new Date().toISOString(), error: "Sandbox runtime restarted during execution" });
      }
    }
  }

  private codeTaskWorkspaceRoot(workspaceId: string): string {
    return containedPath(join(this.dataRoot, "code-tasks"), workspaceId);
  }

  private async resolveSandboxArtifactPath(session: ActiveSession, uri: string): Promise<string> {
    if (!uri.startsWith("sandbox://")) throw new HttpError(400, "Code task artifact must use sandbox:// URI");
    const virtualPath = uri.slice("sandbox://".length);
    if (isCodeTaskArtifactVirtualPath(virtualPath)) {
      return this.completedCodeTaskArtifactPath(session, virtualPath);
    }
    const repositoryRoot = await realpath(join(session.root, "repo"));
    const target = containedPath(repositoryRoot, virtualPath);
    const canonical = await realpath(target).catch(() => { throw new HttpError(404, "Sandbox artifact was not found"); });
    assertRealPathContained(repositoryRoot, canonical, "Sandbox artifact escaped the session repository");
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new HttpError(400, "Sandbox artifact must be a regular file");
    return canonical;
  }

  private async completedCodeTaskArtifactPath(session: ActiveSession, virtualPath: string): Promise<string> {
    const segments = virtualPath.split("/");
    if (segments.length < 4 || segments[0] !== CODE_TASK_ARTIFACT_PREFIX
      || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
      throw new HttpError(400, "Invalid Code Task artifact path");
    }
    const [, taskSegment, attemptSegment, ...artifactSegments] = segments as [string, string, string, ...string[]];
    const attemptRoot = containedPath(this.codeTaskWorkspaceRoot(session.workspaceId), join(taskSegment, attemptSegment));
    const statePath = join(attemptRoot, "control", "state.json");
    const state = await readFile(statePath, "utf8")
      .then(value => CodeTaskStateSchema.parse(JSON.parse(value)))
      .catch(() => { throw new HttpError(404, "Code Task artifact was not found"); });
    if (safeTaskSegment(state.taskId) !== taskSegment || safeTaskSegment(state.attemptId) !== attemptSegment) {
      throw new HttpError(400, "Code Task artifact identity mismatch");
    }
    const active = session.activeCodeTask;
    if (active && active.taskId === state.taskId && active.attemptId === state.attemptId) {
      throw new HttpError(409, "Code Task artifacts are unavailable while the task is active");
    }
    if (!["succeeded", "failed", "cancelled", "lost"].includes(state.status)) {
      throw new HttpError(409, "Code Task artifacts are unavailable before terminal state");
    }
    const artifactRoot = await realpath(join(attemptRoot, "artifacts"))
      .catch(() => { throw new HttpError(404, "Code Task artifact was not found"); });
    const target = containedPath(artifactRoot, artifactSegments.join("/"));
    const canonical = await realpath(target).catch(() => { throw new HttpError(404, "Code Task artifact was not found"); });
    assertRealPathContained(artifactRoot, canonical, "Code Task artifact escaped its immutable artifact root");
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new HttpError(400, "Code Task artifact must be a regular file");
    return canonical;
  }

  private async readCompletedCodeTaskArtifact(
    session: ActiveSession,
    virtualPath: string,
    encoding?: string,
  ): Promise<{ content: string; encoding: "utf8" | "base64" }> {
    const path = await this.completedCodeTaskArtifactPath(session, virtualPath);
    const content = await readFile(path);
    if (encoding && Buffer.isEncoding(encoding)) return { content: content.toString(encoding), encoding: "utf8" };
    return { content: content.toString("base64"), encoding: "base64" };
  }

  private async browserStart(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxBrowserStartSchema.parse(raw);
    if (input.url) this.assertBrowserNavigationAllowed(input.url);
    this.assertSessionOpen(session);
    if (session.browserStartReservation) throw new HttpError(409, "Sandbox session is already starting or updating its browser");
    const reservation = {};
    session.browserStartReservation = reservation;
    try {
      if (!session.browser) {
        const browserBase = await canonicalPrivateDirectory(join(this.dataRoot, "browser"), "Sandbox browser data root");
        this.assertSessionOpen(session);
        const workspaceRoot = containedPath(browserBase, session.workspaceId);
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const canonicalWorkspaceRoot = await canonicalPrivateDirectory(workspaceRoot, "Sandbox browser workspace");
        this.assertSessionOpen(session);
        assertRealPathContained(browserBase, canonicalWorkspaceRoot, "Sandbox browser workspace escaped its data root");

        // The browser receives a fresh mount/PID namespace and a fresh writable
        // run directory. It never sees the generic shell repository, its HOME,
        // the persisted storage-state file, or another browser run directory.
        const runRoot = join(canonicalWorkspaceRoot, `run-${session.generation}-${randomUUID()}`);
        const homeRoot = join(runRoot, "home");
        const videoDir = join(runRoot, "video");
        await mkdir(runRoot, { mode: 0o700 });
        await Promise.all([
          mkdir(join(homeRoot, ".config"), { recursive: true, mode: 0o700 }),
          mkdir(join(homeRoot, ".cache"), { recursive: true, mode: 0o700 }),
          mkdir(join(homeRoot, ".local", "share"), { recursive: true, mode: 0o700 }),
          mkdir(videoDir, { mode: 0o700 }),
        ]);
        const storageStatePath = join(canonicalWorkspaceRoot, "storage-state.json");
        const storageState = await readBrowserStorageState(storageStatePath, canonicalWorkspaceRoot);
        this.assertSessionOpen(session);
        const browserEnvironment = sessionEnvironment(homeRoot, this.options.egressProxyUrl);
        const browserReadOnlyPaths = sandboxRuntimeReadOnlyPaths(this.options.codeTaskWorkerPath ?? defaultCodeTaskWorkerPath());
        const browserBwrapArgs = buildFreshDeviceBwrapArgs({
          isolation: this.options.isolation,
          workspacePath: runRoot,
          allowNetwork: true,
          readOnlyPaths: browserReadOnlyPaths,
        });
        const browserSandbox = new LocalSandbox({
          id: `qasey-browser-${session.workspaceId}-${session.generation}`,
          workingDirectory: runRoot,
          timeout: this.options.commandTimeoutMs,
          isolation: this.options.isolation,
          env: browserEnvironment,
          nativeSandbox: {
            allowNetwork: true,
            allowSystemBinaries: true,
            readOnlyPaths: browserReadOnlyPaths,
            ...(browserBwrapArgs ? { bwrapArgs: browserBwrapArgs } : {}),
          },
        });
        let browser: Browser | undefined;
        let context: BrowserContext | undefined;
        try {
          await browserSandbox._start();
          this.assertSessionOpen(session);
          const executablePath = await this.sandboxedBrowserExecutable(browserSandbox, homeRoot);
          this.assertSessionOpen(session);
          const launchOptions: Parameters<typeof chromium.launch>[0] = {
            headless: true,
            env: browserEnvironment,
            ...(executablePath ? { executablePath } : {}),
            ...(this.options.egressProxyUrl ? {
              proxy: { server: this.options.egressProxyUrl, bypass: SANDBOX_LOOPBACK_NO_PROXY },
            } : {}),
          };
          browser = this.options.headlessBrowserLauncher
            ? await this.options.headlessBrowserLauncher(launchOptions)
            : await chromium.launch(launchOptions);
          this.assertSessionOpen(session);
          context = await browser.newContext({
            viewport: { width: input.width, height: input.height },
            recordVideo: { dir: videoDir, size: { width: input.width, height: input.height } },
            serviceWorkers: "block",
            ...(storageState ? { storageState } : {}),
          });
          this.assertSessionOpen(session);
          await installSandboxBrowserRequestPolicy(context, this.browserAllowedOrigins);
          this.assertSessionOpen(session);
          const page = await context.newPage();
          this.assertSessionOpen(session);
          session.browser = {
            browser,
            context,
            page,
            sandbox: browserSandbox,
            root: canonicalWorkspaceRoot,
            runRoot,
            storageStatePath,
          };
        } catch (error) {
          await context?.close().catch(() => undefined);
          await browser?.close().catch(() => undefined);
          await browserSandbox._destroy().catch(() => undefined);
          await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }
      this.assertSessionOpen(session);
      if (input.url) await session.browser.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      this.assertSessionOpen(session);
      return await this.state(session);
    } finally {
      if (session.browserStartReservation === reservation) delete session.browserStartReservation;
    }
  }

  private async browserAction(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxBrowserActionSchema.parse(raw);
    const browser = session.browser;
    if (!browser) throw new HttpError(409, "Browser has not been started");
    switch (input.action) {
      case "navigate":
        this.assertBrowserNavigationAllowed(input.url);
        await browser.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        break;
      case "click": await browser.page.mouse.click(input.x, input.y, { button: input.button }); break;
      case "type": await browser.page.keyboard.type(input.text); break;
      case "press": await browser.page.keyboard.press(input.key); break;
      case "reload": await browser.page.reload({ waitUntil: "domcontentloaded" }); break;
      case "back": await browser.page.goBack({ waitUntil: "domcontentloaded" }); break;
      case "forward": await browser.page.goForward({ waitUntil: "domcontentloaded" }); break;
    }
    return this.state(session);
  }

  private async browserFrame(session: ActiveSession, response: ServerResponse): Promise<void> {
    const browser = session.browser;
    const page = browser?.page;
    if (!browser || !page) throw new HttpError(409, "Browser has not been started");
    const [image, title] = await Promise.all([page.screenshot({ type: "jpeg", quality: 75 }), page.title()]);
    await writePrivateFileAtomic(join(browser.root, "latest.jpg"), image);
    response.statusCode = 200;
    response.setHeader("content-type", "image/jpeg");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-qasey-browser-url", encodeURIComponent(page.url()));
    response.setHeader("x-qasey-browser-title", encodeURIComponent(title));
    response.end(image);
  }

  private async desktopStart(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxDesktopStartSchema.parse(raw);
    const host = this.requireDesktopHost();
    if (this.desktopLease && this.desktopLease.ownerSessionId !== session.sessionId) {
      throw new HttpError(423, "This sandbox replica desktop is currently leased by another session");
    }
    if (!this.desktopLease) {
      this.desktopLease = {
        ownerSessionId: session.sessionId,
        recording: false,
        applications: new Set(),
      };
    }
    if (input.recordVideo && !this.desktopLease.recording) {
      const outputDirectory = containedPath(join(this.dataRoot, "desktop"), session.workspaceId);
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      const result = await host.call("start_recording", { output_dir: outputDirectory, record_video: true }, 60_000);
      assertDesktopResult(result, "Unable to start desktop recording");
      this.desktopLease.recording = true;
    }
    if (input.application !== "none") {
      await this.launchDesktopApplication(session, input.application, input.url);
    }
    return this.state(session);
  }

  private async desktopApplication(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxDesktopApplicationSchema.parse(raw);
    this.requireDesktopLease(session);
    await this.launchDesktopApplication(session, input.application, input.url);
    return this.state(session);
  }

  private async launchDesktopApplication(
    session: ActiveSession,
    application: "browser" | "terminal" | "editor" | "files",
    url?: string,
  ): Promise<void> {
    const host = this.requireDesktopHost();
    const lease = this.requireDesktopLease(session);
    const repository = join(session.root, "repo");
    const environment = sandboxEnvironmentWithProxy({
      ...host.environment,
      ...session.environment,
    }, this.options.egressProxyUrl);
    if (application === "browser") {
      if (url) this.assertBrowserNavigationAllowed(url);
      if (!lease.browser) {
        const browser = await chromium.launch({
          headless: false,
          env: environment,
          args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${this.desktopWidth},${this.desktopHeight}`],
          ...(this.options.egressProxyUrl ? {
            proxy: { server: this.options.egressProxyUrl, bypass: SANDBOX_LOOPBACK_NO_PROXY },
          } : {}),
        });
        const context = await browser.newContext({ viewport: null, acceptDownloads: true, serviceWorkers: "block" });
        await installSandboxBrowserRequestPolicy(context, this.browserAllowedOrigins);
        const page = await context.newPage();
        lease.browser = { browser, context, page };
      }
      if (url) await lease.browser.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      lease.applications.add("browser");
      return;
    }
    const command = application === "terminal" ? "xterm" : application === "editor" ? "mousepad" : "pcmanfm";
    const args = application === "terminal"
      ? ["-geometry", "132x40", "-title", "Qasey Terminal", "-e", "bash", "-l"]
      : application === "editor" ? [repository] : [repository];
    host.launch(command, args, { cwd: repository, env: environment });
    lease.applications.add(application);
  }

  private async desktopAction(session: ActiveSession, raw: unknown): Promise<SandboxSessionState & { result?: unknown }> {
    const input = SandboxDesktopActionSchema.parse(raw);
    const host = this.requireDesktopHost();
    this.requireDesktopLease(session);
    let tool: string;
    let argumentsJson: Record<string, unknown>;
    switch (input.action) {
      case "click": tool = "click"; argumentsJson = { x: input.x, y: input.y, button: input.button, count: input.count, scope: "desktop" }; break;
      case "doubleClick": tool = "double_click"; argumentsJson = { x: input.x, y: input.y, button: input.button, scope: "desktop" }; break;
      case "rightClick": tool = "right_click"; argumentsJson = { x: input.x, y: input.y, scope: "desktop" }; break;
      case "type": tool = "type_text"; argumentsJson = { text: input.text, scope: "desktop" }; break;
      case "press": tool = "press_key"; argumentsJson = { key: input.key, ...(input.modifiers ? { modifiers: input.modifiers } : {}), scope: "desktop" }; break;
      case "hotkey": tool = "hotkey"; argumentsJson = { keys: input.keys, scope: "desktop" }; break;
      case "move": tool = "move_cursor"; argumentsJson = { x: input.x, y: input.y, scope: "desktop" }; break;
      case "scroll": tool = "scroll"; argumentsJson = { direction: input.direction, amount: input.amount, scope: "desktop", ...(input.x !== undefined ? { x: input.x } : {}), ...(input.y !== undefined ? { y: input.y } : {}) }; break;
      case "drag": tool = "drag"; argumentsJson = { from_x: input.fromX, from_y: input.fromY, to_x: input.toX, to_y: input.toY, duration_ms: input.durationMs, scope: "desktop" }; break;
      case "clipboardRead": tool = "clipboard_read"; argumentsJson = { include_text: true }; break;
      case "clipboardWrite": tool = "clipboard_write"; argumentsJson = { text: input.text }; break;
    }
    const result = await host.call(tool, argumentsJson);
    assertDesktopResult(result, `Desktop action failed: ${input.action}`);
    return { ...await this.state(session), result: desktopPublicResult(result) };
  }

  private async desktopTool(session: ActiveSession, raw: unknown): Promise<{ result: unknown; state: SandboxSessionState }> {
    const input = SandboxDesktopToolSchema.parse(raw);
    const host = this.requireDesktopHost();
    this.requireDesktopLease(session);
    assertNoDesktopFileArguments(input.arguments);
    const result = await host.call(input.tool, input.arguments);
    assertDesktopResult(result, `Cua Driver tool failed: ${input.tool}`);
    return { result: desktopPublicResult(result), state: await this.state(session) };
  }

  private async desktopFrame(session: ActiveSession, response: ServerResponse): Promise<void> {
    const host = this.requireDesktopHost();
    this.requireDesktopLease(session);
    const result = await host.call("get_desktop_state", {});
    assertDesktopResult(result, "Unable to capture desktop");
    const screenshot = result.images.find(image => image.mimeType === "image/png") ?? result.images[0];
    if (!screenshot) throw new HttpError(502, "Cua Driver did not return a desktop screenshot");
    const image = Buffer.from(screenshot.dataBase64, "base64");
    const outputDirectory = containedPath(join(this.dataRoot, "desktop"), session.workspaceId);
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(outputDirectory, "latest.png"), image, { mode: 0o600 });
    response.statusCode = 200;
    response.setHeader("content-type", screenshot.mimeType || "image/png");
    response.setHeader("cache-control", "no-store");
    response.end(image);
  }

  private requireDesktopHost(): DesktopController {
    if (!this.desktopHost) throw new HttpError(503, "Computer-use desktop is disabled or unavailable");
    return this.desktopHost;
  }

  private requireDesktopLease(session: ActiveSession): DesktopLease {
    if (!this.desktopLease || this.desktopLease.ownerSessionId !== session.sessionId) {
      throw new HttpError(409, "This session does not own the sandbox replica desktop");
    }
    return this.desktopLease;
  }

  private async releaseDesktop(session: ActiveSession): Promise<void> {
    const lease = this.desktopLease;
    if (!lease || lease.ownerSessionId !== session.sessionId) return;
    delete this.desktopLease;
    if (lease.recording) await this.desktopHost?.call("stop_recording", {}, 60_000).catch(() => undefined);
    if (lease.browser) {
      await lease.browser.context.close().catch(() => undefined);
      await lease.browser.browser.close().catch(() => undefined);
    }
    await this.desktopHost?.resetApplications().catch(() => undefined);
  }

  private async state(session: ActiveSession): Promise<SandboxSessionState> {
    const page = session.browser?.page;
    const title = page ? await page.title().catch(() => "") : undefined;
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      generation: session.generation,
      lastActivityAt: new Date(session.lastActivityAt).toISOString(),
      browser: {
        running: Boolean(page),
        ...(page ? { url: page.url() } : {}),
        ...(title ? { title } : {}),
      },
      desktop: {
        running: this.desktopLease?.ownerSessionId === session.sessionId,
        available: Boolean(this.desktopHost && (!this.desktopLease || this.desktopLease.ownerSessionId === session.sessionId)),
        ...(this.desktopHost ? {
          display: `:${this.desktopDisplay}`,
          width: this.desktopWidth,
          height: this.desktopHeight,
        } : {}),
        ...(this.desktopLease?.ownerSessionId === session.sessionId ? {
          recording: this.desktopLease.recording,
          applications: [...this.desktopLease.applications],
        } : {}),
      },
    };
  }

  private closeSession(session: ActiveSession): Promise<void> {
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    const closePromise = this.closeSessionExclusive(session);
    session.closePromise = closePromise;
    return closePromise;
  }

  private async closeSessionExclusive(session: ActiveSession): Promise<void> {
    const inFlightRequests = [...session.inFlightRequests];
    for (const request of inFlightRequests) request.controller.abort(new Error("Sandbox session is closing"));
    await Promise.allSettled(inFlightRequests.map(request => request.completion));
    const codeTask = session.activeCodeTask;
    if (codeTask) {
      clearInterval(codeTask.heartbeat);
      clearTimeout(codeTask.hardDeadline);
      if (codeTask.process.exitCode === undefined) {
        signalProcessHandle(codeTask.process, "SIGTERM");
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
        if (codeTask.process.exitCode === undefined) await codeTask.process.kill().catch(() => undefined);
      }
      await codeTask.finalization?.catch(() => undefined);
      if (session.activeCodeTask === codeTask) delete session.activeCodeTask;
      await codeTask.sandbox._destroy().catch(() => undefined);
    }
    await this.releaseDesktop(session);
    const browser = session.browser;
    delete session.browser;
    if (browser) {
      const storageState = await browser.context.storageState().catch(() => undefined);
      if (storageState) {
        await writePrivateFileAtomic(browser.storageStatePath, `${JSON.stringify(storageState)}\n`).catch(() => undefined);
      }
      await browser.context.close().catch(() => undefined);
      await browser.browser.close().catch(() => undefined);
      await browser.sandbox._destroy().catch(() => undefined);
      await rm(browser.runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await session.sandbox._destroy().catch(() => undefined);
    await session.filesystem._destroy().catch(() => undefined);
  }

  private async evictIdle(): Promise<void> {
    await this.withSessionLifecycleLock(() => this.evictIdleExclusive());
  }

  private async evictIdleExclusive(): Promise<void> {
    const cutoff = Date.now() - this.options.idleTtlMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt > cutoff) continue;
      await this.closeSession(session);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    }
    await this.deleteExpiredWorkspaces();
  }

  private async touchWorkspace(session: ActiveSession): Promise<void> {
    const marker = join(session.root, ".qasey-last-activity");
    const now = new Date();
    await writeFile(marker, now.toISOString(), { mode: 0o600 });
    await utimes(session.root, now, now);
  }

  private async deleteExpiredWorkspaces(): Promise<void> {
    const workspaceRoot = join(this.dataRoot, "workspaces");
    const activeWorkspaceIds = new Set([...this.sessions.values()].map(session => session.workspaceId));
    const cutoff = Date.now() - this.options.workspaceRetentionMs;
    const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name) || activeWorkspaceIds.has(entry.name)) continue;
      const root = containedPath(workspaceRoot, entry.name);
      const marker = join(root, ".qasey-last-activity");
      const metadata = await stat(marker).catch(() => stat(root));
      if (metadata.mtimeMs > cutoff) continue;
      await rm(root, { recursive: true, force: true });
      await rm(this.codeTaskWorkspaceRoot(entry.name), { recursive: true, force: true });
      await rm(containedPath(join(this.dataRoot, "browser"), entry.name), { recursive: true, force: true });
      await rm(containedPath(join(this.dataRoot, "desktop"), entry.name), { recursive: true, force: true });
    }
  }

  private async runReadinessCheck(): Promise<void> {
    if (this.options.isolation === "bwrap") {
      const detected = LocalSandbox.detectIsolation();
      if (!detected.available || detected.backend !== "bwrap") throw new Error(`bubblewrap unavailable: ${detected.message}`);
    }
    const root = join(this.dataRoot, ".readiness", `${process.pid}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const readinessBwrapArgs = buildFreshDeviceBwrapArgs({
      isolation: this.options.isolation,
      workspacePath: root,
      allowNetwork: false,
    });
    const sandbox = new LocalSandbox({
      workingDirectory: root,
      isolation: this.options.isolation,
      nativeSandbox: {
        allowNetwork: false,
        ...(readinessBwrapArgs ? { bwrapArgs: readinessBwrapArgs } : {}),
      },
    });
    try {
      await sandbox._start();
      const result = await executeSandboxCommand(sandbox, "sh", [
        "-c",
        this.options.isolation === "bwrap" ? SANDBOX_READINESS_PROBE : "test -w . && printf ready",
      ], { timeout: 10_000 });
      if (result.exitCode !== 0 || result.stdout !== "ready") throw new Error(`Sandbox self-test failed: ${result.stderr}`);
    } finally {
      await sandbox._destroy().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }

  private async refreshReadinessIfStale(): Promise<void> {
    if (Date.now() - this.readinessCheckedAt < SANDBOX_READINESS_RECHECK_MS) return;
    if (this.readinessCheckInFlight) return this.readinessCheckInFlight;
    const check = (async () => {
      try {
        await this.runReadinessCheck();
        this.ready = true;
        delete this.readinessError;
      } catch (error) {
        this.ready = false;
        this.readinessError = error instanceof Error ? error.message : String(error);
      } finally {
        this.readinessCheckedAt = Date.now();
      }
    })();
    this.readinessCheckInFlight = check;
    try {
      await check;
    } finally {
      if (this.readinessCheckInFlight === check) delete this.readinessCheckInFlight;
    }
  }

  private reportBackgroundFailure(event: string, error: unknown, metadata: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    this.ready = false;
    this.readinessError = message;
    this.readinessCheckedAt = Date.now();
    console.error(JSON.stringify({ event, error: message, ...metadata }));
  }

  private async startDesktopHost(): Promise<void> {
    if (!this.options.desktopEnabled) return;
    const root = join(this.dataRoot, "desktop-host");
    const home = join(root, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const host = new DesktopController({
      display: this.desktopDisplay,
      width: this.desktopWidth,
      height: this.desktopHeight,
      root,
      home,
      runtimeDirectory: join("/tmp", `qasey-desktop-${process.pid}`),
      driverWorkerPath: this.options.driverWorkerPath ?? defaultDriverWorkerPath(),
    });
    await host.start();
    this.desktopHost = host;
  }

  private async sandboxedBrowserExecutable(sandbox: LocalSandbox, launcherRoot: string): Promise<string | undefined> {
    if (this.options.isolation === "none") return undefined;
    const browserExecutable = chromium.executablePath();
    const namespaceProbe = "test -c /dev/null && test -c /dev/urandom && test -d /dev/shm"
      + " && test ! -e /dev/qasey-host-device-sentinel && test ! -e /tmp/qasey-host-sentinel";
    const wrapped = sandbox.wrapCommandForIsolation(`${namespaceProbe} && exec ${shellArgument(browserExecutable)} \"$@\"`);
    const wrapperPath = join(launcherRoot, "browser-launcher.sh");
    const command = [wrapped.command, ...wrapped.args].map(shellArgument).join(" ");
    await writePrivateFileAtomic(wrapperPath, `#!/bin/sh\nexec ${command} qasey-browser \"$@\"\n`, 0o700);
    return wrapperPath;
  }

  private get desktopDisplay(): number { return this.options.desktopDisplay ?? 99; }
  private get desktopWidth(): number { return this.options.desktopWidth ?? 1440; }
  private get desktopHeight(): number { return this.options.desktopHeight ?? 900; }
  private get browserAllowedOrigins(): readonly string[] { return this.options.browserAllowedOrigins ?? []; }

  private assertBrowserNavigationAllowed(url: string): void {
    const decision = evaluateSandboxBrowserRequestPolicy({
      url,
      resourceType: "document",
      isNavigationRequest: true,
    }, this.browserAllowedOrigins);
    if (!decision.allowed) throw new HttpError(403, `Sandbox browser request blocked: ${decision.reason}`);
  }
}

export function sandboxRuntimeOptions(env: NodeJS.ProcessEnv = process.env): SandboxRuntimeOptions {
  const production = env.NODE_ENV === "production";
  const isolation = sandboxIsolation(env.QASEY_SANDBOX_ISOLATION, production);
  const controlKey = env.QASEY_SANDBOX_CONTROL_KEY ?? "";
  assertSandboxControlKey(controlKey);
  const egressProxyUrl = sandboxEgressProxyUrl(env.QASEY_SANDBOX_EGRESS_PROXY_URL, production);
  const browserAllowedOrigins = sandboxBrowserAllowedOrigins(env.QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS, production);
  const imageDigest = sandboxImageDigest(env.QASEY_IMAGE_DIGEST, production);
  const desktopEnabled = env.QASEY_SANDBOX_DESKTOP_ENABLED?.trim().toLowerCase() === "true";
  if (production && desktopEnabled) {
    throw new Error("Production computer-use desktop requires a dedicated per-session VM or container and cannot run in the shared sandbox replica");
  }
  const maxSessions = positiveInteger(env.QASEY_SANDBOX_MAX_SESSIONS, production ? 1 : 5);
  if (production && maxSessions !== 1) {
    throw new Error("QASEY_SANDBOX_MAX_SESSIONS must be exactly 1 in production until per-session cgroup isolation is available");
  }
  return {
    dataRoot: env.QASEY_DATA_ROOT?.trim() || ".qasey/data",
    port: positiveInteger(env.QASEY_SANDBOX_PORT, 4120),
    host: env.QASEY_SANDBOX_HOST?.trim() || "0.0.0.0",
    maxSessions,
    idleTtlMs: positiveInteger(env.QASEY_SANDBOX_IDLE_TTL_MS, 30 * 60_000),
    isolation,
    controlKey,
    ...(egressProxyUrl ? { egressProxyUrl } : {}),
    browserAllowedOrigins,
    commandTimeoutMs: positiveInteger(env.QASEY_SANDBOX_COMMAND_TIMEOUT_MS, 30 * 60_000),
    workspaceRetentionMs: positiveInteger(env.QASEY_WORKSPACE_RETENTION_MS, 7 * 24 * 60 * 60_000),
    desktopEnabled,
    desktopDisplay: positiveInteger(env.QASEY_SANDBOX_DESKTOP_DISPLAY, 99),
    desktopWidth: positiveInteger(env.QASEY_SANDBOX_DESKTOP_WIDTH, 1440),
    desktopHeight: positiveInteger(env.QASEY_SANDBOX_DESKTOP_HEIGHT, 900),
    driverWorkerPath: env.QASEY_CUA_DRIVER_WORKER_PATH?.trim() || defaultDriverWorkerPath(),
    codeTaskWorkerPath: env.QASEY_CODE_TASK_WORKER_PATH?.trim() || defaultCodeTaskWorkerPath(),
    shutdownTimeoutMs: positiveInteger(env.QASEY_SANDBOX_SHUTDOWN_TIMEOUT_MS, 25_000),
    ...(imageDigest ? { imageDigest } : {}),
    ...(env.QASEY_CODE_TASK_ENV_ALLOWLIST?.trim()
      ? { codeTaskEnvAllowlist: env.QASEY_CODE_TASK_ENV_ALLOWLIST.split(",").map(value => value.trim()).filter(Boolean) }
      : {}),
  };
}

function sandboxImageDigest(value: string | undefined, production: boolean): string | undefined {
  const configured = value?.trim();
  if (!configured) {
    if (production) throw new Error("QASEY_IMAGE_DIGEST is required in production");
    return undefined;
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(configured)) {
    throw new Error("QASEY_IMAGE_DIGEST must be an immutable sha256 OCI image digest");
  }
  return configured;
}

function sandboxEgressProxyUrl(value: string | undefined, production: boolean): string | undefined {
  const configured = value?.trim();
  if (!configured) {
    if (production) throw new Error("QASEY_SANDBOX_EGRESS_PROXY_URL is required in production");
    return undefined;
  }
  return normalizeHttpOrigin(configured, "QASEY_SANDBOX_EGRESS_PROXY_URL");
}

function sandboxBrowserAllowedOrigins(value: string | undefined, production: boolean): readonly string[] {
  const configured = value?.trim();
  if (!configured) {
    if (production) throw new Error("QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS is required in production");
    return [];
  }
  const entries = configured.split(",").map(entry => entry.trim());
  if (entries.some(entry => entry.length === 0)) {
    throw new Error("QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS contains an empty origin");
  }
  return [...new Set(entries.map(entry => normalizeHttpOrigin(entry, "QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS")))];
}

function normalizeHttpOrigin(value: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variable} must contain valid HTTP or HTTPS origins`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${variable} only supports HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) throw new Error(`${variable} must not contain URL credentials`);
  const schemeSeparator = value.indexOf("://");
  const authorityAndSuffix = schemeSeparator >= 0 ? value.slice(schemeSeparator + 3) : "";
  const suffixOffset = authorityAndSuffix.search(/[/?#\\]/u);
  const suffix = suffixOffset >= 0 ? authorityAndSuffix.slice(suffixOffset) : "";
  if ((suffix !== "" && suffix !== "/") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${variable} entries must not contain a path, query, or fragment`);
  }
  return parsed.origin;
}

function sandboxEnvironmentWithProxy(
  source: NodeJS.ProcessEnv,
  egressProxyUrl: string | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !SANDBOX_PROXY_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  if (!egressProxyUrl) return environment;
  return {
    ...environment,
    HTTP_PROXY: egressProxyUrl,
    HTTPS_PROXY: egressProxyUrl,
    ALL_PROXY: egressProxyUrl,
    NO_PROXY: SANDBOX_LOOPBACK_NO_PROXY,
  };
}

async function installSandboxBrowserRequestPolicy(
  context: BrowserContext,
  allowedOrigins: readonly string[],
): Promise<void> {
  await context.route("**/*", async route => {
    const request = route.request();
    const redirectedFromUrl = request.redirectedFrom()?.url();
    const decision = evaluateSandboxBrowserRequestPolicy({
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigationRequest: request.isNavigationRequest(),
      ...(redirectedFromUrl ? { redirectedFromUrl } : {}),
    }, allowedOrigins);
    if (decision.allowed) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(() => true, async socket => {
    const decision = evaluateSandboxBrowserRequestPolicy({
      url: socket.url(),
      resourceType: "websocket",
      isNavigationRequest: false,
    }, allowedOrigins);
    if (decision.allowed) {
      socket.connectToServer();
      return;
    }
    await socket.close({ code: 1008, reason: "Sandbox browser origin policy" });
  });
}

function sandboxIsolation(value: string | undefined, production: boolean): "bwrap" | "none" {
  const isolation = value?.trim().toLowerCase() || (production ? "bwrap" : "none");
  if (production && isolation === "none") {
    throw new Error("Production sandbox isolation cannot be none");
  }
  if (isolation === "bwrap" || isolation === "none") return isolation;
  throw new Error("QASEY_SANDBOX_ISOLATION must be none or bwrap");
}

function defaultDriverWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cua-driver-worker.mjs");
}

function defaultCodeTaskWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "code-task-worker.mjs");
}

function containedPath(rootInput: string, child: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, child.replace(/^[/\\]+/u, ""));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new HttpError(400, "Path escaped sandbox workspace");
  return target;
}

function safeTaskSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^\.+$/u, "-").slice(0, 160);
  if (!segment) throw new HttpError(400, "Code task identifier contains no safe path segment");
  return segment === value ? segment : `${segment.slice(0, 140)}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch {
    try { process.kill(pid, signal); } catch { /* process already stopped */ }
  }
}

function signalProcessHandle(handle: ProcessHandle, signal: NodeJS.Signals): void {
  if (!/^\d+$/u.test(handle.pid)) throw new Error("Local sandbox process handle returned a non-numeric PID");
  killProcessGroup(Number(handle.pid), signal);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxRuntimeReadOnlyPaths(workerPath: string): string[] {
  const runtimeRoot = resolve(dirname(workerPath), "..");
  const browserRuntimeRoot = resolve(dirname(chromium.executablePath()), "..");
  const candidates = [
    dirname(workerPath),
    join(runtimeRoot, "node_modules"),
    browserRuntimeRoot,
    process.env.PLAYWRIGHT_BROWSERS_PATH,
  ];
  const existing = [...new Set(candidates.flatMap(path => path && resolve(path) !== "/" && existsSync(path) ? [resolve(path)] : []))];
  return existing.filter(path => !existing.some(parent => parent !== path && path.startsWith(`${parent}${sep}`)));
}

function decodeContent(content: string, encoding: "utf8" | "base64"): string | Buffer {
  return encoding === "utf8" ? content : Buffer.from(content, "base64");
}

function removeOptions(recursive: boolean | undefined, force: boolean | undefined): { recursive?: boolean; force?: boolean } {
  return {
    ...(recursive !== undefined ? { recursive } : {}),
    ...(force !== undefined ? { force } : {}),
  };
}

function copyOptions(recursive: boolean | undefined, overwrite: boolean | undefined): { recursive?: boolean; overwrite?: boolean } {
  return {
    ...(recursive !== undefined ? { recursive } : {}),
    ...(overwrite !== undefined ? { overwrite } : {}),
  };
}

function listOptions(recursive: boolean | undefined, extension: string | string[] | undefined, maxDepth: number | undefined): { recursive?: boolean; extension?: string | string[]; maxDepth?: number } {
  return {
    ...(recursive !== undefined ? { recursive } : {}),
    ...(extension !== undefined ? { extension } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

function executeSandboxCommand(
  sandbox: LocalSandbox,
  command: string,
  args: string[],
  options: import("@mastra/core/workspace").ExecuteCommandOptions,
) {
  const execute = sandbox.executeCommand;
  if (!execute) throw new Error("LocalSandbox command execution is unavailable");
  return execute.call(sandbox, command, args, options);
}

function hashToken(token: string): Buffer { return createHash("sha256").update(token).digest(); }
function equalToken(left: Buffer, right: Buffer): boolean { return left.byteLength === right.byteLength && timingSafeEqual(left, right); }

function assertDesktopResult(result: DesktopToolResult, message: string): void {
  if (result.isError) throw new HttpError(502, `${message}: ${result.text || result.errorCode || "unknown Cua Driver error"}`);
}

function desktopPublicResult(result: DesktopToolResult): unknown {
  let data: unknown;
  if (result.structuredJson) {
    try { data = JSON.parse(result.structuredJson) as unknown; } catch { /* use raw result */ }
  }
  if (data === undefined) {
    try { data = JSON.parse(result.rawJson) as unknown; } catch { data = undefined; }
  }
  return {
    ...(data !== undefined ? { data } : {}),
    ...(result.text ? { text: result.text } : {}),
    ...(result.images.length ? { images: result.images } : {}),
    degraded: result.degraded,
  };
}

function sessionEnvironment(home: string, egressProxyUrl: string | undefined): NodeJS.ProcessEnv {
  const playwrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  return sandboxEnvironmentWithProxy({
    PATH: `${join(home, ".local", "bin")}:${join(home, ".npm-global", "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: home,
    CI: "true",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NPM_CONFIG_PREFIX: join(home, ".npm-global"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(playwrightBrowsersPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath } : {}),
  }, egressProxyUrl);
}

function gitHubGitEnvironment(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

function sameOptionalToken(currentHash: Buffer | undefined, incoming: string | undefined): boolean {
  if (!currentHash && !incoming) return true;
  if (!currentHash || !incoming) return false;
  return equalToken(currentHash, hashToken(incoming));
}

function relativePath(rootInput: string, targetInput: string): string {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new HttpError(400, "Path escaped sandbox workspace");
  return target === root ? "." : target.slice(root.length + 1);
}

function isCodeTaskArtifactVirtualPath(path: string): boolean {
  return path === CODE_TASK_ARTIFACT_PREFIX || path.startsWith(`${CODE_TASK_ARTIFACT_PREFIX}/`);
}

function filesystemRequestPaths(input: ReturnType<typeof SandboxFilesystemRequestSchema.parse>): string[] {
  switch (input.operation) {
    case "copyFile":
    case "moveFile": return [input.source, input.destination];
    default: return [input.path];
  }
}

function assertRealPathContained(rootInput: string, targetInput: string, message: string): void {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new HttpError(400, message);
}

type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

async function canonicalPrivateDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  await chmod(path, 0o700);
  return realpath(path);
}

async function readBrowserStorageState(path: string, root: string): Promise<BrowserStorageState | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error("Sandbox browser storage state must be a private regular file");
  }
  if (metadata.size > 4 * 1024 * 1024) throw new Error("Sandbox browser storage state exceeds 4 MiB");
  const canonical = await realpath(path);
  assertRealPathContained(root, canonical, "Sandbox browser storage state escaped its workspace");
  try {
    return JSON.parse(await readFile(canonical, "utf8")) as BrowserStorageState;
  } catch {
    throw new Error("Sandbox browser storage state is not valid JSON");
  }
}

async function writePrivateFileAtomic(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertNoDesktopFileArguments(value: unknown, path = "arguments"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoDesktopFileArguments(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:^|_)(?:path|file|dir|directory)$/iu.test(key)) throw new HttpError(400, `Desktop tool file arguments are managed by Qasey: ${path}.${key}`);
    assertNoDesktopFileArguments(entry, `${path}.${key}`);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeProcessDiagnostic(value: string, maxCharacters: number): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/giu, "$1[REDACTED]")
    .replace(/\b((?:token|secret|password|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .slice(-maxCharacters);
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+([^\s]+)$/iu.exec(authorization ?? "")?.[1];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 12 * 1024 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "Request body is not valid JSON"); }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
