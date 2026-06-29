import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterSortMenu } from "./FilterSortMenu";

const setListFilterSender = vi.fn();
const setListFilterSubject = vi.fn();
const setListFilterAttachmentsOnly = vi.fn();
const clearListFilters = vi.fn();
const setListSortDir = vi.fn();

let state = {
  listFilterSender: "",
  listFilterSubject: "",
  listFilterAttachmentsOnly: false,
  setListFilterSender,
  setListFilterSubject,
  setListFilterAttachmentsOnly,
  clearListFilters,
};

vi.mock("../../app/store", () => ({
  useUiStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock("../../shared/general/GeneralProvider", () => ({
  useGeneral: () => ({ listSortDir: "desc", setListSortDir }),
}));

describe("FilterSortMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      listFilterSender: "",
      listFilterSubject: "",
      listFilterAttachmentsOnly: false,
      setListFilterSender,
      setListFilterSubject,
      setListFilterAttachmentsOnly,
      clearListFilters,
    };
  });

  it("opens the panel and edits filters and sort", () => {
    render(<FilterSortMenu />);
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));

    fireEvent.click(screen.getByLabelText(/oldest first/i));
    expect(setListSortDir).toHaveBeenCalledWith("asc");

    fireEvent.change(screen.getByLabelText(/from contains/i), { target: { value: "alice" } });
    expect(setListFilterSender).toHaveBeenCalledWith("alice");

    fireEvent.change(screen.getByLabelText(/subject contains/i), { target: { value: "invoice" } });
    expect(setListFilterSubject).toHaveBeenCalledWith("invoice");

    fireEvent.click(screen.getByLabelText(/only with attachments/i));
    expect(setListFilterAttachmentsOnly).toHaveBeenCalledWith(true);
  });

  it("disables Clear when no filters are set", () => {
    render(<FilterSortMenu />);
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));
    expect((screen.getByRole("button", { name: /clear/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the active indicator and enables Clear when a filter is set", () => {
    state.listFilterSender = "alice";
    render(<FilterSortMenu />);
    expect(screen.getByRole("button", { name: /filter and sort/i }).getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /filter and sort/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(clearListFilters).toHaveBeenCalled();
  });
});
