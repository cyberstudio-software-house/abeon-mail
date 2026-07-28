use rusqlite::params;

use crate::db::{Database, StorageError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactSuggestion {
    pub email: String,
    pub name: Option<String>,
    pub exchange_count: i64,
    pub last_contact_at: i64,
}

fn fold_char(c: char) -> char {
    match c {
        'ą' => 'a',
        'ć' => 'c',
        'ę' => 'e',
        'ł' => 'l',
        'ń' => 'n',
        'ó' => 'o',
        'ś' => 's',
        'ż' | 'ź' => 'z',
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ò' | 'ô' | 'ö' | 'õ' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

pub fn fold_text(input: &str) -> String {
    let lowered = input.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == 'ß' {
            out.push_str("ss");
        } else {
            out.push(fold_char(c));
        }
    }
    out
}

pub fn normalize_search_key(name: Option<&str>, email: &str) -> String {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let email = email.trim();
    match name {
        Some(name) => fold_text(&format!("{name} {email}")),
        None => fold_text(email),
    }
}

fn is_valid_address(email: &str) -> bool {
    if email.contains(char::is_whitespace) {
        return false;
    }
    match email.find('@') {
        Some(at) => at > 0 && at + 1 < email.len(),
        None => false,
    }
}

pub fn upsert_contact(
    db: &Database,
    account_id: i64,
    email: &str,
    name: Option<&str>,
    contacted_at: i64,
) -> Result<(), StorageError> {
    let email = email.trim().to_lowercase();
    if !is_valid_address(&email) {
        return Ok(());
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let search_key = normalize_search_key(name, &email);

    let conn = db.conn();
    conn.execute(
        "INSERT INTO contacts_cache (account_id, email, name, exchange_count, last_contact_at, search_key)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)
         ON CONFLICT(account_id, email) DO UPDATE SET
             exchange_count = contacts_cache.exchange_count + 1,
             last_contact_at = max(contacts_cache.last_contact_at, excluded.last_contact_at),
             name = COALESCE(excluded.name, contacts_cache.name),
             search_key = CASE
                 WHEN excluded.name IS NULL AND contacts_cache.name IS NOT NULL
                 THEN contacts_cache.search_key
                 ELSE excluded.search_key
             END",
        params![account_id, email, name, contacted_at, search_key],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts_repo::insert_account;
    use am_core::account::{NewAccount, ProviderType};

    fn seed_account(db: &Database, email: &str) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: email.into(),
                display_name: "Owner".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    fn stored(db: &Database, email: &str) -> (Option<String>, i64, i64, String) {
        let conn = db.conn();
        conn.query_row(
            "SELECT name, exchange_count, last_contact_at, search_key
             FROM contacts_cache WHERE email = ?1",
            rusqlite::params![email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    #[test]
    fn fold_text_lowercases_and_strips_diacritics() {
        assert_eq!(fold_text("Łukasz ŻÓŁĆ"), "lukasz zolc");
        assert_eq!(fold_text("Jan@Firma.PL"), "jan@firma.pl");
        assert_eq!(fold_text("Straße"), "strasse");
    }

    #[test]
    fn normalize_search_key_joins_name_and_email() {
        assert_eq!(
            normalize_search_key(Some("Łukasz Nowak"), "L.Nowak@firma.pl"),
            "lukasz nowak l.nowak@firma.pl"
        );
        assert_eq!(normalize_search_key(None, "a@b.pl"), "a@b.pl");
        assert_eq!(normalize_search_key(Some("   "), "a@b.pl"), "a@b.pl");
    }

    #[test]
    fn upsert_inserts_lowercased_contact_with_count_one() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "Jan@Firma.PL", Some("Jan Kowalski"), 5_000).unwrap();

        let (name, count, last, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(count, 1);
        assert_eq!(last, 5_000);
        assert_eq!(key, "jan kowalski jan@firma.pl");
    }

    #[test]
    fn upsert_increments_count_and_keeps_latest_date() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan"), 9_000).unwrap();
        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan"), 1_000).unwrap();

        let (_, count, last, _) = stored(&db, "jan@firma.pl");
        assert_eq!(count, 2);
        assert_eq!(last, 9_000);
    }

    #[test]
    fn upsert_learns_a_name_later_and_never_clears_a_known_one() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        upsert_contact(&db, account_id, "jan@firma.pl", None, 1_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name, None);
        assert_eq!(key, "jan@firma.pl");

        upsert_contact(&db, account_id, "jan@firma.pl", Some("Jan Kowalski"), 2_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(key, "jan kowalski jan@firma.pl");

        upsert_contact(&db, account_id, "jan@firma.pl", None, 3_000).unwrap();
        let (name, _, _, key) = stored(&db, "jan@firma.pl");
        assert_eq!(name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(key, "jan kowalski jan@firma.pl");
    }

    #[test]
    fn upsert_skips_malformed_addresses() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db, "me@example.com");

        for bad in ["", "  ", "nodomain", "@firma.pl", "jan@", "jan kowalski@firma.pl"] {
            upsert_contact(&db, account_id, bad, None, 1_000).unwrap();
        }

        let conn = db.conn();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM contacts_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
