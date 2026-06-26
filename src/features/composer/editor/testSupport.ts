import { vi } from "vitest";
import type { Editor } from "@tiptap/react";

const CHAIN_METHODS = [
  "focus", "toggleBold", "toggleItalic", "toggleUnderline", "toggleStrike",
  "setColor", "unsetColor", "toggleHighlight", "unsetHighlight",
  "setFontFamily", "unsetFontFamily", "setFontSize", "unsetFontSize",
  "toggleHeading", "setParagraph", "setTextAlign",
  "toggleBulletList", "toggleOrderedList", "toggleTaskList",
  "toggleBlockquote", "toggleCodeBlock", "setHorizontalRule",
  "setLink", "unsetLink", "insertContent", "setImage",
  "insertTable", "addRowBefore", "addRowAfter", "deleteRow",
  "addColumnBefore", "addColumnAfter", "deleteColumn",
  "mergeCells", "splitCell", "deleteTable",
  "unsetAllMarks", "clearNodes",
];

export function createEditorMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const run = vi.fn(() => true);
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn(() => chain);
  }
  chain.run = run;
  const editor = {
    chain: vi.fn(() => chain),
    can: vi.fn(() => chain),
    isActive: vi.fn(() => false),
    getAttributes: vi.fn(() => ({})),
    ...overrides,
  };
  return { editor: editor as unknown as Editor, chain, run };
}
