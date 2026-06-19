CREATE INDEX idx_messages_snooze ON messages(snooze_wake_at)
WHERE snooze_wake_at IS NOT NULL;
