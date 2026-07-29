import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted } from "@tauri-apps/plugin-notification";
import { commands, events } from "./bindings";
import { useUiStore } from "../app/store";

async function maybeNotifyNewMail(payload: { folder_id: number; count: number }) {
  if (!useUiStore.getState().notificationsEnabled) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await isPermissionGranted())) return;
  await commands.showNewMailNotification(payload.account_id, payload.folder_id, payload.count);
}

function navigateToNotificationTarget(payload: {
  account_id: number | null;
  folder_id: number | null;
  thread_id: number | null;
  message_id: number | null;
}) {
  if (payload.account_id == null || payload.folder_id == null) return;
  const store = useUiStore.getState();
  store.setSelectedAccountId(payload.account_id);
  store.setSelectedFolderId(payload.folder_id);
  const rowId = store.selectMode === "thread" ? payload.thread_id : payload.message_id;
  if (rowId == null) return;
  useUiStore.getState().selectRow(rowId);
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
        void commands.showSendErrorNotification(event.payload.error);
      }
    });

    const sendSucceededPromise = events.sendSucceeded.listen(() => {
      useUiStore.getState().markSendSucceeded();
    });

    const notificationActivatedPromise = events.notificationActivated.listen((event) => {
      navigateToNotificationTarget(event.payload);
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
      notificationActivatedPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
