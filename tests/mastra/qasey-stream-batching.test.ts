import { describe, expect, it } from "vitest";
import { ChunkFrom } from "@mastra/core/stream";
import { createQaseyStreamBatcher } from "../../src/mastra/agents/qasey-main/processors.ts";

describe("qasey stream batching", () => {
  it("coalesces eight consecutive text deltas into one emitted part", async () => {
    const processor = createQaseyStreamBatcher();
    const state: Record<string, unknown> = {};
    const emitted = [];

    for (let index = 0; index < 8; index += 1) {
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

    expect(emitted.slice(0, 7)).toEqual(Array(7).fill(null));
    expect(emitted[7]).toMatchObject({
      type: "text-delta",
      runId: "run-1",
      payload: { id: "message-1", text: "01234567" },
    });
  });
});
