import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useKeyboardEngine } from "./useKeyboardEngine";
import type { ActionId, ActionContext } from "./registry";

afterEach(cleanup);

function Harness({
  resolved,
  handlers,
  context,
}: {
  resolved: Partial<Record<ActionId, string | null>>;
  handlers: Partial<Record<ActionId, () => void>>;
  context: ActionContext;
}) {
  useKeyboardEngine({
    getResolved: () => resolved as Record<ActionId, string | null>,
    getHandlers: () => handlers,
    getContext: () => context,
    sequenceTimeoutMs: 800,
  });
  return (
    <div>
      <input aria-label="field" />
    </div>
  );
}

describe("useKeyboardEngine", () => {
  it("fires a single-key global action", () => {
    const compose = vi.fn();
    render(<Harness resolved={{ compose: "c" }} handlers={{ compose }} context="list" />);
    fireEvent.keyDown(window, { key: "c" });
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it("fires a sequence only after both steps", () => {
    const go = vi.fn();
    render(<Harness resolved={{ "go-inbox": "g i" }} handlers={{ "go-inbox": go }} context="list" />);
    fireEvent.keyDown(window, { key: "g" });
    expect(go).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "i" });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("respects context: a reader action does not fire in list context", () => {
    const reply = vi.fn();
    render(<Harness resolved={{ reply: "r" }} handlers={{ reply }} context="list" />);
    fireEvent.keyDown(window, { key: "r" });
    expect(reply).not.toHaveBeenCalled();
  });

  it("suppresses single-key shortcuts while typing in an input", () => {
    const compose = vi.fn();
    const { getByLabelText } = render(
      <Harness resolved={{ compose: "c" }} handlers={{ compose }} context="list" />
    );
    const input = getByLabelText("field");
    input.focus();
    fireEvent.keyDown(input, { key: "c" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("still fires Mod chords while typing in an input", () => {
    const palette = vi.fn();
    const { getByLabelText } = render(
      <Harness resolved={{ "command-palette": "Mod+k" }} handlers={{ "command-palette": palette }} context="list" />
    );
    const input = getByLabelText("field");
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("ignores disabled actions (no handler registered)", () => {
    render(<Harness resolved={{ archive: "e" }} handlers={{}} context="reader" />);
    expect(() => fireEvent.keyDown(window, { key: "e" })).not.toThrow();
  });
});
