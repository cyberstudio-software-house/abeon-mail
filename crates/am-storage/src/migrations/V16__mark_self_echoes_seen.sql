UPDATE messages SET seen = 1
WHERE seen = 0 AND deleted = 0 AND draft = 0 AND message_id_hdr IS NOT NULL
  AND folder_id NOT IN (SELECT id FROM folders WHERE folder_type = 'sent')
  AND EXISTS (
    SELECT 1 FROM messages s
    JOIN folders fs ON fs.id = s.folder_id
    WHERE fs.folder_type = 'sent'
      AND s.account_id = messages.account_id
      AND s.message_id_hdr = messages.message_id_hdr
      AND s.deleted = 0 AND s.draft = 0
  );

UPDATE folders SET unread_count = (
  SELECT count(*) FROM messages m
  WHERE m.folder_id = folders.id AND m.seen = 0 AND m.deleted = 0 AND m.draft = 0
);

UPDATE threads SET unread_count = (
  SELECT count(*) FROM messages m
  WHERE m.thread_id = threads.id AND m.seen = 0
);
