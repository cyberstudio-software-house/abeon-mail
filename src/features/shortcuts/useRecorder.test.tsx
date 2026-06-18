import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useRecorder } from "./useRecorder";

afterEach(cleanup);

function Harness({ onCommit }: { onCommit: (b: string) => void }) {
  const rec = useRecorder(onCommit, 50);
  return (
    <div>
      <button onClick={rec.start}>start</button>
      <span data-testid="state">{rec.recording ? "rec" : "idle"}</span>
      <span data-testid="steps">{rec.steps.join(" ")}</span>
    </div>
  );
}

describe("useRecorder", () => {
  it("captures a single chord and commits after the pause", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    expect(screen.getByTestId("state").textContent).toBe("rec");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(onCommit).toHaveBeenCalledWith("Mod+k");
    vi.useRealTimers();
  });

  it("captures a two-step sequence", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.keyDown(window, { key: "g" });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    fireEvent.keyDown(window, { key: "i" });
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(onCommit).toHaveBeenCalledWith("g i");
    vi.useRealTimers();
  });

  it("Escape cancels without committing", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByText("start"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("idle");
  });
});
