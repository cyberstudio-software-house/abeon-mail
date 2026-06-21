import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar } from "./Avatar";
import { senderAvatarColor, DEFAULT_APPEARANCE } from "./appearance";

describe("Avatar", () => {
  it("renders initials from the label", () => {
    render(<Avatar seed="malak@x.com" label="Malak Frederick" />);
    expect(screen.getByText("MF")).toBeTruthy();
  });

  it("derives a sender color from the seed and active accent", () => {
    render(<Avatar seed="a@b.com" label="Alice Brown" />);
    const el = screen.getByText("AB");
    expect(el.style.background).toBeTruthy();
    expect(el.getAttribute("data-color")).toBe(
      senderAvatarColor("a@b.com", DEFAULT_APPEARANCE.accent)
    );
  });

  it("uses the flat accent for account avatars", () => {
    render(<Avatar seed="me@b.com" label="My Account" variant="account" />);
    const el = screen.getByText("MA");
    expect(el.getAttribute("data-color")).toBe(DEFAULT_APPEARANCE.accent);
  });
});
