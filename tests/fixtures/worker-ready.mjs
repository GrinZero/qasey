process.stdout.write("[mastra] Workers started\n");
const token = process.env.QASEY_INTERNAL_WORKER_HEARTBEAT_TOKEN;
const intervalMs = Number(process.env.QASEY_INTERNAL_WORKER_HEARTBEAT_INTERVAL_MS ?? 5_000);
const heartbeat = () => process.send?.({ type: "qasey.worker.heartbeat", token, ready: true });
heartbeat();
const timer = setInterval(heartbeat, intervalMs);
process.once("SIGTERM", () => {
  clearInterval(timer);
  process.send?.({ type: "qasey.worker.heartbeat", token, ready: false });
  process.exitCode = 0;
});
