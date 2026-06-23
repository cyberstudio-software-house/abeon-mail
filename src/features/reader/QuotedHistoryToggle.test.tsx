import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuotedHistoryToggle } from "./QuotedHistoryToggle";

describe("QuotedHistoryToggle", () => {
  afterEach(cleanup);

  it("shows the expand label and dots when collapsed", () => {
    render(<QuotedHistoryToggle expanded={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Pokaż cytowaną historię" });
    expect(button.textContent).toContain("•••");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the hide label when expanded", () => {
    render(<QuotedHistoryToggle expanded={true} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Ukryj cytowaną historię" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<QuotedHistoryToggle expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Pokaż cytowaną historię" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
