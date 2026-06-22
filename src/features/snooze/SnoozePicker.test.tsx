import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUiStore } from "../../app/store";
import { SnoozePicker } from "./SnoozePicker";

const snoozeMutate = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useSnooze: () => ({ mutate: snoozeMutate }),
}));

function renderPicker() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SnoozePicker />
    </QueryClientProvider>
  );
}

describe("SnoozePicker", () => {
  beforeEach(() => {
    snoozeMutate.mockClear();
    useUiStore.getState().closeSnoozePicker();
  });

  it("renders nothing when closed", () => {
    const { container } = renderPicker();
    expect(container.firstChild).toBeNull();
  });

  it("clicking a preset snoozes the target ids and advances to the next", () => {
    useUiStore.setState({
      selectMode: "message",
      visibleMessageIds: [4, 5, 6],
      selectedRowIds: [5],
      selectedThreadId: null,
      selectedMessageId: 5,
    });
    useUiStore.getState().openSnoozePicker([5]);
    renderPicker();
    fireEvent.click(screen.getByText("Later today"));
    expect(snoozeMutate).toHaveBeenCalledTimes(1);
    const arg = snoozeMutate.mock.calls[0][0];
    expect(arg.messageIds).toEqual([5]);
    expect(arg.wakeAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(useUiStore.getState().snoozePickerOpen).toBe(false);
    expect(useUiStore.getState().selectedMessageId).toBe(6);
  });

  it("does nothing when there are no target ids", () => {
    useUiStore.getState().openSnoozePicker([]);
    renderPicker();
    fireEvent.click(screen.getByText("Tomorrow"));
    expect(snoozeMutate).not.toHaveBeenCalled();
  });
});
