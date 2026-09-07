import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { traceEntries, timelineFromTrace } from "../../packages/e2e/src/evidence-timeline.ts";
import { resultEvidenceTimeline } from "../../src/mastra/applications/qasey/evidence-timeline.ts";

function zipTrace(text: string): Buffer {
  const name = Buffer.from("test.trace"), data = Buffer.from(text), compressed = deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
const trace = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");
const events = [
  { type: "context-options", wallTime: 100_000, monotonicTime: 1_000 },
  { type: "event", class: "BrowserContext", method: "page", params: { pageId: "page1" } },
  { type: "screencast-frame", pageId: "page1", frameSwapWallTime: 100_200 },
  { type: "before", method: "test.step", title: "Step 01 · Open page", callId: "step1", startTime: 1_100 },
  { type: "after", callId: "step1", endTime: 1_500 },
  { type: "before", method: "test.step", title: "Step 02 · Collapse", callId: "step2", startTime: 1_650 },
  { type: "after", callId: "step2", endTime: 5_000 },
];

describe("real evidence step timeline", () => {
  it("uses explicit step numbers and recording wall clock rather than equal test duration slices", () => {
    const result = timelineFromTrace(traceEntries(zipTrace(trace(events))), 3, true);
    expect(result.steps.map(step => [step.index, step.videoStartMs])).toEqual([[0, 0], [1, 450]]);
    expect(result.steps[1]).toMatchObject({ traceCallId: "step2", traceStartMs: 1650, traceEndMs: 5000 });
    expect(result.steps.some(step => step.index === 2)).toBe(false);
  });
  it("does not guess ambiguous repeated step numbers or multi-page video mappings", () => {
    const result = timelineFromTrace([trace([...events, { type: "screencast-frame", pageId: "page2", frameSwapWallTime: 100_300 }, { type: "before", method: "test.step", title: "Step 02 · Duplicate", callId: "duplicate", startTime: 6000 }])], 2, true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.videoStartMs).toBeUndefined();
  });
  it("keeps Trace navigation when video clock metadata is unavailable", () => {
    const result = timelineFromTrace([trace(events.filter(event => event.type !== "context-options"))], 2, true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.videoStartMs).toBeUndefined();
  });
  it("does not align a later trace chunk to the beginning of a pre-existing page recording", () => {
    const result = timelineFromTrace([trace(events.filter(event => event.type !== "event"))], 2, true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every(step => step.videoStartMs === undefined)).toBe(true);
  });
  it("bounds the number of decoded events before allocating a whole object graph", () => {
    expect(() => timelineFromTrace(["{}\n".repeat(150_001)], 2, false)).toThrow("event limit");
  });
  it("rejects malformed archives and inflated size claims", () => {
    expect(() => traceEntries(Buffer.from("not a zip"))).toThrow();
    const zip = zipTrace(trace(events));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(30 * 1024 * 1024, central + 24);
    expect(() => traceEntries(zip)).toThrow("Unsupported trace entry");
  });
  it("reads only the requested owned result artifacts, not historical run artifacts", async () => {
    const owner = { applicationId: "qasey", tenantId: "public-tenant" };
    const artifact = { id: "current-trace", kind: "trace", name: "verifier/current/trace.zip" };
    const repo = { getResult: vi.fn().mockResolvedValue({ caseId: "QASEY-1", caseVersionId: "version1", artifacts: [artifact, { id: "current-video", kind: "video" }] }), versionsForCase: vi.fn().mockResolvedValue([{ id: "version1", steps: [{}, {}] }]) };
    const store = { open: vi.fn().mockResolvedValue({ body: new Response(new Uint8Array(zipTrace(trace(events)))).body! }) };
    const result = await resultEvidenceTimeline(repo as never, store, owner, "result1");
    expect(repo.getResult).toHaveBeenCalledWith(owner, "result1");
    expect(store.open).toHaveBeenCalledWith(owner, artifact);
    expect(result).toMatchObject({ traceArtifactId: "current-trace", videoArtifactId: "current-video" });
    expect(result?.steps[1]?.videoStartMs).toBe(450);
    repo.getResult.mockResolvedValue(undefined); store.open.mockClear();
    expect(await resultEvidenceTimeline(repo as never, store, owner, "other-tenant-result")).toBeUndefined();
    expect(store.open).not.toHaveBeenCalled();
  });
});
