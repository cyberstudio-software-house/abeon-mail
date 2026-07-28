import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const suggestContacts = vi.fn();

vi.mock("../../ipc/bindings", () => ({
  commands: {
    suggestContacts: (...args: unknown[]) => suggestContacts(...args),
  },
  events: {},
}));

import { RecipientField } from "./RecipientField";

function ok(data: unknown) {
  return Promise.resolve({ status: "ok", data });
}

function renderField(recipients: string[] = [], onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecipientField label="To" recipients={recipients} onChange={onChange} accountId={7} />
    </QueryClientProvider>,
  );
  return { input: screen.getByLabelText("To"), onChange };
}

afterEach(() => {
  cleanup();
  suggestContacts.mockReset();
});

describe("RecipientField suggestions", () => {
  it("shows matching contacts with name and address", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: "Jan Kowalski", exchange_count: 3, last_contact_at: 1 }]),
    );
    const { input } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Jan Kowalski");
    expect(option.textContent).toContain("jan@firma.pl");
  });

  it("adds only the bare address when a suggestion is chosen", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: "Jan Kowalski", exchange_count: 3, last_contact_at: 1 }]),
    );
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["jan@firma.pl"]);
  });

  it("still adds a typed address that is not in the history", async () => {
    suggestContacts.mockReturnValue(ok([]));
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "nowy@nikt.pl" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["nowy@nikt.pl"]);
  });

  it("hides contacts that are already chips", async () => {
    suggestContacts.mockReturnValue(
      ok([
        { email: "jan@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 },
        { email: "biuro@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 },
      ]),
    );
    const { input } = renderField(["jan@firma.pl"]);

    fireEvent.change(input, { target: { value: "firma" } });

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("biuro@firma.pl");
  });

  it("closes the list on Escape without adding anything", async () => {
    suggestContacts.mockReturnValue(
      ok([{ email: "jan@firma.pl", name: null, exchange_count: 1, last_contact_at: 1 }]),
    );
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays usable when the suggestion query fails", async () => {
    suggestContacts.mockReturnValue(Promise.resolve({ status: "error", error: "boom" }));
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "jan" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["jan"]);
  });
});
