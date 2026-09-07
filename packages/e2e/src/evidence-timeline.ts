import { inflateRawSync } from "node:zlib";

export interface EvidenceStepTiming {
  index: number;
  title: string;
  traceCallId: string;
  traceStartMs: number;
  traceEndMs?: number;
  videoStartMs?: number;
  videoEndMs?: number;
}

export interface EvidenceTimeline {
  steps: EvidenceStepTiming[];
  traceArtifactId?: string;
  videoArtifactId?: string;
  unavailableReason?: string;
}

export const MAX_TRACE_ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_TRACE_TEXT_BYTES = 24 * 1024 * 1024;

/** Read only trace metadata; never extract snapshot resources or archive paths to disk. */
export function traceEntries(archive: Buffer): string[] {
  if (archive.length > MAX_TRACE_ARCHIVE_BYTES) throw new Error("Trace archive exceeds metadata limit");
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65_557); end--) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) throw new Error("Invalid ZIP directory");
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || count === 0xffff) throw new Error("Unsupported ZIP directory");
  const entries: string[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error("Invalid ZIP filename");
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor = next;
    if (!name.endsWith(".trace")) continue;
    total += size;
    if (flags & 1 || total > MAX_TRACE_TEXT_BYTES || ![0, 8].includes(method)) throw new Error("Unsupported trace entry");
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid ZIP local entry");
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    if (start + compressedSize > archive.length) throw new Error("Truncated trace entry");
    const compressed = archive.subarray(start, start + compressedSize);
    const decoded = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }) : compressed;
    if (decoded.length !== size) throw new Error("Trace size mismatch");
    entries.push(decoded.toString("utf8"));
  }
  return entries;
}

type TraceEvent = Record<string, unknown>;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Explicit numbered test.step groups are the bridge to frozen text steps, never equal-duration guesses. */
export function timelineFromTrace(entries: string[], stepCount: number, allowVideo: boolean): EvidenceTimeline {
  const actions: Array<{ event: TraceEvent; wallTime?: number }> = [];
  const ends = new Map<string, number>();
  const pages = new Map<string, number>();
  const createdPages = new Set<string>();
  let eventCount = 0;
  for (const text of entries) {
    let clockOffset: number | undefined;
    for (const [line] of text.matchAll(/[^\r\n]+/gu)) {
      if (++eventCount > 150_000) throw new Error("Trace metadata event limit exceeded");
      const event = JSON.parse(line) as TraceEvent;
      if (event.type === "context-options") clockOffset = finite(event.wallTime) && finite(event.monotonicTime) ? event.wallTime - event.monotonicTime : undefined;
      if (event.type === "event" && event.class === "BrowserContext" && event.method === "page") {
        const params = event.params as { pageId?: unknown } | undefined;
        if (typeof params?.pageId === "string") createdPages.add(params.pageId);
      }
      if (event.type === "before" && event.method === "test.step" && finite(event.startTime)) {
        if (actions.length >= 2_000) throw new Error("Too many trace steps");
        actions.push({ event, ...(clockOffset !== undefined ? { wallTime: clockOffset + event.startTime } : {}) });
      }
      if (event.type === "after" && typeof event.callId === "string" && finite(event.endTime)) ends.set(event.callId, event.endTime);
      if (event.type === "screencast-frame" && typeof event.pageId === "string" && finite(event.frameSwapWallTime)) {
        pages.set(event.pageId, Math.min(pages.get(event.pageId) ?? Infinity, event.frameSwapWallTime));
      }
    }
  }
  // Only align recordings for a page created inside this trace. A chunk started
  // after page creation cannot establish the video origin and must remain unmapped.
  // This is first-frame alignment, not an encoder-level frame manifest.
  const videoOrigin = allowVideo && pages.size === 1 && createdPages.has(pages.keys().next().value!) ? pages.values().next().value : undefined;
  const mapped = new Map<number, EvidenceStepTiming[]>();
  for (const { event, wallTime } of actions) {
    if (typeof event.title !== "string" || typeof event.callId !== "string" || !finite(event.startTime)) continue;
    const match = /^(?:step\s*0*(\d+)|步骤\s*0*(\d+))(?=\s|[·:：.、-]|$)/iu.exec(event.title);
    const index = Number(match?.[1] ?? match?.[2]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= stepCount) continue;
    const end = ends.get(event.callId);
    const videoStartMs = videoOrigin !== undefined && wallTime !== undefined ? Math.max(0, wallTime - videoOrigin) : undefined;
    const timing: EvidenceStepTiming = {
      index, title: event.title, traceCallId: event.callId, traceStartMs: event.startTime,
      ...(end !== undefined ? { traceEndMs: end } : {}),
      ...(videoStartMs !== undefined ? { videoStartMs, ...(end !== undefined ? { videoEndMs: Math.max(0, wallTime! - videoOrigin! + end - event.startTime) } : {}) } : {}),
    };
    mapped.set(index, [...mapped.get(index) ?? [], timing]);
  }
  // Repeated numbers are ambiguous (for example retry groups), so leave them unmapped.
  const steps = [...mapped.values()].filter(items => items.length === 1).map(items => items[0]!).sort((a, b) => a.index - b.index);
  return { steps, ...(!steps.length ? { unavailableReason: "此 Trace 没有可对应文字步骤的编号 test.step，仍可手动查看完整证据。" } : {}) };
}
