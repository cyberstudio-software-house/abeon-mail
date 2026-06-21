import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ipc/bindings", () => ({
  commands: { messageIdsForThreads: vi.fn() },
}));

import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { resolveSelectedMessageIds } from "./resolveMessageIds";

beforeEach(() => {
  useUiStore.setState({ selectedRowIds: [], selectMode: "message" });
});

describe("resolveSelectedMessageIds", () => {
  it("returns rowIds directly in message mode", async () => {
    useUiStore.setState({ selectMode: "message", selectedRowIds: [5, 6] });
    expect(await resolveSelectedMessageIds()).toEqual([5, 6]);
    expect(commands.messageIdsForThreads).not.toHaveBeenCalled();
  });

  it("expands threads in thread mode", async () => {
    vi.mocked(commands.messageIdsForThreads).mockResolvedValue({ status: "ok", data: [100, 101, 200] });
    useUiStore.setState({ selectMode: "thread", selectedRowIds: [1, 2] });
    expect(await resolveSelectedMessageIds()).toEqual([100, 101, 200]);
    expect(commands.messageIdsForThreads).toHaveBeenCalledWith([1, 2]);
  });
});
