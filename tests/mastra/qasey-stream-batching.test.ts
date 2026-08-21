import { describe, expect, it } from "vitest";
import { ChunkFrom } from "@mastra/core/stream";
import { createQaseyStreamBatcher } from "../../src/mastra/agents/qasey-main/processors.ts";

describe("qasey stream batching", () => {
  it("coalesces ten consecutive text deltas into one Redis-facing part", async () => {
    const processor = createQaseyStreamBatcher();
    const state: Record<string, unknown> = {};
    const emitted = [];

    for (let index = 0; index < 10; index += 1) {
      emitted.push(await processor.processOutputStream({
        part: {
          type: "text-delta",
          runId: "run-1",
          from: ChunkFrom.AGENT,
          payload: { id: "message-1", text: String(index) },
        },
        streamParts: [],
        state,
        abort: reason => { throw new Error(reason); },
      }));
    }

    expect(emitted.slice(0, 9)).toEqual(Array(9).fill(null));
    expect(emitted[9]).toMatchObject({
      type: "text-delta",
      runId: "run-1",
      payload: { id: "message-1", text: "0123456789" },
    });
  });
});
