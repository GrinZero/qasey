import { describe, expect, it } from "vitest";
import { evidenceType, runConclusion } from "../../apps/admin-ui/src/components/run-report";
import type { Artifact, QaseyRun } from "../../apps/admin-ui/src/types";

const artifact = (name: string, kind: Artifact["kind"] = "report"): Artifact => ({ id: name, name, kind, uri: "artifact://public" });
describe("human-readable run evidence", () => {
  it("does not treat report assets and metadata as visual evidence", () => {
    for (const name of ["trace/assets/app.js", "trace/style.css", "trace/font.ttf", "trace/playwright-logo.svg", "contexts/task.json", "trace/snapshot.html", "error-context.md", ".last-run.json"]) {
      expect(evidenceType(artifact(name, "trace"))).toBe("internal");
    }
    expect(evidenceType(artifact("test-failed-1.png"))).toBe("image");
    expect(evidenceType(artifact("video.webm"))).toBe("video");
    expect(evidenceType(artifact("trace.zip"))).toBe("trace");
  });
  it("does not turn a heartbeat failure into a product defect or a passing result", () => {
    const conclusion = runConclusion({ status: "failed", error: "Run exceeded the configured heartbeat recovery window" } as QaseyRun);
    expect(conclusion.title).toContain("运行中断");
    expect(conclusion.detail).toContain("不能作为测试通过");
  });
});
