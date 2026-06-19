import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
  afterEach(() => cleanup());

  it("lists labels and creates a new one", async () => {
    const { getByDisplayValue, getByLabelText, getByText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByDisplayValue("Work")).toBeTruthy());
    fireEvent.change(getByLabelText("New label name"), { target: { value: "Urgent" } });
    fireEvent.click(getByText("Add label"));
    await waitFor(() => expect(commands.createLabel).toHaveBeenCalled());
  });

  it("deletes a label", async () => {
    const { getByDisplayValue, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByDisplayValue("Work")).toBeTruthy());
    fireEvent.click(getByLabelText("Delete label Work"));
    await waitFor(() => expect(commands.deleteLabel).toHaveBeenCalledWith(1));
  });

  it("renames a label on blur", async () => {
    const { getByDisplayValue, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByDisplayValue("Work")).toBeTruthy());
    const input = getByLabelText("Rename Work");
    fireEvent.change(input, { target: { value: "Personal" } });
    fireEvent.blur(input);
    await waitFor(() => expect(commands.renameLabel).toHaveBeenCalledWith(1, "Personal"));
  });

  it("changes label color", async () => {
    const { getByDisplayValue, getByLabelText } = wrap(<LabelsSection />);
    await waitFor(() => expect(getByDisplayValue("Work")).toBeTruthy());
    const select = getByLabelText("Color for Work");
    fireEvent.change(select, { target: { value: "#10b981" } });
    await waitFor(() => expect(commands.setLabelColor).toHaveBeenCalledWith(1, "#10b981"));
  });
});
