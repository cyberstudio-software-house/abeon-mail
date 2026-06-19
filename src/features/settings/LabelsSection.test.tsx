import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LabelsSection } from "./LabelsSection";
import { commands } from "../../ipc/bindings";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listLabels: vi.fn().mockResolvedValue({ status: "ok", data: [{ id: 1, name: "Work", color: "#4f46e5" }] }),
    createLabel: vi.fn().mockResolvedValue({ status: "ok", data: { id: 2, name: "New", color: "#10b981" } }),
    renameLabel: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    setLabelColor: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    deleteLabel: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("LabelsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists labels and creates a new one", async () => {
    const { getByText, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.change(getByLabelText("New label name"), { target: { value: "Urgent" } });
    fireEvent.click(getByText("Add label"));
    await waitFor(() => expect(commands.createLabel).toHaveBeenCalled());
  });

  it("deletes a label", async () => {
    const { getByText, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByText("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Delete label Work"));
    await waitFor(() => expect(commands.deleteLabel).toHaveBeenCalledWith(1));
  });
});
