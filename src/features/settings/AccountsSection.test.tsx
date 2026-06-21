import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { endpoints, jan, gmail } = vi.hoisted(() => ({
  endpoints: {
    imap_host: "mail.x",
    imap_port: 993,
    imap_tls: true,
    smtp_host: "smtp.x",
    smtp_port: 465,
    smtp_tls: true,
  },
  jan: {
    id: 1,
    email: "jan@firma.pl",
    display_name: "Jan",
    color: "#4f46e5",
    position: 0,
    requires_reauth: false,
    provider_type: "imap_password",
  },
  gmail: {
    id: 2,
    email: "g@gmail.com",
    display_name: "Gmail",
    color: null,
    position: 1,
    requires_reauth: true,
    provider_type: "google_oauth",
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listAccounts: vi.fn().mockResolvedValue({ status: "ok", data: [jan, gmail] }),
    getAccountEndpoints: vi.fn().mockResolvedValue({ status: "ok", data: endpoints }),
    updateAccount: vi.fn().mockResolvedValue({ status: "ok", data: jan }),
    removeAccount: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    reorderAccounts: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    beginReauth: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    getSettings: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    setSetting: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    listFolders: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
}));

import { AccountsSection } from "./AccountsSection";
import { commands } from "../../ipc/bindings";
import { decodeImapUtf7 } from "../mailbox/folder-tree";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountsSection />
    </QueryClientProvider>
  );
}

describe("AccountsSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("lists accounts with name and email", async () => {
    const { findByText, getByText } = wrap();
    expect(await findByText("Jan")).toBeTruthy();
    expect(getByText("jan@firma.pl")).toBeTruthy();
    expect(getByText("Gmail")).toBeTruthy();
  });

  it("moves an account down via reorder", async () => {
    const { findByLabelText } = wrap();
    fireEvent.click(await findByLabelText("Move Jan down"));
    await waitFor(() => expect(commands.reorderAccounts).toHaveBeenCalledWith([2, 1]));
  });

  it("edits an IMAP account: name + server settings", async () => {
    const { findByLabelText, getByLabelText, getByRole } = wrap();
    fireEvent.click(await findByLabelText("Edit Jan"));
    await waitFor(() =>
      expect((getByLabelText("IMAP host") as HTMLInputElement).value).toBe("mail.x")
    );
    fireEvent.change(getByLabelText("Display name"), { target: { value: "Janek" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(commands.updateAccount).toHaveBeenCalledWith(1, "Janek", null, endpoints, null)
    );
  });

  it("hides server fields for a Google account", async () => {
    const { findByLabelText, getByLabelText, queryByLabelText } = wrap();
    fireEvent.click(await findByLabelText("Edit Gmail"));
    expect(getByLabelText("Display name")).toBeTruthy();
    expect(queryByLabelText("IMAP host")).toBeNull();
  });

  it("removes an account after confirmation", async () => {
    const { findByLabelText, getByText, getByRole } = wrap();
    fireEvent.click(await findByLabelText("Remove Jan"));
    expect(getByText(/permanently remove/i)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(commands.removeAccount).toHaveBeenCalledWith(1));
  });

  it("reconnects a Google account that requires reauth", async () => {
    const { findByText } = wrap();
    fireEvent.click(await findByText("⚠ Reconnect"));
    await waitFor(() => expect(commands.beginReauth).toHaveBeenCalledWith(2));
  });

  it("renders the offline-prefetch master switch", async () => {
    const { findAllByRole } = wrap();
    const switches = await findAllByRole("switch", {
      name: /Download message bodies for offline/i,
    });
    expect(switches.length).toBe(2);
  });

  it("opens a folder modal with decoded names and toggles a selection", async () => {
    const raw = "Firmowe og&APM-lne";
    const decoded = decodeImapUtf7(raw);
    expect(decoded).not.toBe(raw);

    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["prefetch.bodies.1", "true"]],
    });
    vi.mocked(commands.listFolders).mockResolvedValue({
      status: "ok",
      data: [
        {
          id: 11,
          account_id: 1,
          remote_path: "Firmowe ogólne",
          name: raw,
          folder_type: "custom",
          unread_count: 0,
          total_count: 0,
        },
      ],
    });

    const { findByRole, getByText, queryByText, getByLabelText } = wrap();

    fireEvent.click(await findByRole("button", { name: /^Folders/ }));

    expect(getByText(decoded)).toBeTruthy();
    expect(queryByText(raw)).toBeNull();

    fireEvent.click(getByLabelText(`Prefetch ${decoded}`));
    await waitFor(() =>
      expect(commands.setSetting).toHaveBeenCalledWith(
        "prefetch.folders.1",
        JSON.stringify([11]),
      ),
    );
  });

  it("shows subfolders nested under their parent in the modal", async () => {
    vi.mocked(commands.getSettings).mockResolvedValue({
      status: "ok",
      data: [["prefetch.bodies.1", "true"]],
    });
    vi.mocked(commands.listFolders).mockResolvedValue({
      status: "ok",
      data: [
        {
          id: 21,
          account_id: 1,
          remote_path: "Projekty",
          name: "Projekty",
          folder_type: "custom",
          unread_count: 0,
          total_count: 0,
        },
        {
          id: 22,
          account_id: 1,
          remote_path: "Projekty.2024",
          name: "2024",
          folder_type: "custom",
          unread_count: 0,
          total_count: 0,
        },
      ],
    });

    const { findByRole, getByText } = wrap();
    fireEvent.click(await findByRole("button", { name: /^Folders/ }));

    const parentLi = getByText("Projekty").closest("li");
    const childLi = getByText("2024").closest("li");
    expect(parentLi?.style.paddingLeft).toBe("0px");
    expect(childLi?.style.paddingLeft).toBe("16px");
  });
});
