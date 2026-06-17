export function MailboxRail({ status }: { status: string }) {
  return (
    <aside className="rail">
      <strong>AbeonMail</strong>
      <nav>
        <div>All Inboxes</div>
        <div>Unread</div>
        <div>Flagged</div>
        <div>Snoozed</div>
        <div>Drafts</div>
      </nav>
      <div className="status">IPC: {status}</div>
    </aside>
  );
}
