import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LabelPicker } from "./LabelPicker";
import { useUiStore } from "../../app/store";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listLabels: vi.fn().mockResolvedValue({ status: "ok", data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
    labelsForMessages: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    createLabel: vi.fn().mockResolvedValue({ status: "ok", data: { id: 2, name: "New", color: "#10b981" } }),
    setMessageLabels: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("LabelPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ labelPickerOpen: true, labelPickerTargetIds: [10] });
  });

  afterEach(cleanup);

  it("renders existing labels and toggles them", async () => {
    const { getByText } = wrap(<LabelPicker />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByText("Work"));
    await waitFor(() =>
      expect(commands.setMessageLabels).toHaveBeenCalledWith(1, [10], true)
    );
  });

  it("creates a new label on Enter when no match", async () => {
    const { getByLabelText } = wrap(<LabelPicker />);
    const input = getByLabelText("Filter or create label");
    fireEvent.change(input, { target: { value: "Urgent" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(commands.createLabel).toHaveBeenCalled());
  });

  it("returns null when closed", () => {
    useUiStore.setState({ labelPickerOpen: false, labelPickerTargetIds: [] });
    const { container } = wrap(<LabelPicker />);
    expect(container.querySelector(".label-picker")).toBeNull();
  });
});
