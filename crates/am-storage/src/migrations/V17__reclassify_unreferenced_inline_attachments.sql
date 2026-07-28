UPDATE attachments SET is_inline = 0
WHERE is_inline = 1
  AND EXISTS (
    SELECT 1 FROM message_bodies b
    WHERE b.message_id = attachments.message_id AND b.text_html IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM message_bodies b
    WHERE b.message_id = attachments.message_id
      AND instr(lower(b.text_html), 'cid:' || lower(attachments.content_id)) > 0
  );

UPDATE messages SET has_attachments = 1
WHERE has_attachments = 0
  AND EXISTS (
    SELECT 1 FROM attachments a
    WHERE a.message_id = messages.id AND a.is_inline = 0
  );
