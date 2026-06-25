import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { commands, events } from "./bindings";
import { useUiStore } from "../app/store";

async function maybeNotifyNewMail(payload: { folder_id: number; count: number }) {
  if (!useUiStore.getState().notificationsEnabled) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await isPermissionGranted())) return;
  const res = await commands.buildNewMailNotification(payload.folder_id, payload.count);
  if (res.status === "ok" && res.data) {
    sendNotification({ title: res.data.title, body: res.data.body });
  }
}

export function useSyncEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const progressPromise = events.syncProgress.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
    });

    const messagesPromise = events.newMessages.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      void maybeNotifyNewMail(event.payload);
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
    });

    const mailboxPromise = events.mailboxChanged.listen((event) => {
      const { account_id, folder_id } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["folders", account_id] });
      queryClient.invalidateQueries({ queryKey: ["messages", folder_id] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
    });

    const authChangedPromise = events.accountAuthChanged.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    });

    const snoozeWokePromise = events.snoozeWoke.listen(() => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread-messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      void commands.refreshUnreadBadge(useUiStore.getState().badgeEnabled);
    });

    const prefetchPromise = events.prefetchProgress.listen((event) => {
      const { account_id, done, total } = event.payload;
      useUiStore.getState().setPrefetchProgress(account_id, done, total);
      queryClient.invalidateQueries({ queryKey: ["messages"] });
    });

    const sendFailedPromise = events.sendFailed.listen(async (event) => {
      useUiStore.getState().markSendFailed();
      queryClient.invalidateQueries({ queryKey: ["sendErrors"] });
      if (await isPermissionGranted()) {
        sendNotification({
          title: "Couldn't send message",
          body: event.payload.error,
        });
      }
    });

    const sendSucceededPromise = events.sendSucceeded.listen(() => {
      useUiStore.getState().markSendSucceeded();
    });

    return () => {
      progressPromise.then((unlisten) => unlisten());
      messagesPromise.then((unlisten) => unlisten());
      mailboxPromise.then((unlisten) => unlisten());
      authChangedPromise.then((unlisten) => unlisten());
      snoozeWokePromise.then((unlisten) => unlisten());
      prefetchPromise.then((unlisten) => unlisten());
      sendFailedPromise.then((unlisten) => unlisten());
      sendSucceededPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
