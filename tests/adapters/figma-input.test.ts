import { describe, expect, it } from "vitest";
import { validateFigmaToolInput } from "../../packages/adapters/src/mcp.ts";

describe("validateFigmaToolInput", () => {
  it("rejects node ids, titles, and full URLs passed as file_key", () => {
    expect(() => validateFigmaToolInput("figma_get_node_detail", { file_key: "4366:10167" }))
      .toThrow(/node id/i);
    expect(() => validateFigmaToolInput("figma_list_pages", { file_key: "Invoice follow up" }))
      .toThrow(/title or name/i);
    expect(() => validateFigmaToolInput("figma_list_pages", { file_key: "https://www.figma.com/design/abc/name" }))
      .toThrow(/full URL/i);
  });

  it("accepts a valid file key with a separate node id", () => {
    expect(() => validateFigmaToolInput("figma_get_node_detail", {
      file_key: "GUQDRg0HCBrli3dwSehLd9",
      node_ids: "4366:10167",
    })).not.toThrow();
  });

  it("does not apply Figma validation to unrelated tools", () => {
    expect(() => validateFigmaToolInput("slack_get_thread", { file_key: "Invoice follow up" })).not.toThrow();
  });
});
