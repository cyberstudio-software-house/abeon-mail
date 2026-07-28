INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(j.value), NULL, count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id AND f.folder_type = 'sent'
JOIN json_each(m.to_addresses) j
WHERE instr(j.value, '@') > 1
GROUP BY f.account_id, lower(j.value)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at);

INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(j.value), NULL, count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id AND f.folder_type = 'sent'
JOIN json_each(m.cc_addresses) j
WHERE instr(j.value, '@') > 1
GROUP BY f.account_id, lower(j.value)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at);

INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
SELECT f.account_id, lower(m.from_address), max(m.from_name), count(*), max(m.date), ''
FROM messages m
JOIN folders f ON f.id = m.folder_id
WHERE m.answered = 1 AND instr(m.from_address, '@') > 1
GROUP BY f.account_id, lower(m.from_address)
ON CONFLICT(account_id, email) DO UPDATE SET
    exchange_count = contacts_cache.exchange_count + excluded.exchange_count,
    last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at),
    name = COALESCE(contacts_cache.name, excluded.name);
