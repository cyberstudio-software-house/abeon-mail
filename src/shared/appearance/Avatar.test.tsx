import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar } from "./Avatar";
import { avatarColor } from "./appearance";

describe("Avatar", () => {
  it("renders initials from the label", () => {
    render(<Avatar seed="malak@x.com" label="Malak Frederick" />);
    expect(screen.getByText("MF")).toBeTruthy();
  });

  it("uses the deterministic color for the seed", () => {
    render(<Avatar seed="a@b.com" label="Alice Brown" />);
    const el = screen.getByText("AB");
    expect(el.style.background).toBeTruthy();
    expect(el.getAttribute("data-color")).toBe(avatarColor("a@b.com"));
  });
});
