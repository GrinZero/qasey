import type { CaseHubRepository } from "../../../../packages/domain/src/case-hub-repository.ts";
import type { DownloadableArtifactStore } from "../../../../packages/e2e/src/artifacts.ts";
import type { OwnerScope } from "../../../../packages/contracts/src/index.ts";
import { MAX_TRACE_ARCHIVE_BYTES, timelineFromTrace, traceEntries, type EvidenceTimeline } from "../../../../packages/e2e/src/evidence-timeline.ts";

export async function resultEvidenceTimeline(
  repository: Pick<CaseHubRepository, "getResult" | "versionsForCase">,
  store: Pick<DownloadableArtifactStore, "open">,
  owner: OwnerScope,
  resultId: string,
): Promise<EvidenceTimeline | undefined> {
  const result = await repository.getResult(owner, resultId);
  if (!result) return undefined;
  const version = (await repository.versionsForCase(owner, result.caseId)).find(item => item.id === result.caseVersionId);
  if (!version) return undefined;
  const traces = result.artifacts.filter(item => item.kind === "trace" && /(?:^|\/)trace\.zip$/iu.test(item.name.replaceAll("\\", "/")));
  const videos = result.artifacts.filter(item => item.kind === "video");
  if (traces.length !== 1) return { steps: [], unavailableReason: "此结果没有唯一的 Trace，无法可靠定位步骤。请手动查看证据。" };
  const trace = traces[0]!;
  try {
    const content = await store.open(owner, trace);
    if ((content.contentLength ?? 0) > MAX_TRACE_ARCHIVE_BYTES) {
      await content.body.cancel();
      return { steps: [], unavailableReason: "Trace 超出步骤索引大小限制，可在调试器中查看。" };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = content.body.getReader();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 10_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TRACE_ARCHIVE_BYTES) { await reader.cancel(); throw new Error("Trace too large"); }
        chunks.push(value);
      }
    } finally { clearTimeout(deadline); reader.releaseLock(); }
    if (timedOut) throw new Error("Trace read deadline exceeded");
    const timeline = timelineFromTrace(traceEntries(Buffer.concat(chunks)), version.steps.length, videos.length === 1);
    return { ...timeline, traceArtifactId: trace.id, ...(videos.length === 1 ? { videoArtifactId: videos[0]!.id } : {}) };
  } catch {
    return { steps: [], unavailableReason: "此结果的步骤索引暂不可用，可手动查看完整视频和 Trace。" };
  }
}
