import { vi } from "vitest";

vi.mock("@tiptap/react", () => ({
  useEditor: () => null,
  EditorContent: () => null,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: {},
}));

vi.mock("@tiptap/extension-image", () => ({
  Image: { configure: () => ({}) },
}));
