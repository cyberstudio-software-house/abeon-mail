import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../ipc/client", () => ({
  health: vi.fn(async () => "ok"),
}));

vi.mock("../shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn(), resolved: "light" }),
}));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders three panes and shows ipc status", async () => {
    render(<AppShell />);
    expect(screen.getByLabelText("message-list")).toBeTruthy();
    expect(screen.getByLabelText("reader")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("IPC: ok")).toBeTruthy());
  });
});
