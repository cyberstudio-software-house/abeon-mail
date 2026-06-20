import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { sendError, listSendErrors, retrySend, dismissSendError } = vi.hoisted(() => ({
  sendError: {
    id: 24,
    account_id: 1,
    subject: "Monthly report",
    recipient: "boss@firma.pl",
    error: "connection failed: 465",
    attempts: 4,
    permanent: false,
  },
  listSendErrors: vi.fn(),
  retrySend: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  dismissSendError: vi.fn().mockResolvedValue({ status: "ok", data: null }),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { listSendErrors, retrySend, dismissSendError },
}));

import { SendErrorsBanner } from "./SendErrorsBanner";
import { commands } from "../../ipc/bindings";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SendErrorsBanner />
    </QueryClientProvider>
  );
}

describe("SendErrorsBanner", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders nothing when there are no send errors", async () => {
    listSendErrors.mockResolvedValue({ status: "ok", data: [] });
    const { queryByRole } = wrap();
    await waitFor(() => expect(commands.listSendErrors).toHaveBeenCalled());
    expect(queryByRole("alert")).toBeNull();
  });

  it("shows the failure with the actual SMTP error message", async () => {
    listSendErrors.mockResolvedValue({ status: "ok", data: [sendError] });
    const { findByRole, getByText } = wrap();
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/failed to send/i);
    expect(getByText("connection failed: 465")).toBeTruthy();
    expect(getByText(/Monthly report/)).toBeTruthy();
  });

  it("retries a failed send", async () => {
    listSendErrors.mockResolvedValue({ status: "ok", data: [sendError] });
    const { findByRole } = wrap();
    await findByRole("alert");
    fireEvent.click(await findByRole("button", { name: /retry/i }));
    await waitFor(() => expect(commands.retrySend).toHaveBeenCalledWith(24));
  });

  it("dismisses a failed send", async () => {
    listSendErrors.mockResolvedValue({ status: "ok", data: [sendError] });
    const { findByRole } = wrap();
    await findByRole("alert");
    fireEvent.click(await findByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(commands.dismissSendError).toHaveBeenCalledWith(24));
  });
});
