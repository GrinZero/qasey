import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const providerUtilsAlias = "@ai-sdk/provider-utils-v5";
const expectedProviderUtilsVersion = "4.0.48";

type MastraProviderUtilsCompatibilitySurface = {
  convertBase64ToUint8Array(value: string): Uint8Array;
  convertUint8ArrayToBase64(value: Uint8Array): string;
  injectJsonInstructionIntoMessages(options: {
    messages: Array<{ role: string; content: unknown }>;
    schema?: Record<string, unknown>;
  }): Array<{ role: string; content: unknown }>;
  isAbortError(error: unknown): boolean;
  isUrlSupported(options: {
    mediaType: string;
    url: string;
    supportedUrls: Record<string, RegExp[]>;
  }): boolean;
};

async function loadMastraProviderUtilsAlias() {
  const requireFromMastraCore = createRequire(import.meta.resolve("@mastra/core"));
  const modulePath = requireFromMastraCore.resolve(providerUtilsAlias);
  const manifestPath = requireFromMastraCore.resolve(`${providerUtilsAlias}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  const module = (await import(pathToFileURL(modulePath).href)) as Partial<MastraProviderUtilsCompatibilitySurface>;
  return { manifest, module };
}

describe("Mastra AI SDK compatibility override", () => {
  it("resolves the reviewed replacement through Mastra's runtime alias", async () => {
    const { manifest, module } = await loadMastraProviderUtilsAlias();

    expect(manifest).toMatchObject({
      name: "@ai-sdk/provider-utils",
      version: expectedProviderUtilsVersion,
    });
    expect(module).toEqual(
      expect.objectContaining({
        convertBase64ToUint8Array: expect.any(Function),
        convertUint8ArrayToBase64: expect.any(Function),
        injectJsonInstructionIntoMessages: expect.any(Function),
        isAbortError: expect.any(Function),
        isUrlSupported: expect.any(Function),
      }),
    );
  });

  it("preserves every provider-utils operation imported by Mastra core", async () => {
    const { module } = await loadMastraProviderUtilsAlias();
    const utils = module as MastraProviderUtilsCompatibilitySurface;
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = utils.convertUint8ArrayToBase64(bytes);

    expect(Array.from(utils.convertBase64ToUint8Array(encoded))).toEqual(Array.from(bytes));
    expect(utils.isAbortError(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toBe(true);
    expect(utils.isAbortError(new Error("ordinary failure"))).toBe(false);
    expect(
      utils.isUrlSupported({
        mediaType: "image/png",
        url: "https://cdn.example.test/image.png",
        supportedUrls: { "image/*": [/^https:\/\/cdn\.example\.test\//u] },
      }),
    ).toBe(true);

    const messages = utils.injectJsonInstructionIntoMessages({
      messages: [{ role: "user", content: [{ type: "text", text: "Return a result" }] }],
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain('"ok"');
    expect(messages[1]).toMatchObject({ role: "user" });
  });
});
