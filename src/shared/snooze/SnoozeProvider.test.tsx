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

import { SnoozeProvider, useSnoozeSettings } from "./SnoozeProvider";
import { useUiStore } from "../../app/store";

function Probe() {
  const s = useSnoozeSettings();
  return (
    <div>
      <span data-testid="mh">{s.morningHour}</span>
      <button onClick={() => s.setMorningHour(6)}>set-mh</button>
    </div>
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({
    status: "ok",
    data: [["snooze.morningHour", "7"]],
  });
  setSetting.mockClear();
  useUiStore.setState({
    snoozeMorningHour: 8,
    snoozeLaterTodayHours: 3,
    snoozeWeekendDay: 6,
    snoozeWeekStartDay: 1,
  });
});

describe("SnoozeProvider", () => {
  it("hydrates the store from getSettings on mount", async () => {
    render(<SnoozeProvider><Probe /></SnoozeProvider>);
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("7"));
  });

  it("setMorningHour persists via setSetting", async () => {
    render(<SnoozeProvider><Probe /></SnoozeProvider>);
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("7"));
    fireEvent.click(screen.getByText("set-mh"));
    await waitFor(() => expect(screen.getByTestId("mh").textContent).toBe("6"));
    expect(setSetting).toHaveBeenCalledWith("snooze.morningHour", "6");
  });
});
