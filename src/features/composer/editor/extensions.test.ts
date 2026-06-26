import { describe, it, expect } from "vitest";
import { createEditorExtensions } from "./extensions";

describe("createEditorExtensions", () => {
  it("includes the full formatting extension set", () => {
    const names = createEditorExtensions().map((extension) => extension.name);
    const expected = [
      "starterKit", "image", "textStyle", "color", "fontFamily", "fontSize",
      "highlight", "textAlign", "table", "tableRow", "tableHeader", "tableCell",
      "taskList", "taskItem",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});
