CREATE TABLE meeting_responses (
    message_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,
    responded_at INTEGER NOT NULL
);
