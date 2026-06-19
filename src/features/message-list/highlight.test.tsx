import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { extractTerms, Highlight } from "./highlight";

describe("extractTerms", () => {
  it("keeps free terms and drops operators", () => {
    expect(extractTerms("from:alice quarterly report has:attachment")).toEqual([
      "quarterly",
      "report",
    ]);
  });

  it("returns empty for operator-only queries", () => {
    expect(extractTerms("has:attachment")).toEqual([]);
  });
});

describe("Highlight", () => {
  it("wraps matched terms in mark, diacritic-insensitive", () => {
    render(<Highlight text="Rapórt roczny" terms={["raport"]} />);
    const mark = screen.getByText("Rapórt");
    expect(mark.tagName).toBe("MARK");
  });

  it("renders plain text when no terms match", () => {
    const { container } = render(<Highlight text="hello world" terms={["xyz"]} />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("hello world");
  });

  it("marks the exact term even after a combining-diacritic char", () => {
    render(<Highlight text="Faktura wstępna raport" terms={["raport"]} />);
    const mark = screen.getByText("raport");
    expect(mark.tagName).toBe("MARK");
    expect(mark.textContent).toBe("raport");
  });
});
