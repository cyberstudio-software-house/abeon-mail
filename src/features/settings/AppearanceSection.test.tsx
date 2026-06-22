import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const setTheme = vi.fn();
const setAccent = vi.fn();
const setDensity = vi.fn();
const setShowPreview = vi.fn();
const setShowAvatars = vi.fn();
const setSmartFoldersEnabled = vi.fn();
const setSmartFolderVisible = vi.fn();
let smartFoldersEnabled = true;

vi.mock("../../shared/appearance/AppearanceProvider", () => ({
  useAppearance: () => ({
    theme: "auto",
    accent: "#4f46e5",
    density: "comfortable",
    showPreview: true,
    showAvatars: true,
    smartFoldersEnabled,
    smartFolderVisibility: { all_inboxes: true, unread: true, flagged: true, snoozed: true },
    setTheme,
    setAccent,
    setDensity,
    setShowPreview,
    setShowAvatars,
    setSmartFoldersEnabled,
    setSmartFolderVisible,
  }),
}));

import { AppearanceSection } from "./AppearanceSection";

beforeEach(() => {
  smartFoldersEnabled = true;
  [setTheme, setAccent, setDensity, setShowPreview, setShowAvatars, setSmartFoldersEnabled, setSmartFolderVisible].forEach(
    (f) => f.mockClear()
  );
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

  it("toggling the master switch calls setSmartFoldersEnabled(false)", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Show smart folders" }));
    expect(setSmartFoldersEnabled).toHaveBeenCalledWith(false);
  });

  it("renders a switch for each smart folder", () => {
    render(<AppearanceSection />);
    ["All Inboxes", "Unread", "Flagged", "Snoozed"].forEach((name) => {
      expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
    });
  });

  it("toggling a smart folder switch calls setSmartFolderVisible with its kind", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Flagged" }));
    expect(setSmartFolderVisible).toHaveBeenCalledWith("flagged", false);
  });

  it("disables the per-folder switches while the master toggle is off", () => {
    smartFoldersEnabled = false;
    render(<AppearanceSection />);
    const flagged = screen.getByRole("switch", { name: "Flagged" });
    expect(flagged.hasAttribute("disabled")).toBe(true);
    fireEvent.click(flagged);
    expect(setSmartFolderVisible).not.toHaveBeenCalled();
  });

  it("active controls reflect the current appearance state", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Accent #4f46e5" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Accent #10b981" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Comfortable/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Dense/ }).getAttribute("aria-pressed")).toBe("false");
  });
});
