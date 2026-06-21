import { commands } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";

export async function resolveSelectedMessageIds(): Promise<number[]> {
  const s = useUiStore.getState();
  if (s.selectMode === "message") return s.selectedRowIds;
  const res = await commands.messageIdsForThreads(s.selectedRowIds);
  return res.status === "ok" ? res.data : [];
}
