ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_seen_date ON messages(seen, date DESC);
CREATE INDEX idx_messages_flagged_date ON messages(flagged, date DESC);
