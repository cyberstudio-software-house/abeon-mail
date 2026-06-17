import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { events } from "./bindings";

export function useSyncEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenMessages: (() => void) | undefined;

    events.syncProgress
      .listen((event) => {
        const { account_id, folder_id } = event.payload;
        queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
        queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      })
      .then((fn) => {
        unlistenProgress = fn;
      });

    events.newMessages
      .listen((event) => {
        const { account_id, folder_id } = event.payload;
        queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
        queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      })
      .then((fn) => {
        unlistenMessages = fn;
      });

    return () => {
      unlistenProgress?.();
      unlistenMessages?.();
    };
  }, [queryClient]);
}
