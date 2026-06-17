CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    auth_ref TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_path TEXT NOT NULL,
    name TEXT NOT NULL,
    folder_type TEXT NOT NULL,
    uidvalidity INTEGER,
    uidnext INTEGER,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    sync_state TEXT NOT NULL DEFAULT 'idle',
    UNIQUE(account_id, remote_path)
);

CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject_root TEXT NOT NULL,
    last_date INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER,
    message_id_hdr TEXT,
    thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
    from_address TEXT NOT NULL,
    from_name TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    snippet TEXT NOT NULL DEFAULT '',
    body_state TEXT NOT NULL DEFAULT 'none',
    snooze_wake_at INTEGER,
    UNIQUE(folder_id, uid)
);

CREATE TABLE message_bodies (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    mime_structure TEXT NOT NULL DEFAULT '{}',
    text_plain TEXT,
    text_html TEXT,
    downloaded_at INTEGER
);

CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    content_id TEXT,
    blob_ref TEXT,
    downloaded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    UNIQUE(account_id, name)
);

CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);

CREATE TABLE contacts_cache (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    avatar_ref TEXT,
    UNIQUE(account_id, email)
);

CREATE TABLE signatures (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    html TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_queue (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER
);

CREATE VIRTUAL TABLE search_fts USING fts5(
    subject,
    from_address,
    to_addresses,
    body_text,
    attachment_names,
    content=''
);

CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_account_seen ON messages(account_id, seen);
CREATE INDEX idx_sync_queue_state_retry ON sync_queue(state, next_retry_at);
CREATE INDEX idx_threads_account_lastdate ON threads(account_id, last_date DESC);
