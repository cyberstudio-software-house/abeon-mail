import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, beforeEach } from "vitest";
import { ShortcutsProvider } from "./ShortcutsProvider";
import { useUiStore } from "../../app/store";

function setup() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ShortcutsProvider><div /></ShortcutsProvider>
    </QueryClientProvider>
  );
}

function pressArrow(key: "ArrowDown" | "ArrowUp") {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("arrow-key message navigation", () => {
  beforeEach(() => {
    useUiStore.setState({
      selectMode: "thread",
      visibleMessageIds: [42, 43, 44],
      selectedRowIds: [42],
      selectedThreadId: 42,
      selectedMessageId: null,
    });
  });

  it("ArrowDown selects the next thread", () => {
    setup();
    pressArrow("ArrowDown");
    expect(useUiStore.getState().selectedThreadId).toBe(43);
  });

  it("ArrowUp selects the previous thread", () => {
    useUiStore.setState({ selectedThreadId: 43, selectedRowIds: [43] });
    setup();
    pressArrow("ArrowUp");
    expect(useUiStore.getState().selectedThreadId).toBe(42);
  });

  it("ArrowDown advances the selected message in flat mode", () => {
    useUiStore.setState({
      selectMode: "message",
      visibleMessageIds: [6, 7, 8, 9],
      selectedRowIds: [7],
      selectedThreadId: null,
      selectedMessageId: 7,
    });
    setup();
    pressArrow("ArrowDown");
    expect(useUiStore.getState().selectedMessageId).toBe(8);
  });
});
