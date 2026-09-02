import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const endpoint = process.argv[2];
const controlKey = process.argv[3];
const baseSha = process.argv[4];
const expectedImageDigest = process.argv[5];
if (!endpoint || !controlKey || Buffer.byteLength(controlKey, "utf8") < 32
  || !/^[a-f0-9]{40,64}$/u.test(baseSha ?? "") || !/^sha256:[a-f0-9]{64}$/u.test(expectedImageDigest ?? "")) {
  throw new Error("usage: node ci/smoke-sandbox-runtime.mjs <endpoint> <32-byte-control-key> <local-smoke-base-sha> <expected-image-digest>");
}

const scope = { applicationId: "ci-smoke", tenantId: "tenant-a", sessionId: "session-a" };
const workspaceId = createHash("sha256")
  .update(scope.applicationId).update("\0")
  .update(scope.tenantId).update("\0")
  .update(scope.sessionId)
  .digest("hex");
const claim = {
  sessionId: scope.sessionId,
  workspaceId,
  generation: 1,
  token: randomBytes(32).toString("base64url"),
};
const now = Math.floor(Date.now() / 1_000);
const controlToken = signHs256({
  application_id: scope.applicationId,
  tenant_id: scope.tenantId,
  session_id: scope.sessionId,
  workspace_id: workspaceId,
  generation: claim.generation,
  claim_sha256: createHash("sha256").update(canonicalJson(claim)).digest("hex"),
  iss: "qasey-control-plane",
  aud: "qasey-sandbox-runtime",
  sub: `sandbox-session:${scope.sessionId}`,
  jti: randomUUID(),
  iat: now,
  exp: now + 30,
}, controlKey);

await expectOk("claim", fetch(`${endpoint}/v1/sessions/claim`, {
  method: "POST",
  headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
  body: JSON.stringify(claim),
}));

const sessionHeaders = {
  "content-type": "application/json",
  "x-qasey-session-token": claim.token,
  "x-qasey-lease-generation": String(claim.generation),
};
const isolationProgram = String.raw`
  const fs = require("node:fs");
  const sibling = process.argv[1];
  if (fs.existsSync("/tmp/qasey-host-sentinel")) throw new Error("host /tmp leaked into sandbox");
  if (fs.existsSync("/dev/qasey-host-device-sentinel")) throw new Error("host /dev leaked into sandbox");
  if (fs.existsSync(sibling)) throw new Error("sibling workspace leaked into sandbox");
  if (fs.existsSync("/app/package.json")) throw new Error("application root leaked into sandbox");
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environment = fs.readFileSync("/proc/" + entry + "/environ", "utf8");
      if (environment.includes("QASEY_SANDBOX_CONTROL_KEY")) throw new Error("parent credentials leaked through /proc");
    } catch (error) {
      if (error && error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  fs.writeFileSync("isolation-smoke.txt", "ok", { mode: 0o600 });
  fs.rmSync("isolation-smoke.txt");
`;
const siblingWorkspace = `/tmp/qasey-data/workspaces/${"b".repeat(64)}/repo/sibling-secret`;
const execution = await expectOk("isolated execute", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/execute`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({ command: "node", args: ["-e", isolationProgram, siblingWorkspace] }),
}));
if (execution.exitCode !== 0) throw new Error(`isolated execute failed: ${execution.stderr || execution.stdout}`);
const deviceExecution = await expectOk("generic fresh devices", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/execute`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    command: "sh",
    args: ["-c", "test -c /dev/null && test -c /dev/urandom && test -d /dev/shm && test ! -e /dev/qasey-host-device-sentinel"],
  }),
}));
if (deviceExecution.exitCode !== 0) {
  throw new Error(`generic sandbox did not receive fresh devices: ${deviceExecution.stderr || deviceExecution.stdout}`);
}

const taskContext = "CI task isolation smoke";
const taskId = "sandbox-isolation-smoke";
const inputPatch = String.raw`diff --git a/smoke/isolation.spec.js b/smoke/isolation.spec.js
new file mode 100644
--- /dev/null
+++ b/smoke/isolation.spec.js
@@ -0,0 +1 @@
+require("../isolation.spec.js");
diff --git a/smoke/playwright.config.js b/smoke/playwright.config.js
new file mode 100644
--- /dev/null
+++ b/smoke/playwright.config.js
@@ -0,0 +1,7 @@
+module.exports = {
+  testDir: "..",
+  projects: [{
+    name: "chromium",
+    use: { browserName: "chromium" },
+  }],
+};
`;
await expectOk("write frozen verification input patch", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/filesystem`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    operation: "writeFile",
    path: "smoke-input.patch",
    content: inputPatch,
    encoding: "utf8",
    recursive: true,
    overwrite: false,
  }),
}));
await expectOk("isolated code task start", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/code-tasks`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    context: taskContext,
    spec: {
      taskId,
      attemptId: "attempt-1",
      kind: "review",
      scope,
      contextRef: { id: "context", kind: "report", name: "context.txt", uri: "sandbox://context.txt" },
      contextHash: createHash("sha256").update(taskContext).digest("hex"),
      repositories: [
        { owner: "example", repository: "smoke", destination: "target", mode: "write", baseRef: "main", baseSha },
        { owner: "example", repository: "smoke", destination: "reference", mode: "read", baseRef: "main", baseSha },
      ],
      baseSha,
      executionProfileId: "web-e2e-verifier",
      allowedPaths: ["smoke"],
      fixedChecks: [{ id: "playwright" }],
      playwrightVerification: {
        strategy: "changed-project-playwright",
        projects: [{
          id: "smoke",
          root: "smoke",
          testRoot: "smoke",
          config: "smoke/playwright.config.js",
          playwrightProject: "chromium",
        }],
      },
      deadlineMs: 120_000,
      traceContext: {},
      inputPatchRef: {
        id: "smoke-input-patch",
        kind: "patch",
        name: "smoke-input.patch",
        uri: "sandbox://smoke-input.patch",
      },
    },
  }),
}));
const activeArtifactRead = await fetch(`${endpoint}/v1/sessions/${scope.sessionId}/filesystem`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    operation: "readFile",
    path: `code-task-artifacts/${taskId}/attempt-1/changes.patch`,
    encoding: "utf8",
  }),
});
if (activeArtifactRead.status !== 409) {
  throw new Error(`active Code Task artifact read returned HTTP ${activeArtifactRead.status}, expected 409`);
}
let taskState;
for (let attempt = 0; attempt < 120; attempt += 1) {
  taskState = await expectOk("isolated code task state", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/code-tasks/${taskId}`, {
    headers: sessionHeaders,
  }));
  if (["succeeded", "failed", "cancelled", "lost"].includes(taskState.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1_000));
}
if (taskState?.status !== "succeeded" || taskState.result?.changedPaths?.includes("smoke/proof.txt") !== true) {
  throw new Error(`isolated code task did not succeed: ${JSON.stringify(taskState)}`);
}
if (taskState.result?.provenance?.imageDigest !== expectedImageDigest) {
  throw new Error(`Code Task provenance did not bind the exact sandbox image: ${JSON.stringify(taskState.result?.provenance)}`);
}
const patchUri = taskState.result.patchRef?.uri;
if (typeof patchUri !== "string" || !patchUri.startsWith("sandbox://code-task-artifacts/")) {
  throw new Error(`Code Task returned an invalid protected patch URI: ${String(patchUri)}`);
}
const completedArtifact = await expectOk("completed code task artifact", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/filesystem`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({ operation: "readFile", path: patchUri.slice("sandbox://".length), encoding: "utf8" }),
}));
if (!completedArtifact.content?.includes("smoke/proof.txt")) throw new Error("completed Code Task patch was not readable through sandbox://");

await expectOk("sandboxed browser start", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/browser/start`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({ width: 800, height: 600 }),
}));
const frame = await fetch(`${endpoint}/v1/sessions/${scope.sessionId}/browser/frame`, { headers: sessionHeaders });
if (!frame.ok || !frame.headers.get("content-type")?.startsWith("image/jpeg") || (await frame.arrayBuffer()).byteLength < 100) {
  throw new Error(`sandboxed browser frame failed with HTTP ${frame.status}`);
}
const namespaceProbe = String.raw`
  const fs = require("node:fs");
  for (const path of process.argv.slice(1)) {
    if (fs.existsSync(path)) throw new Error("generic namespace can see isolated execution root: " + path);
  }
`;
const genericAfterBrowser = await expectOk("generic namespace after browser", fetch(
  `${endpoint}/v1/sessions/${scope.sessionId}/execute`,
  {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      command: "node",
      args: [
        "-e",
        namespaceProbe,
        `/tmp/qasey-data/browser/${workspaceId}`,
        `/tmp/qasey-data/code-tasks/${workspaceId}`,
      ],
    }),
  },
));
if (genericAfterBrowser.exitCode !== 0) {
  throw new Error(`generic namespace boundary failed: ${genericAfterBrowser.stderr || genericAfterBrowser.stdout}`);
}
const browserBoundaryProgram = String.raw`
  const fs = require("node:fs");
  for (const path of process.argv.slice(1)) {
    if (fs.existsSync(path)) throw new Error("separate task/browser data leaked into generic shell namespace: " + path);
  }
`;
const boundaryExecution = await expectOk("browser namespace separation", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/execute`, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    command: "node",
    args: [
      "-e",
      browserBoundaryProgram,
      `/tmp/qasey-data/browser/${workspaceId}`,
      `/tmp/qasey-data/code-tasks/${workspaceId}`,
    ],
  }),
}));
if (boundaryExecution.exitCode !== 0) {
  throw new Error(`browser namespace separation failed: ${boundaryExecution.stderr || boundaryExecution.stdout}`);
}

await expectOk("stop sandbox session", fetch(`${endpoint}/v1/sessions/${scope.sessionId}/stop`, {
  method: "POST",
  headers: sessionHeaders,
}));
const finalCapacity = await expectOk("capacity after stop", fetch(`${endpoint}/capacity`));
if (finalCapacity.active !== 0 || finalCapacity.available !== finalCapacity.maximum) {
  throw new Error(`sandbox resources were not released after stop: ${JSON.stringify(finalCapacity)}`);
}

async function expectOk(label, responsePromise) {
  const response = await responsePromise;
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function signHs256(payload, key) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", key).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
