import { useEffect, useState } from "react";
import "./shell.css";
import { health } from "../ipc/client";
import { useSyncEvents } from "../ipc/events";
import { MailboxRail } from "../features/mailbox/MailboxRail";
import { MessageListPane } from "../features/message-list/MessageListPane";
import { ReaderPane } from "../features/reader/ReaderPane";
import { Composer } from "../features/composer/Composer";
import { SettingsOverlay } from "../features/settings/SettingsOverlay";
import { useUiStore } from "./store";

export function AppShell() {
  useSyncEvents();

  const [status, setStatus] = useState("…");
  const openComposer = useUiStore((s) => s.openComposer);
  const composerOpen = useUiStore((s) => s.composer.open);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const density = useUiStore((s) => s.density);

  useEffect(() => {
    let active = true;
    health()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus("error"));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell" data-density={density}>
      <MailboxRail status={status} />
      <MessageListPane />
      <ReaderPane />
      <div className="shell-compose-action">
        <button
          type="button"
          className="btn-new-message"
          aria-label="New message"
          onClick={() => openComposer(null)}
        >
          New
        </button>
      </div>
      {settingsOpen && <SettingsOverlay />}
      {composerOpen && <Composer />}
    </div>
  );
}
