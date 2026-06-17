import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "app_health") return "ok";
    return null;
  }),
}));

import { health } from "./client";

describe("ipc client", () => {
  it("health returns ok from app_health command", async () => {
    await expect(health()).resolves.toBe("ok");
  });
});
