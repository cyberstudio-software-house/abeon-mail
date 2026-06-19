import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { SnoozeSection } from "./SnoozeSection";

const { setMorningHour, setLaterTodayHours, setWeekendDay, setWeekStartDay } = vi.hoisted(() => ({
  setMorningHour: vi.fn(),
  setLaterTodayHours: vi.fn(),
  setWeekendDay: vi.fn(),
  setWeekStartDay: vi.fn(),
}));

vi.mock("../../shared/snooze/SnoozeProvider", () => ({
  useSnoozeSettings: () => ({
    morningHour: 8,
    laterTodayHours: 3,
    weekendDay: 6,
    weekStartDay: 1,
    setMorningHour,
    setLaterTodayHours,
    setWeekendDay,
    setWeekStartDay,
  }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("SnoozeSection", () => {
  it("reflects the current config", () => {
    const { getByLabelText } = render(<SnoozeSection />);
    expect((getByLabelText("Morning hour") as HTMLSelectElement).value).toBe("8");
    expect((getByLabelText("Later today offset") as HTMLSelectElement).value).toBe("3");
    expect((getByLabelText("Weekend day") as HTMLSelectElement).value).toBe("6");
    expect((getByLabelText("Start of week") as HTMLSelectElement).value).toBe("1");
  });

  it("persists each changed control", () => {
    const { getByLabelText } = render(<SnoozeSection />);
    fireEvent.change(getByLabelText("Morning hour"), { target: { value: "6" } });
    expect(setMorningHour).toHaveBeenCalledWith(6);
    fireEvent.change(getByLabelText("Later today offset"), { target: { value: "4" } });
    expect(setLaterTodayHours).toHaveBeenCalledWith(4);
    fireEvent.change(getByLabelText("Weekend day"), { target: { value: "0" } });
    expect(setWeekendDay).toHaveBeenCalledWith(0);
    fireEvent.change(getByLabelText("Start of week"), { target: { value: "2" } });
    expect(setWeekStartDay).toHaveBeenCalledWith(2);
  });
});
