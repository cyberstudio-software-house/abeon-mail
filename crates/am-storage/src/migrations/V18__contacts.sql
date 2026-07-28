ALTER TABLE contacts_cache ADD COLUMN exchange_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN last_contact_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts_cache ADD COLUMN search_key TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_contacts_search ON contacts_cache(search_key);
