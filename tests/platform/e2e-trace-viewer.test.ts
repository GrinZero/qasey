import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playwrightTraceViewerRoot, traceViewerContentType, traceViewerRelativePath } from "../../src/platform/e2e/trace-viewer.ts";

describe("Playwright Trace Viewer assets", () => {
  it("packages a usable viewer with notices for a service without node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-trace-viewer-"));
    const target = join(root, "dist/trace-viewer");
    try {
      execFileSync(process.execPath, ["scripts/copy-trace-viewer.mjs", target]);
      expect(playwrightTraceViewerRoot(root)).toBe(target);
      const html = await readFile(join(target, "index.html"), "utf8");
      expect(html).toContain("<script");
      for (const [, asset] of html.matchAll(/(?:src|href)="(\.\/[^"?]+)"/gu)) {
        expect((await readFile(join(target, asset!))).byteLength).toBeGreaterThan(0);
      }
      expect(await readFile(join(target, "LICENSE"), "utf8")).toContain("Apache");
      expect((await readFile(join(target, "NOTICE"), "utf8")).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves nested viewer asset paths from the request URL", () => {
    expect(traceViewerRelativePath("https://qasey.test/v1/case-hub/trace-viewer/index.KZ4wOW1K.js"))
      .toBe("index.KZ4wOW1K.js");
    expect(traceViewerRelativePath("https://qasey.test/v1/case-hub/trace-viewer/assets/urlMatch-L3liM589.js"))
      .toBe("assets/urlMatch-L3liM589.js");
    expect(traceViewerRelativePath("https://qasey.test/v1/case-hub/trace-viewer/?trace=https%3A%2F%2Fqasey.test%2Ftrace.zip"))
      .toBe("index.html");
  });

  it("rejects malformed or unrelated request URLs", () => {
    expect(traceViewerRelativePath("https://qasey.test/v1/case-hub/runs/1")).toBeUndefined();
    expect(traceViewerRelativePath("https://qasey.test/v1/case-hub/trace-viewer/%E0%A4%A")).toBeUndefined();
  });

  it("serves JavaScript modules with a module-compatible content type", () => {
    expect(traceViewerContentType("assets/viewer.js")).toBe("application/javascript; charset=utf-8");
    expect(traceViewerContentType("viewer.css")).toBe("text/css; charset=utf-8");
  });
});
