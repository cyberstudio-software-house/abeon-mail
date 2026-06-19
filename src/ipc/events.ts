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
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const authChangedPromise = events.accountAuthChanged.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    });

    const snoozeWokePromise = events.snoozeWoke.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    return () => {
      progressPromise.then((unlisten) => unlisten());
      messagesPromise.then((unlisten) => unlisten());
      mailboxPromise.then((unlisten) => unlisten());
      authChangedPromise.then((unlisten) => unlisten());
      snoozeWokePromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
