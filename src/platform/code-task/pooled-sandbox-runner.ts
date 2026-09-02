import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ArtifactRef, CodeTaskSpec } from "../../../packages/contracts/src/index.ts";
import type {
  CodeTaskRunner,
  CodeTaskRunnerProvider,
  CodeTaskSecrets,
  TaskHandle,
} from "../../../packages/code-task/src/index.ts";
import type { SandboxLeaseScope } from "../workspace/sandbox-protocol.ts";
import { SandboxPoolClient, type SandboxRuntimeSession } from "../workspace/sandbox-client.ts";

export type CodeTaskContextResolver = (ref: ArtifactRef) => Promise<string>;
export type CodeTaskArtifactResolver = (ref: ArtifactRef) => Promise<Buffer>;

export class PooledSandboxCodeTaskRunnerProvider implements CodeTaskRunnerProvider {
  constructor(
    private readonly pool: SandboxPoolClient,
    private readonly resolveContext: CodeTaskContextResolver = defaultContextResolver,
    private readonly resolveArtifact: CodeTaskArtifactResolver = defaultArtifactResolver,
  ) {}

  async forScope(scope: SandboxLeaseScope): Promise<CodeTaskRunner> {
    const session = await this.pool.session(scope);
    await session.claim();
    return new BoundPooledSandboxCodeTaskRunner(session, scope, this.resolveContext, this.resolveArtifact);
  }
}

class BoundPooledSandboxCodeTaskRunner implements CodeTaskRunner {
  constructor(
    private readonly session: SandboxRuntimeSession,
    private readonly scope: SandboxLeaseScope,
    private readonly resolveContext: CodeTaskContextResolver,
    private readonly resolveArtifact: CodeTaskArtifactResolver,
  ) {}

  async submit(spec: CodeTaskSpec, secrets?: CodeTaskSecrets): Promise<TaskHandle> {
    if (spec.scope.applicationId !== this.scope.applicationId
      || spec.scope.tenantId !== this.scope.tenantId
      || spec.scope.sessionId !== this.scope.sessionId) {
      throw new Error("Code task spec scope does not match its bound Sandbox runner");
    }
    const context = await this.resolveContext(spec.contextRef);
    let submitted = spec;
    if (spec.inputPatchRef && !spec.inputPatchRef.uri.startsWith("sandbox://")) {
      const content = await this.resolveArtifact(spec.inputPatchRef);
      assertArtifactIntegrity(spec.inputPatchRef, content);
      const path = `code-task-inputs/${encodeURIComponent(spec.taskId)}-${encodeURIComponent(spec.attemptId)}.patch`;
      await this.session.filesystem({ operation: "writeFile", path, content: content.toString("base64"), encoding: "base64", recursive: true, overwrite: false });
      submitted = { ...spec, inputPatchRef: { ...spec.inputPatchRef, uri: `sandbox://${path}` } };
    }
    const state = await this.session.codeTaskStart(submitted, context, secrets);
    return { taskId: state.taskId, attemptId: state.attemptId, status: state.status };
  }

  get(taskId: string) { return this.session.codeTaskState(taskId); }
  events(taskId: string, after?: string) { return this.session.codeTaskEvents(taskId, after); }
  async cancel(taskId: string, reason: string): Promise<void> { await this.session.codeTaskCancel(taskId, reason); }

  async artifact(ref: ArtifactRef): Promise<Buffer> {
    if (!ref.uri.startsWith("sandbox://")) throw new Error(`Unsupported CodeTask artifact URI: ${ref.uri}`);
    const result = await this.session.filesystem<{ content: string; encoding: "utf8" | "base64" }>({
      operation: "readFile",
      path: ref.uri.slice("sandbox://".length),
    });
    const content = result.encoding === "base64" ? Buffer.from(result.content, "base64") : Buffer.from(result.content, "utf8");
    assertArtifactIntegrity(ref, content);
    return content;
  }
}

async function defaultContextResolver(ref: ArtifactRef): Promise<string> {
  if (!ref.uri.startsWith("file://")) throw new Error(`No context resolver is configured for ${ref.uri}`);
  return readFile(fileURLToPath(ref.uri), "utf8");
}

async function defaultArtifactResolver(ref: ArtifactRef): Promise<Buffer> {
  if (!ref.uri.startsWith("file://")) throw new Error(`No artifact resolver is configured for ${ref.uri}`);
  return readFile(fileURLToPath(ref.uri));
}

function assertArtifactIntegrity(ref: ArtifactRef, content: Buffer): void {
  if (!ref.sha256) return;
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== ref.sha256) throw new Error(`CodeTask artifact integrity check failed for ${ref.id}`);
}
