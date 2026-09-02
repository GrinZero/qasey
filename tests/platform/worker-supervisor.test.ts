import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerSupervisor, workerSupervisorOptions } from "../../src/worker/supervisor.ts";
import {
  startWorkerSupervisorHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_ENV,
  WORKER_HEARTBEAT_TOKEN_ENV,
  type WorkerHeartbeatMessage,
} from "../../src/worker/readiness-ipc.ts";

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map(close => close()));
});

describe("WorkerSupervisor", () => {
  it("publishes dependency-aware child readiness and a final not-ready signal", async () => {
    const messages: WorkerHeartbeatMessage[] = [];
    let dependencyReady = false;
    const target = {
      connected: true,
      send: (message: WorkerHeartbeatMessage, callback?: () => void) => {
        messages.push(message);
        callback?.();
        return true;
      },
    } as unknown as Pick<NodeJS.Process, "connected" | "send">;
    const handle = startWorkerSupervisorHeartbeat(
      async () => ({ ready: dependencyReady }),
      {
        [WORKER_HEARTBEAT_TOKEN_ENV]: "private-ipc-token",
        [WORKER_HEARTBEAT_INTERVAL_ENV]: "20",
      },
      target,
    );
    expect(handle).toBeDefined();
    await waitUntil(async () => messages.some(message => message.ready === false));
    dependencyReady = true;
    await waitUntil(async () => messages.some(message => message.ready === true));
    await handle!.close();
    expect(messages.at(-1)).toMatchObject({
      type: "qasey.worker.heartbeat",
      token: "private-ipc-token",
      ready: false,
    });
  });

  it("fails closed when production metrics authentication is absent or weak", () => {
    expect(() => workerSupervisorOptions("worker.mjs", { NODE_ENV: "production" })).toThrow(/METRICS_TOKEN/u);
    expect(() => workerSupervisorOptions("worker.mjs", {
      NODE_ENV: "production",
      QASEY_WORKER_METRICS_TOKEN: "too-short",
    })).toThrow(/32 bytes/u);
    expect(() => workerSupervisorOptions("worker.mjs", {
      NODE_ENV: "production",
      WORKER_TOKEN: "shared-token-value-with-more-than-32-bytes",
      QASEY_WORKER_METRICS_TOKEN: "shared-token-value-with-more-than-32-bytes",
    })).toThrow(/distinct/u);
  });

  it("publishes readiness and authenticated bounded metrics for the Worker process", async () => {
    const metricsToken = "synthetic-worker-metrics-token-over-32-bytes";
    const supervisor = new WorkerSupervisor({
      workerEntry: resolve("tests/fixtures/worker-ready.mjs"),
      host: "127.0.0.1",
      port: 0,
      metricsToken,
      environment: {
        QASEY_INSTANCE_ID: 'worker-a"unsafe',
        DD_VERSION: "sha256:synthetic-release",
      },
      shutdownTimeoutMs: 2_000,
    });
    const handle = await supervisor.start();
    running.push(() => handle.close());
    const endpoint = `http://127.0.0.1:${handle.port}`;
    await waitUntil(async () => (await fetch(`${endpoint}/readyz`)).status === 200);
    await expect(fetch(`${endpoint}/healthz`).then(response => response.status)).resolves.toBe(200);
    await expect(fetch(`${endpoint}/metrics`).then(response => response.status)).resolves.toBe(401);
    const metrics = await fetch(`${endpoint}/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    }).then(response => response.text());
    expect(metrics).toContain("qasey_worker_process_up");
    expect(metrics).toContain("qasey_worker_ready");
    expect(metrics).toContain('instance="worker-a\\"unsafe"');
    expect(metrics).not.toContain("synthetic-worker-metrics-token");
  });

  it("withdraws readiness when a live Worker stops publishing fresh heartbeats", async () => {
    const supervisor = new WorkerSupervisor({
      workerEntry: resolve("tests/fixtures/worker-stale.mjs"),
      host: "127.0.0.1",
      port: 0,
      heartbeatTimeoutMs: 1_000,
      shutdownTimeoutMs: 2_000,
    });
    const handle = await supervisor.start();
    running.push(() => handle.close());
    const endpoint = `http://127.0.0.1:${handle.port}`;
    await waitUntil(async () => (await fetch(`${endpoint}/readyz`)).status === 200);

    await waitUntil(async () => (await fetch(`${endpoint}/readyz`)).status === 503, 3_000);
    await expect(fetch(`${endpoint}/healthz`).then(response => response.status)).resolves.toBe(200);
    const metrics = await fetch(`${endpoint}/metrics`).then(response => response.text());
    expect(metrics).toContain("qasey_worker_process_up");
    expect(metrics).toMatch(/qasey_worker_ready\{[^\n]+\} 0/u);
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Worker readiness");
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
}
