import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const getSettings = vi.fn();
const setSetting = vi.fn().mockResolvedValue({ status: "ok", data: null });

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getSettings: () => getSettings(),
    setSetting: (k: string, v: string) => setSetting(k, v),
  },
}));

import { GeneralProvider, useGeneral } from "./GeneralProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const g = useGeneral();
  return (
    <div>
      <span data-testid="tf">{g.timeFormat}</span>
      <span data-testid="acc">{g.defaultAccountId}</span>
      <button onClick={() => g.setTimeFormat("24h")}>set-24h</button>
      <button onClick={() => g.setDefaultAccountId("5")}>set-acc</button>
    </div>
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["general.timeFormat", "12h"], ["general.defaultAccountId", "3"]],
  });
  setSetting.mockClear();
  useUiStore.setState({ defaultAccountId: "", timeFormat: "system", generalHydrated: false });
});

describe("GeneralProvider", () => {
  it("hydrates the store from getSettings on mount", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("12h"));
    expect(screen.getByTestId("acc").textContent).toBe("3");
    expect(useUiStore.getState().generalHydrated).toBe(true);
  });

  it("setTimeFormat persists via setSetting", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("12h"));
    fireEvent.click(screen.getByText("set-24h"));
    await waitFor(() => expect(screen.getByTestId("tf").textContent).toBe("24h"));
    expect(setSetting).toHaveBeenCalledWith("general.timeFormat", "24h");
  });

  it("setDefaultAccountId persists via setSetting", async () => {
    render(<GeneralProvider><Probe /></GeneralProvider>);
    await waitFor(() => expect(screen.getByTestId("acc").textContent).toBe("3"));
    fireEvent.click(screen.getByText("set-acc"));
    expect(setSetting).toHaveBeenCalledWith("general.defaultAccountId", "5");
  });
});
