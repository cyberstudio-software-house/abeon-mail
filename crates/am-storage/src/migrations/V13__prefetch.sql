ALTER TABLE folders ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_body_state ON messages(folder_id, body_state);
