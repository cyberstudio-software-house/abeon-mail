import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { events } from "./bindings";

export function useSyncEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const progressPromise = events.syncProgress.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });

    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });

    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    });

    return () => {
      progressPromise.then((unlisten) => unlisten());
      messagesPromise.then((unlisten) => unlisten());
      mailboxPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
