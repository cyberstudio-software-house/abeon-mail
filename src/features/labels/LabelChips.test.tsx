import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LabelChips } from "./LabelChips";

describe("LabelChips", () => {
  it("renders a chip per label", () => {
    const { getByText } = render(
      <LabelChips labels={[{ id: 1, name: "Work", color: "#4f46e5" }, { id: 2, name: "Urgent", color: "#ef5d3a" }]} />
    );
    expect(getByText("Work")).toBeTruthy();
    expect(getByText("Urgent")).toBeTruthy();
  });

  it("renders nothing for empty labels", () => {
    const { container } = render(<LabelChips labels={[]} />);
    expect(container.querySelector(".label-chip")).toBeNull();
  });
});
