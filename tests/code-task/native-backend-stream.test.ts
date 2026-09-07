import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeMastraCodingBackend } from "../../packages/code-task/src/backend.ts";
import { executionProfile } from "../../packages/code-task/src/profiles.ts";

describe("native coding backend provider transport", () => {
  it.each([false, true])("uses Responses SSE and handles provider failure=%s", async fail => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "qasey-stream-test-"));
    const requests: { path: string | undefined; body: Record<string, unknown> }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (event: Record<string, unknown>) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: "response.created", response: { id: "response-public-fixture", created_at: 1, model: "public-test-model" } });
      emit({ type: "response.output_item.added", output_index: 0, item: { id: "message-1", type: "message" } });
      emit({ type: "response.output_text.delta", item_id: "message-1", delta: "Reviewed the public fixture." });
      // Keep an actual HTTP stream open across chunks, including text before an
      // error, instead of mocking the backend's aggregated getFullOutput result.
      setTimeout(() => {
        if (fail) {
          emit({ type: "error", sequence_number: 4, code: "fixture_stream_failure", message: "Public fixture provider failed after partial text" });
        } else {
          emit({ type: "response.output_item.done", output_index: 0, item: { id: "message-1", type: "message" } });
          emit({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } });
        }
        response.end("data: [DONE]\n\n");
      }, 10);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind");
      const pending = new NativeMastraCodingBackend().run({
        taskId: `public-stream-fixture-${fail}`, workspaceRoot,
        context: "Review this empty public fixture and summarize without using tools.",
        allowedPaths: [], profile: executionProfile("code-review-readonly"), traceContext: {},
        credentials: { openaiApiKey: "public-test-key", openaiBaseUrl: `http://127.0.0.1:${address.port}/v1` },
      });
      if (fail) await expect(pending).rejects.toThrow("Public fixture provider failed after partial text");
      else await expect(pending).resolves.toMatchObject({ summary: "Reviewed the public fixture." });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ path: "/v1/responses", body: { stream: true, store: false } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
