import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalFilesystem, LocalSandbox } from "@mastra/core/workspace";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  SandboxBrowserActionSchema, SandboxBrowserStartSchema, SandboxExecuteRequestSchema,
  SandboxDesktopActionSchema, SandboxDesktopApplicationSchema, SandboxDesktopStartSchema,
  SandboxDesktopToolSchema, SandboxFilesystemRequestSchema, SandboxRepositoryCloneSchema, SandboxSessionClaimSchema,
} from "../platform/workspace/sandbox-protocol.ts";
import type { SandboxSessionState } from "../platform/workspace/sandbox-protocol.ts";
import { DesktopController, type DesktopToolResult } from "./desktop.ts";
import { SharedRepositoryCache } from "../../packages/e2e/src/repository-cache.ts";

interface SandboxRuntimeOptions {
  dataRoot: string;
  port: number;
  host?: string;
  maxSessions: number;
  idleTtlMs: number;
  isolation: "bwrap" | "none";
  commandTimeoutMs: number;
  workspaceRetentionMs: number;
  desktopEnabled?: boolean;
  desktopDisplay?: number;
  desktopWidth?: number;
  desktopHeight?: number;
  driverWorkerPath?: string;
}

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  storageStatePath: string;
}

interface ActiveSession {
  sessionId: string;
  workspaceId: string;
  generation: number;
  tokenHash: Buffer;
  repositoryTokenHash: Buffer;
  repositoryCacheNamespace: string;
  environment: NodeJS.ProcessEnv;
  githubToken?: string;
  githubTokenHash?: Buffer;
  root: string;
  filesystem: LocalFilesystem;
  sandbox: LocalSandbox;
  browser?: BrowserSession;
  lastActivityAt: number;
}

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
  private gcTimer?: NodeJS.Timeout;
  private readonly dataRoot: string;
  private readonly repositoryCache: SharedRepositoryCache;
  private boundPort?: number;
  private desktopHost?: DesktopController;
  private desktopLease?: DesktopLease;

  constructor(private readonly options: SandboxRuntimeOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.repositoryCache = new SharedRepositoryCache(join(this.dataRoot, "git-cache"));
  }

  async start(): Promise<{ port: number; close(): Promise<void> }> {
    await mkdir(join(this.dataRoot, "workspaces"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "browser"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "desktop"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataRoot, "git-cache"), { recursive: true, mode: 0o700 });
    try {
      await this.startDesktopHost();
      await this.runReadinessCheck();
      this.ready = true;
    } catch (error) {
      this.readinessError = error instanceof Error ? error.message : String(error);
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
    this.gcTimer = setInterval(() => { void this.evictIdle(); }, Math.min(60_000, Math.max(5_000, this.options.idleTtlMs / 2)));
    this.gcTimer.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Sandbox runtime did not bind a TCP port");
    this.boundPort = (address as AddressInfo).port;
    return {
      port: this.boundPort,
      close: async () => {
        this.ready = false;
        if (this.gcTimer) clearInterval(this.gcTimer);
        await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
        await Promise.allSettled([...this.sessions.values()].map(session => this.closeSession(session)));
        this.sessions.clear();
        await this.desktopHost?.close().catch(() => undefined);
        delete this.desktopHost;
      },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://sandbox.internal");
    if (method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (method === "GET" && url.pathname === "/readyz") {
      return sendJson(response, this.ready ? 200 : 503, {
        status: this.ready ? "ready" : "not_ready",
        isolation: this.options.isolation,
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
      const claim = SandboxSessionClaimSchema.parse(await readJson(request));
      const state = await this.claim(claim);
      return sendJson(response, 200, state);
    }
    const repositoryMatch = /^\/v1\/sessions\/([^/]+)\/repositories\/clone$/u.exec(url.pathname);
    if (method === "POST" && repositoryMatch) {
      const sessionId = decodeURIComponent(repositoryMatch[1] ?? "");
      const session = this.authenticateRepository(request, sessionId);
      session.lastActivityAt = Date.now();
      await this.touchWorkspace(session);
      return sendJson(response, 200, await this.cloneRepository(session, await readJson(request)));
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(filesystem|execute|stop|browser\/start|browser\/action|browser\/frame|desktop\/start|desktop\/action|desktop\/tool|desktop\/app|desktop\/frame|desktop\/stop)$/u.exec(url.pathname);
    if (!match) throw new HttpError(404, "Route not found");
    const sessionId = decodeURIComponent(match[1] ?? "");
    const operation = match[2] ?? "";
    const session = this.authenticate(request, sessionId);
    session.lastActivityAt = Date.now();
    await this.touchWorkspace(session);
    if (method === "POST" && operation === "filesystem") return sendJson(response, 200, await this.filesystem(session, await readJson(request)));
    if (method === "POST" && operation === "execute") return sendJson(response, 200, await this.execute(session, await readJson(request)));
    if (method === "POST" && operation === "stop") {
      await this.closeSession(session);
      this.sessions.delete(session.sessionId);
      return sendJson(response, 200, { stopped: true });
    }
    if (method === "POST" && operation === "browser/start") return sendJson(response, 200, await this.browserStart(session, await readJson(request)));
    if (method === "POST" && operation === "browser/action") return sendJson(response, 200, await this.browserAction(session, await readJson(request)));
    if (method === "GET" && operation === "browser/frame") return this.browserFrame(session, response);
    if (method === "POST" && operation === "desktop/start") return sendJson(response, 200, await this.desktopStart(session, await readJson(request)));
    if (method === "POST" && operation === "desktop/action") return sendJson(response, 200, await this.desktopAction(session, await readJson(request)));
    if (method === "POST" && operation === "desktop/tool") return sendJson(response, 200, await this.desktopTool(session, await readJson(request)));
    if (method === "POST" && operation === "desktop/app") return sendJson(response, 200, await this.desktopApplication(session, await readJson(request)));
    if (method === "GET" && operation === "desktop/frame") return this.desktopFrame(session, response);
    if (method === "POST" && operation === "desktop/stop") {
      await this.releaseDesktop(session);
      return sendJson(response, 200, await this.state(session));
    }
    throw new HttpError(405, "Method not allowed");
  }

  private async claim(input: ReturnType<typeof SandboxSessionClaimSchema.parse>): Promise<SandboxSessionState> {
    const current = this.sessions.get(input.sessionId);
    const incomingHash = hashToken(input.token);
    if (current && current.generation === input.generation && equalToken(current.tokenHash, incomingHash)) {
      if (sameOptionalToken(current.githubTokenHash, input.githubToken)) {
        current.lastActivityAt = Date.now();
        return this.state(current);
      }
      await this.closeSession(current);
    } else {
      if (current && input.generation <= current.generation) throw new HttpError(409, "Stale sandbox lease generation");
      if (current) await this.closeSession(current);
    }
    if (!current && this.sessions.size >= this.options.maxSessions) throw new HttpError(429, "Sandbox Pod is at capacity");
    const root = containedPath(join(this.dataRoot, "workspaces"), input.workspaceId);
    const home = join(root, "home");
    const repository = join(root, "repo");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(repository, { recursive: true, mode: 0o700 }),
    ]);
    const filesystem = new LocalFilesystem({ basePath: repository, contained: true });
    await filesystem.init();
    const repositoryToken = randomBytes(32).toString("base64url");
    const environment = sessionEnvironment(home, {
      brokerUrl: `http://127.0.0.1:${this.boundPort ?? this.options.port}/v1/sessions/${encodeURIComponent(input.sessionId)}/repositories/clone`,
      brokerToken: repositoryToken,
      ...(input.githubToken ? { githubToken: input.githubToken } : {}),
    });
    const sandbox = new LocalSandbox({
      id: `qasey-${input.workspaceId}`,
      workingDirectory: repository,
      timeout: this.options.commandTimeoutMs,
      isolation: this.options.isolation,
      env: environment,
      nativeSandbox: { allowNetwork: true, allowSystemBinaries: true },
    });
    await sandbox.start();
    const session: ActiveSession = {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      generation: input.generation,
      tokenHash: incomingHash,
      repositoryTokenHash: hashToken(repositoryToken),
      repositoryCacheNamespace: input.repositoryCacheNamespace ?? input.workspaceId,
      environment,
      ...(input.githubToken ? { githubToken: input.githubToken, githubTokenHash: hashToken(input.githubToken) } : {}),
      root,
      filesystem,
      sandbox,
      lastActivityAt: Date.now(),
    };
    this.sessions.set(input.sessionId, session);
    await this.touchWorkspace(session);
    return this.state(session);
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

  private authenticateRepository(request: IncomingMessage, sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "Sandbox session not found");
    const token = request.headers["x-qasey-repository-token"];
    if (typeof token !== "string" || !equalToken(session.repositoryTokenHash, hashToken(token))) {
      throw new HttpError(401, "Invalid repository broker credential");
    }
    return session;
  }

  private async cloneRepository(session: ActiveSession, raw: unknown): Promise<unknown> {
    const input = SandboxRepositoryCloneSchema.parse(raw);
    const [owner, repository] = input.repository.split("/") as [string, string];
    const destination = containedPath(join(session.root, "repo"), input.destination);
    const cloneUrl = `https://github.com/${owner}/${repository}.git`;
    const env = session.githubToken ? gitHubGitEnvironment(session.githubToken) : undefined;
    const result = await this.repositoryCache.materialize({
      namespace: session.repositoryCacheNamespace,
      owner,
      repository,
      cloneUrl,
    }, destination, {
      bare: input.bare,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(env ? { env } : {}),
      timeoutMs: this.options.commandTimeoutMs,
    });
    return {
      destination: relativePath(join(session.root, "repo"), result.destination),
      cacheHit: result.cacheHit,
      ...(result.resolvedSha ? { resolvedSha: result.resolvedSha } : {}),
    };
  }

  private async filesystem(session: ActiveSession, raw: unknown): Promise<unknown> {
    const input = SandboxFilesystemRequestSchema.parse(raw);
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

  private async execute(session: ActiveSession, raw: unknown): Promise<unknown> {
    const input = SandboxExecuteRequestSchema.parse(raw);
    const cwd = input.cwd ? containedPath(join(session.root, "repo"), input.cwd) : join(session.root, "repo");
    return executeSandboxCommand(session.sandbox, input.command, input.args, {
      cwd,
      ...(input.env ? { env: input.env } : {}),
      timeout: input.timeout ?? this.options.commandTimeoutMs,
      maxRetainedBytes: input.maxRetainedBytes ?? 1024 * 1024,
    });
  }

  private async browserStart(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxBrowserStartSchema.parse(raw);
    if (!session.browser) {
      const videoDir = containedPath(join(this.dataRoot, "browser"), session.workspaceId);
      await mkdir(videoDir, { recursive: true, mode: 0o700 });
      const storageStatePath = join(videoDir, "storage-state.json");
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: input.width, height: input.height },
        recordVideo: { dir: videoDir, size: { width: input.width, height: input.height } },
        ...(await fileExists(storageStatePath) ? { storageState: storageStatePath } : {}),
      });
      const page = await context.newPage();
      session.browser = { browser, context, page, storageStatePath };
    }
    if (input.url) await session.browser.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return this.state(session);
  }

  private async browserAction(session: ActiveSession, raw: unknown): Promise<SandboxSessionState> {
    const input = SandboxBrowserActionSchema.parse(raw);
    const browser = session.browser;
    if (!browser) throw new HttpError(409, "Browser has not been started");
    switch (input.action) {
      case "navigate": await browser.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 }); break;
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
    const page = session.browser?.page;
    if (!page) throw new HttpError(409, "Browser has not been started");
    const [image, title] = await Promise.all([page.screenshot({ type: "jpeg", quality: 75 }), page.title()]);
    await writeFile(containedPath(join(this.dataRoot, "browser", session.workspaceId), "latest.jpg"), image, { mode: 0o600 });
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
      throw new HttpError(423, "This sandbox Pod desktop is currently leased by another session");
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
    const environment = {
      ...host.environment,
      ...session.environment,
    };
    if (application === "browser") {
      if (!lease.browser) {
        const browser = await chromium.launch({
          headless: false,
          env: environment,
          args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${this.desktopWidth},${this.desktopHeight}`],
        });
        const context = await browser.newContext({ viewport: null, acceptDownloads: true });
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
      throw new HttpError(409, "This session does not own the sandbox Pod desktop");
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

  private async closeSession(session: ActiveSession): Promise<void> {
    await this.releaseDesktop(session);
    const browser = session.browser;
    delete session.browser;
    if (browser) {
      await browser.context.storageState({ path: browser.storageStatePath }).catch(() => undefined);
      await browser.context.close().catch(() => undefined);
      await browser.browser.close().catch(() => undefined);
    }
    await session.sandbox.destroy().catch(() => undefined);
    await session.filesystem.destroy().catch(() => undefined);
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - this.options.idleTtlMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt > cutoff) continue;
      this.sessions.delete(sessionId);
      await this.closeSession(session);
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
    }
  }

  private async runReadinessCheck(): Promise<void> {
    if (this.options.isolation === "bwrap") {
      const detected = LocalSandbox.detectIsolation();
      if (!detected.available || detected.backend !== "bwrap") throw new Error(`bubblewrap unavailable: ${detected.message}`);
    }
    const root = join(this.dataRoot, ".readiness", `${process.pid}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sandbox = new LocalSandbox({ workingDirectory: root, isolation: this.options.isolation, nativeSandbox: { allowNetwork: false } });
    try {
      await sandbox.start();
      const result = await executeSandboxCommand(sandbox, "sh", ["-c", "test -w . && printf ready"], { timeout: 10_000 });
      if (result.exitCode !== 0 || result.stdout !== "ready") throw new Error(`Sandbox self-test failed: ${result.stderr}`);
    } finally {
      await sandbox.destroy().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
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

  private get desktopDisplay(): number { return this.options.desktopDisplay ?? 99; }
  private get desktopWidth(): number { return this.options.desktopWidth ?? 1440; }
  private get desktopHeight(): number { return this.options.desktopHeight ?? 900; }
}

export function sandboxRuntimeOptions(env: NodeJS.ProcessEnv = process.env): SandboxRuntimeOptions {
  // Temporary cloud validation: run directly in the sandbox Pod until the
  // Kubernetes nodes support the user namespaces required by bubblewrap.
  const isolation = "none" as const;
  return {
    dataRoot: env.QASEY_DATA_ROOT?.trim() || ".qasey/data",
    port: positiveInteger(env.QASEY_SANDBOX_PORT, 4120),
    host: env.QASEY_SANDBOX_HOST?.trim() || "0.0.0.0",
    maxSessions: positiveInteger(env.QASEY_SANDBOX_MAX_SESSIONS, 5),
    idleTtlMs: positiveInteger(env.QASEY_SANDBOX_IDLE_TTL_MS, 30 * 60_000),
    isolation,
    commandTimeoutMs: positiveInteger(env.QASEY_SANDBOX_COMMAND_TIMEOUT_MS, 30 * 60_000),
    workspaceRetentionMs: positiveInteger(env.QASEY_WORKSPACE_RETENTION_MS, 7 * 24 * 60 * 60_000),
    desktopEnabled: env.QASEY_SANDBOX_DESKTOP_ENABLED?.trim().toLowerCase() === "true",
    desktopDisplay: positiveInteger(env.QASEY_SANDBOX_DESKTOP_DISPLAY, 99),
    desktopWidth: positiveInteger(env.QASEY_SANDBOX_DESKTOP_WIDTH, 1440),
    desktopHeight: positiveInteger(env.QASEY_SANDBOX_DESKTOP_HEIGHT, 900),
    driverWorkerPath: env.QASEY_CUA_DRIVER_WORKER_PATH?.trim() || defaultDriverWorkerPath(),
  };
}

function defaultDriverWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cua-driver-worker.mjs");
}

function containedPath(rootInput: string, child: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, child.replace(/^[/\\]+/u, ""));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new HttpError(400, "Path escaped sandbox workspace");
  return target;
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

function sessionEnvironment(home: string, repository: {
  brokerUrl: string;
  brokerToken: string;
  githubToken?: string;
}): NodeJS.ProcessEnv {
  const playwrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  return {
    PATH: `${join(home, ".local", "bin")}:${join(home, ".npm-global", "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: home,
    CI: "true",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NPM_CONFIG_PREFIX: join(home, ".npm-global"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    QASEY_GH_BROKER_URL: repository.brokerUrl,
    QASEY_GH_BROKER_TOKEN: repository.brokerToken,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(playwrightBrowsersPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath } : {}),
    ...(repository.githubToken ? {
      GH_TOKEN: repository.githubToken,
      GITHUB_TOKEN: repository.githubToken,
      ...gitHubGitEnvironment(repository.githubToken),
    } : {}),
  };
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

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
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
