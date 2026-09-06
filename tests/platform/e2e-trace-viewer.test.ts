import { describe, expect, it } from "vitest";
import { traceViewerContentType, traceViewerRelativePath } from "../../src/platform/e2e/trace-viewer.ts";

describe("Playwright Trace Viewer assets", () => {
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
