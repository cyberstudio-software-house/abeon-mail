import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";

const { state, setDefaultAccountId, setTimeFormat, setMarkReadMode, setMarkReadDelaySeconds, setContentSecurity } = vi.hoisted(() => ({
  state: { markReadMode: "immediate" as "immediate" | "delay" | "never", markReadDelaySeconds: 2 },
  setDefaultAccountId: vi.fn(),
  setTimeFormat: vi.fn(),
  setMarkReadMode: vi.fn(),
  setMarkReadDelaySeconds: vi.fn(),
  setContentSecurity: vi.fn(),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({
    defaultAccountId: "",
    timeFormat: "system",
    markReadMode: state.markReadMode,
    markReadDelaySeconds: state.markReadDelaySeconds,
    setDefaultAccountId,
    setTimeFormat,
    setMarkReadMode,
    setMarkReadDelaySeconds,
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
  useContentSecurityLevel: () => ({ data: "balanced" }),
  useSetContentSecurityLevel: () => ({ mutate: setContentSecurity }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.markReadMode = "immediate";
  state.markReadDelaySeconds = 2;
});
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

  it("persists a chosen email content security level", () => {
    const { getByLabelText } = render(<GeneralSection />);
    fireEvent.change(getByLabelText("Email content security"), { target: { value: "strict" } });
    expect(setContentSecurity).toHaveBeenCalledWith("strict");
  });

  it("persists a chosen time format", () => {
    const { getByText } = render(<GeneralSection />);
    fireEvent.click(getByText("24-hour"));
    expect(setTimeFormat).toHaveBeenCalledWith("24h");
  });

  it("selecting a mark-as-read mode persists it", () => {
    const { getByText } = render(<GeneralSection />);
    fireEvent.click(getByText("After a delay"));
    expect(setMarkReadMode).toHaveBeenCalledWith("delay");
  });

  it("shows the delay input only in delay mode and persists changes", () => {
    state.markReadMode = "delay";
    const { getByLabelText } = render(<GeneralSection />);
    const input = getByLabelText("Mark as read delay seconds") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "8" } });
    expect(setMarkReadDelaySeconds).toHaveBeenCalledWith(8);
  });

  it("hides the delay input outside delay mode", () => {
    const { queryByLabelText } = render(<GeneralSection />);
    expect(queryByLabelText("Mark as read delay seconds")).toBeNull();
  });
});
