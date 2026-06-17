import { useEffect, useState } from "react";
import "./shell.css";
import { health } from "../ipc/client";
import { useSyncEvents } from "../ipc/events";
import { MailboxRail } from "../features/mailbox/MailboxRail";
import { MessageListPane } from "../features/message-list/MessageListPane";
import { ReaderPane } from "../features/reader/ReaderPane";

export function AppShell() {
  useSyncEvents();

  const [status, setStatus] = useState("…");

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
    <div className="shell" data-density="comfortable">
      <MailboxRail status={status} />
      <MessageListPane />
      <ReaderPane />
    </div>
  );
}
