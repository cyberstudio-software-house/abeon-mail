use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Type, Clone, Debug, PartialEq)]
pub struct Endpoints {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_tls: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_tls: bool,
}

pub fn microsoft() -> Endpoints {
    Endpoints {
        imap_host: "outlook.office365.com".into(),
        imap_port: 993,
        imap_tls: true,
        smtp_host: "smtp.office365.com".into(),
        smtp_port: 587,
        smtp_tls: true,
    }
}

pub fn resolve(email: &str) -> Endpoints {
    let domain = email
        .split('@')
        .nth(1)
        .unwrap_or(email)
        .to_lowercase();

    match domain.as_str() {
        "gmail.com" | "googlemail.com" => Endpoints {
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
            imap_tls: true,
            smtp_host: "smtp.gmail.com".into(),
            smtp_port: 465,
            smtp_tls: true,
        },
        "icloud.com" | "me.com" | "mac.com" => Endpoints {
            imap_host: "imap.mail.me.com".into(),
            imap_port: 993,
            imap_tls: true,
            smtp_host: "smtp.mail.me.com".into(),
            smtp_port: 587,
            smtp_tls: true,
        },
        "outlook.com" | "hotmail.com" | "live.com" => microsoft(),
        _ => Endpoints {
            imap_host: format!("imap.{domain}"),
            imap_port: 993,
            imap_tls: true,
            smtp_host: format!("smtp.{domain}"),
            smtp_port: 465,
            smtp_tls: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_gmail() {
        let ep = resolve("user@gmail.com");
        assert_eq!(ep.imap_host, "imap.gmail.com");
        assert_eq!(ep.imap_port, 993);
        assert!(ep.imap_tls);
        assert_eq!(ep.smtp_host, "smtp.gmail.com");
        assert_eq!(ep.smtp_port, 465);
        assert!(ep.smtp_tls);
    }

    #[test]
    fn microsoft_endpoints_use_office365() {
        let ep = microsoft();
        assert_eq!(ep.imap_host, "outlook.office365.com");
        assert_eq!(ep.imap_port, 993);
        assert!(ep.imap_tls);
        assert_eq!(ep.smtp_host, "smtp.office365.com");
        assert_eq!(ep.smtp_port, 587);
        assert!(ep.smtp_tls);
    }

    #[test]
    fn resolve_outlook_matches_microsoft_helper() {
        assert_eq!(resolve("user@outlook.com"), microsoft());
        assert_eq!(resolve("user@hotmail.com"), microsoft());
    }

    #[test]
    fn resolve_unknown_domain() {
        let ep = resolve("user@unknown-domain.example");
        assert_eq!(ep.imap_host, "imap.unknown-domain.example");
        assert_eq!(ep.imap_port, 993);
        assert!(ep.imap_tls);
        assert_eq!(ep.smtp_host, "smtp.unknown-domain.example");
        assert_eq!(ep.smtp_port, 465);
        assert!(ep.smtp_tls);
    }
}
