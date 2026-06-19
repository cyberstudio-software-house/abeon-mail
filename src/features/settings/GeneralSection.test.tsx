import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";

const { setDefaultAccountId, setTimeFormat } = vi.hoisted(() => ({
  setDefaultAccountId: vi.fn(),
  setTimeFormat: vi.fn(),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({
    defaultAccountId: "",
    timeFormat: "system",
    setDefaultAccountId,
    setTimeFormat,
  }),
}));

vi.mock("../updates/UpdatesPanel", () => ({ UpdatesPanel: () => null }));

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({
    data: [
      { id: 3, email: "a@example.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false },
      { id: 5, email: "b@example.com", display_name: "B", provider_type: "imap_password", color: null, position: 1, requires_reauth: false },
    ],
  }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("GeneralSection", () => {
  it("lists accounts plus the automatic option", () => {
    const { getByLabelText } = render(<GeneralSection />);
    const select = getByLabelText("Default account") as HTMLSelectElement;
    expect(select.options.length).toBe(3);
    expect(select.options[0].value).toBe("");
    expect(select.options[1].value).toBe("3");
  });

  it("persists a chosen default account", () => {
    const { getByLabelText } = render(<GeneralSection />);
    fireEvent.change(getByLabelText("Default account"), { target: { value: "5" } });
    expect(setDefaultAccountId).toHaveBeenCalledWith("5");
  });

  it("persists a chosen time format", () => {
    const { getByText } = render(<GeneralSection />);
    fireEvent.click(getByText("24-hour"));
    expect(setTimeFormat).toHaveBeenCalledWith("24h");
  });
});
