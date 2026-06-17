import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fixedEndpoints = {
  imap_host: "imap.x.com",
  imap_port: 993,
  imap_tls: true,
  smtp_host: "smtp.x.com",
  smtp_port: 465,
  smtp_tls: true,
};

const fixedAccount = {
  id: 7,
  email: "a@x.com",
  display_name: "A",
  provider_type: "imap_password" as const,
  color: null,
  position: 0,
};

let mockResolveMutateAsync: ReturnType<typeof vi.fn>;
let mockAddMutateAsync: ReturnType<typeof vi.fn>;

vi.mock("../../ipc/queries", () => ({
  useResolveEndpoints: () => ({
    mutateAsync: mockResolveMutateAsync,
    isPending: false,
    error: null,
    data: undefined,
  }),
  useAddAccount: () => ({
    mutateAsync: mockAddMutateAsync,
    isPending: false,
    error: null,
    data: undefined,
  }),
}));

import { AddAccountWizard } from "./AddAccountWizard";

describe("AddAccountWizard", () => {
  beforeEach(() => {
    mockResolveMutateAsync = vi.fn().mockResolvedValue(fixedEndpoints);
    mockAddMutateAsync = vi.fn().mockResolvedValue(fixedAccount);
  });

  afterEach(() => {
    cleanup();
  });

  it("happy path: resolves endpoints, shows prefilled fields, calls onAdded with account id", async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    const onClose = vi.fn();

    render(<AddAccountWizard onClose={onClose} onAdded={onAdded} />);

    await user.type(screen.getByLabelText(/email/i), "a@x.com");
    await user.type(screen.getByLabelText(/display name/i), "A");
    await user.type(screen.getByLabelText(/password/i), "secret");

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("imap.x.com")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: /add account/i }));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith(7);
    });
  });

  it("shows error message when add mutation rejects", async () => {
    mockAddMutateAsync = vi.fn().mockRejectedValue(new Error("Authentication failed"));

    const user = userEvent.setup();
    const onAdded = vi.fn();
    const onClose = vi.fn();

    render(<AddAccountWizard onClose={onClose} onAdded={onAdded} />);

    await user.type(screen.getByLabelText(/email/i), "a@x.com");
    await user.type(screen.getByLabelText(/display name/i), "A");
    await user.type(screen.getByLabelText(/password/i), "secret");

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("imap.x.com")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: /add account/i }));

    await waitFor(() => {
      expect(screen.getByText("Authentication failed")).toBeTruthy();
    });

    expect(onAdded).not.toHaveBeenCalled();
  });
});
