import { describe, expect, it } from "vitest";
import {
  buildMeterSphereCasePlan,
  tryCasePlanSummary,
  validateMeterSphereCasePlan,
} from "../../packages/domain/src/index.ts";

describe("MeterSphere CasePlan", () => {
  const plan = buildMeterSphereCasePlan({
    dryRunInput: {
      dry_run: true,
      items: JSON.stringify([{
        operation: "create",
        name: "Case",
        node_id: "module",
        node_path: "/AI Draft/Feature",
      }]),
    },
    dryRunResult: {
      content: [{ type: "text", text: JSON.stringify([{
        success: true,
        dry_run: true,
        item_count: 1,
        creates: [{
          id: "preview",
          name: "Case",
          node_id: "module",
          node_path: "/AI Draft/Feature",
          verified: true,
        }],
      }]) }],
    },
  })!;

  it("summarizes a validated persisted plan", () => {
    expect(tryCasePlanSummary(plan)).toContain("1. [case_");
  });

  it("ignores Studio placeholders and malformed optional context", () => {
    expect(tryCasePlanSummary("<case-plan>")).toBeUndefined();
    expect(tryCasePlanSummary({ planHash: "partial" })).toBeUndefined();
    expect(() => validateMeterSphereCasePlan({ planHash: "partial" }))
      .toThrow("failed integrity validation");
  });

  it("freezes an update-only dry-run from the updates collection", () => {
    const updatePlan = buildMeterSphereCasePlan({
      dryRunInput: {
        dry_run: true,
        items: JSON.stringify([{
          operation: "update",
          case_id: "case-existing",
          priority: "P0",
        }]),
      },
      dryRunResult: {
        content: [{ type: "text", text: JSON.stringify([{
          success: true,
          dry_run: true,
          item_count: 1,
          creates: [],
          updates: [{
            id: "case-existing",
            name: "Existing case",
            priority: "P0",
            node_id: "module",
            node_path: "/AI Draft/Feature",
            verified: true,
          }],
        }]) }],
      },
    });

    expect(updatePlan).toMatchObject({
      plannedCount: 1,
      cases: [{ operation: "update", caseId: "case-existing", name: "Existing case", targetModuleId: "module" }],
    });
  });
});
