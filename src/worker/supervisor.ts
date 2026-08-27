import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  isWorkerHeartbeatMessage,
  WORKER_HEARTBEAT_INTERVAL_ENV,
  WORKER_HEARTBEAT_TOKEN_ENV,
} from "./readiness-ipc.ts";

export interface WorkerSupervisorOptions {
  workerEntry: string;
  host: string;
  port: number;
  environment?: NodeJS.ProcessEnv;
  metricsToken?: string;
  shutdownTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface WorkerSupervisorHandle {
  port: number;
  wait(): Promise<number>;
  close(): Promise<void>;
}

const WORKER_READY_MARKER = "[mastra] Workers started";

/**
 * Keeps orchestration Worker probes independent from the API process. The
 * supervisor never restarts a failed child: the workload orchestrator owns the
 * restart policy and receives the original exit status.
 */
export class WorkerSupervisor {
  private child?: ChildProcess;
  private server?: Server;
  private workerStarted = false;
  private workerReportedReady = false;
  private lastHeartbeatAt?: number;
  private stopping = false;
  private readonly startedAtSeconds = Math.floor(Date.now() / 1_000);
  private exitPromise?: Promise<number>;

  constructor(private readonly options: WorkerSupervisorOptions) {}

  async start(): Promise<WorkerSupervisorHandle> {
    if (this.child || this.server) throw new Error("Worker supervisor has already started");
    this.server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const path = new URL(request.url ?? "/", "http://worker.invalid").pathname;
      if (path === "/healthz") {
        const alive = this.child !== undefined && this.child.exitCode === null && !this.stopping;
        response.writeHead(alive ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: alive ? "ok" : "stopping" }));
        return;
      }
      if (path === "/readyz") {
        const ready = this.isReady();
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: ready ? "ready" : "not_ready" }));
        return;
      }
      if (path === "/metrics") {
        if (!authorized(request.headers.authorization, this.options.metricsToken)) {
          response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(this.metrics());
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port, this.options.host, () => {
        this.server!.off("error", reject);
        resolveStart();
      });
    });

    const heartbeatToken = randomBytes(32).toString("base64url");
    const heartbeatTimeoutMs = this.options.heartbeatTimeoutMs ?? 15_000;
    const child = spawn(process.execPath, [this.options.workerEntry], {
      env: {
        ...(this.options.environment ?? process.env),
        [WORKER_HEARTBEAT_TOKEN_ENV]: heartbeatToken,
        [WORKER_HEARTBEAT_INTERVAL_ENV]: String(Math.max(50, Math.floor(heartbeatTimeoutMs / 3))),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      this.options.stdout?.write(text);
      stdoutBuffer = `${stdoutBuffer}${text}`.slice(-4_096);
      if (stdoutBuffer.includes(WORKER_READY_MARKER)) this.workerStarted = true;
    });
    child.on("message", message => {
      if (!isWorkerHeartbeatMessage(message, heartbeatToken)) return;
      this.workerReportedReady = message.ready;
      this.lastHeartbeatAt = Date.now();
    });
    child.once("disconnect", () => {
      this.workerReportedReady = false;
      delete this.lastHeartbeatAt;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => this.options.stderr?.write(String(chunk)));
    this.exitPromise = new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.workerReportedReady = false;
        delete this.lastHeartbeatAt;
        resolveExit(code ?? (signal ? 1 : 0));
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Worker supervisor did not bind a TCP port");
    return {
      port: address.port,
      wait: () => this.exitPromise!,
      close: () => this.close(),
    };
  }

  async close(): Promise<void> {
    if (this.stopping) return this.exitPromise?.then(() => undefined);
    this.stopping = true;
    this.workerReportedReady = false;
    const child = this.child;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (child && this.exitPromise) {
      const timeoutMs = this.options.shutdownTimeoutMs ?? 30_000;
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        this.exitPromise,
        new Promise<void>(resolveTimeout => {
          timeout = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolveTimeout();
          }, timeoutMs);
          timeout.unref();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    if (this.server) {
      await new Promise<void>((resolveClose, reject) => {
        this.server!.close(error => error ? reject(error) : resolveClose());
      });
    }
  }

  private metrics(): string {
    const labels = metricLabels(this.options.environment ?? process.env);
    const alive = this.child !== undefined && this.child.exitCode === null && !this.stopping ? 1 : 0;
    return [
      "# HELP qasey_worker_process_up Whether the supervised Mastra Worker process is running.",
      "# TYPE qasey_worker_process_up gauge",
      `qasey_worker_process_up${labels} ${alive}`,
      "# HELP qasey_worker_ready Whether the Mastra Worker has a fresh application heartbeat and accepts orchestration work.",
      "# TYPE qasey_worker_ready gauge",
      `qasey_worker_ready${labels} ${this.isReady() ? 1 : 0}`,
      "# HELP qasey_worker_supervisor_start_time_seconds Worker supervisor start time in Unix seconds.",
      "# TYPE qasey_worker_supervisor_start_time_seconds gauge",
      `qasey_worker_supervisor_start_time_seconds${labels} ${this.startedAtSeconds}`,
      "",
    ].join("\n");
  }

  private isReady(): boolean {
    if (this.stopping || !this.workerStarted || !this.workerReportedReady || this.lastHeartbeatAt === undefined) return false;
    return Date.now() - this.lastHeartbeatAt <= (this.options.heartbeatTimeoutMs ?? 15_000);
  }
}

export function workerSupervisorOptions(
  workerEntry: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerSupervisorOptions {
  const production = env.NODE_ENV === "production";
  const metricsToken = env.QASEY_WORKER_METRICS_TOKEN?.trim();
  if (production && (!metricsToken || Buffer.byteLength(metricsToken, "utf8") < 32)) {
    throw new Error("QASEY_WORKER_METRICS_TOKEN with at least 32 bytes is required in production");
  }
  if (metricsToken && [env.WORKER_TOKEN, env.PLATFORM_SERVICE_TOKEN].some(token => token && token === metricsToken)) {
    throw new Error("QASEY_WORKER_METRICS_TOKEN must be distinct from Worker and platform service credentials");
  }
  return {
    workerEntry,
    host: env.QASEY_WORKER_HEALTH_HOST?.trim() || "0.0.0.0",
    port: positivePort(env.QASEY_WORKER_HEALTH_PORT, 8081),
    environment: env,
    ...(metricsToken ? { metricsToken } : {}),
    shutdownTimeoutMs: positiveInteger(env.QASEY_WORKER_SHUTDOWN_TIMEOUT_MS, 30_000),
    heartbeatTimeoutMs: boundedInteger(env.QASEY_WORKER_HEARTBEAT_TIMEOUT_MS, 15_000, 3_000, 300_000),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}

function metricLabels(env: NodeJS.ProcessEnv): string {
  const instance = escapeMetricLabel(env.QASEY_INSTANCE_ID?.trim() || "unknown");
  const version = escapeMetricLabel(env.DD_VERSION?.trim() || env.QASEY_IMAGE_DIGEST?.trim() || "unknown");
  return `{instance="${instance}",role="worker",version="${version}"}`;
}

function escapeMetricLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"').slice(0, 256);
}

function positivePort(value: string | undefined, fallback: number): number {
  const port = positiveInteger(value, fallback);
  if (port > 65_535) throw new Error("QASEY_WORKER_HEALTH_PORT must be a valid TCP port");
  return port;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Worker supervisor numeric settings must be positive integers");
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = positiveInteger(value, fallback);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Worker supervisor numeric setting must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
