import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const setTheme = vi.fn();
const setAccent = vi.fn();
const setDensity = vi.fn();
const setShowPreview = vi.fn();
const setShowAvatars = vi.fn();

vi.mock("../../shared/appearance/AppearanceProvider", () => ({
  useAppearance: () => ({
    theme: "auto",
    accent: "#4f46e5",
    density: "comfortable",
    showPreview: true,
    showAvatars: true,
    setTheme,
    setAccent,
    setDensity,
    setShowPreview,
    setShowAvatars,
  }),
}));

import { AppearanceSection } from "./AppearanceSection";

beforeEach(() => {
  [setTheme, setAccent, setDensity, setShowPreview, setShowAvatars].forEach((f) => f.mockClear());
});

afterEach(cleanup);

describe("AppearanceSection", () => {
  it("selecting Dark calls setTheme('dark')", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("selecting an accent swatch calls setAccent with its hex", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "Accent #10b981" }));
    expect(setAccent).toHaveBeenCalledWith("#10b981");
  });

  it("selecting Dense calls setDensity('dense')", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: /Dense/ }));
    expect(setDensity).toHaveBeenCalledWith("dense");
  });

  it("toggling preview text calls setShowPreview(false)", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Show preview text" }));
    expect(setShowPreview).toHaveBeenCalledWith(false);
  });

  it("toggling avatars calls setShowAvatars(false)", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Show sender avatars" }));
    expect(setShowAvatars).toHaveBeenCalledWith(false);
  });
});
