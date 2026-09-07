import { describe, expect, it } from "vitest";
import { artifactContentDisposition } from "../../src/mastra/applications/qasey/artifact-headers.ts";

describe("artifact content disposition", () => {
  it.each(["测试侧边栏-trace.zip", "折叠🙂-video.webm", "plain-video.webm"])("supports native Response headers for %s", name => {
    const value = artifactContentDisposition(name);
    const response = new Response("evidence", { headers: { "content-disposition": value } });
    expect(response.headers.get("content-disposition")).toBe(value);
    expect(value).toMatch(/^[\x20-\x7e]+$/u);
    expect(decodeURIComponent(value.split("filename*=UTF-8''")[1]!)).toBe(name);
  });
  it("removes both platform path prefixes and sanitizes header controls and quotes", () => {
    const value = artifactContentDisposition('../folder\\用例"\r\n-video.webm');
    expect(value).toContain('filename="_____-video.webm"');
    expect(decodeURIComponent(value.split("filename*=UTF-8''")[1]!)).toBe('用例"__-video.webm');
    expect(() => new Headers({ "content-disposition": value })).not.toThrow();
  });
  it("encodes RFC 5987 delimiters and tolerates malformed Unicode", () => {
    expect(artifactContentDisposition("a'()*!.zip")).toContain("filename*=UTF-8''a%27%28%29%2A%21.zip");
    expect(() => artifactContentDisposition("\ud800.webm")).not.toThrow();
  });
  it.each(["", "/", ".", ".."])("uses a safe fallback for %j", name => {
    expect(artifactContentDisposition(name)).toBe('inline; filename="artifact"; filename*=UTF-8\'\'artifact');
  });
});
