process.stdout.write("[mastra] Workers started\n");
process.send?.({
  type: "qasey.worker.heartbeat",
  token: process.env.QASEY_INTERNAL_WORKER_HEARTBEAT_TOKEN,
  ready: true,
});
const timer = setInterval(() => {}, 1_000);
process.once("SIGTERM", () => {
  clearInterval(timer);
  process.exitCode = 0;
});
