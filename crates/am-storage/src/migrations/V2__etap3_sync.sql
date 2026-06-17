ALTER TABLE folders ADD COLUMN highestmodseq INTEGER;
ALTER TABLE folders ADD COLUMN last_synced_at INTEGER;

ALTER TABLE messages ADD COLUMN references_hdr TEXT;
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
