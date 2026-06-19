DROP TRIGGER IF EXISTS messages_ad_fts;
DROP TABLE IF EXISTS search_fts;

CREATE VIRTUAL TABLE search_fts USING fts5(
    subject,
    from_address,
    to_addresses,
    body_text,
    attachment_names,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);

CREATE TRIGGER messages_ad_fts AFTER DELETE ON messages BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
END;
