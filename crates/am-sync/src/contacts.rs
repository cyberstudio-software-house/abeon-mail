use am_core::outgoing::OutgoingMessage;
use am_protocols::imap::FetchedHeader;
use am_storage::{contacts_repo, Database};

pub fn harvest_sent_headers(db: &Database, account_id: i64, fetched: &[FetchedHeader]) {
    for header in fetched {
        for addr in header.to.iter().chain(header.cc.iter()) {
            if let Err(e) = contacts_repo::upsert_contact(
                db,
                account_id,
                &addr.address,
                addr.name.as_deref(),
                header.date,
            ) {
                eprintln!("contact upsert failed ({}): {e}", addr.address);
            }
        }
    }
}

pub fn record_sent_message(db: &Database, account_id: i64, msg: &OutgoingMessage, now: i64) {
    for address in msg.to.iter().chain(msg.cc.iter()).chain(msg.bcc.iter()) {
        if let Err(e) = contacts_repo::upsert_contact(db, account_id, address, None, now) {
            eprintln!("contact upsert failed ({address}): {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_core::account::{NewAccount, ProviderType};
    use am_protocols::imap::EnvelopeAddress;
    use am_storage::accounts_repo::insert_account;
    use am_storage::contacts_repo::suggest;

    fn header(uid: i64, to: Vec<EnvelopeAddress>, cc: Vec<EnvelopeAddress>) -> FetchedHeader {
        FetchedHeader {
            uid,
            message_id_hdr: None,
            from_address: "me@example.com".into(),
            from_name: None,
            to,
            cc,
            subject: "S".into(),
            date: 4_000,
            seen: true,
            flagged: false,
            answered: false,
            size: 0,
            in_reply_to: None,
            references: Vec::new(),
        }
    }

    fn address(addr: &str, name: Option<&str>) -> EnvelopeAddress {
        EnvelopeAddress {
            address: addr.into(),
            name: name.map(str::to_string),
        }
    }

    fn seed_account(db: &Database) -> i64 {
        insert_account(
            db,
            &NewAccount {
                email: "me@example.com".into(),
                display_name: "Me".into(),
                provider_type: ProviderType::ImapPassword,
                color: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn harvest_stores_to_and_cc_with_names() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);

        harvest_sent_headers(
            &db,
            account_id,
            &[header(
                1,
                vec![address("Jan@Firma.PL", Some("Jan Kowalski"))],
                vec![address("biuro@firma.pl", None)],
            )],
        );

        let found = suggest(&db, "jan", None, 8, 5_000).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].email, "jan@firma.pl");
        assert_eq!(found[0].name.as_deref(), Some("Jan Kowalski"));
        assert_eq!(found[0].last_contact_at, 4_000);

        assert_eq!(suggest(&db, "biuro", None, 8, 5_000).unwrap().len(), 1);
    }

    #[test]
    fn record_sent_message_stores_every_recipient_class() {
        use am_core::outgoing::OutgoingMessage;

        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);

        let msg = OutgoingMessage {
            from_address: "me@example.com".into(),
            from_name: None,
            to: vec!["Jan@Firma.PL".into()],
            cc: vec!["biuro@firma.pl".into()],
            bcc: vec!["ukryty@firma.pl".into()],
            subject: "S".into(),
            text_body: String::new(),
            html_body: None,
            in_reply_to: None,
            references: Vec::new(),
            attachments: Vec::new(),
        };

        record_sent_message(&db, account_id, &msg, 7_000);

        for email in ["jan@firma.pl", "biuro@firma.pl", "ukryty@firma.pl"] {
            let found = suggest(&db, email, None, 8, 9_000).unwrap();
            assert_eq!(found.len(), 1, "{email} should be suggested");
            assert_eq!(found[0].last_contact_at, 7_000);
        }
    }

    #[test]
    fn harvest_survives_a_malformed_address() {
        let db = Database::open_in_memory().unwrap();
        let account_id = seed_account(&db);

        harvest_sent_headers(
            &db,
            account_id,
            &[header(
                1,
                vec![address("broken", None), address("ok@firma.pl", None)],
                Vec::new(),
            )],
        );

        assert_eq!(suggest(&db, "ok@firma.pl", None, 8, 5_000).unwrap().len(), 1);
    }
}
