use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    ImapPassword,
    GoogleOauth,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub provider_type: ProviderType,
    pub color: Option<String>,
    pub position: i64,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct NewAccount {
    pub email: String,
    pub display_name: String,
    pub provider_type: ProviderType,
    pub color: Option<String>,
}

impl ProviderType {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            ProviderType::ImapPassword => "imap_password",
            ProviderType::GoogleOauth => "google_oauth",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "imap_password" => Some(ProviderType::ImapPassword),
            "google_oauth" => Some(ProviderType::GoogleOauth),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_roundtrips_through_json() {
        let account = Account {
            id: 1,
            email: "a@example.com".into(),
            display_name: "A".into(),
            provider_type: ProviderType::ImapPassword,
            color: Some("#4f46e5".into()),
            position: 0,
        };
        let json = serde_json::to_string(&account).unwrap();
        let back: Account = serde_json::from_str(&json).unwrap();
        assert_eq!(account, back);
    }

    #[test]
    fn provider_type_google_oauth_serializes_as_snake_case() {
        let json = serde_json::to_string(&ProviderType::GoogleOauth).unwrap();
        assert_eq!(json, "\"google_oauth\"");
    }

    #[test]
    fn provider_type_db_str_round_trips() {
        assert_eq!(ProviderType::ImapPassword.as_db_str(), "imap_password");
        assert_eq!(ProviderType::GoogleOauth.as_db_str(), "google_oauth");
        assert_eq!(
            ProviderType::from_db_str(ProviderType::ImapPassword.as_db_str()),
            Some(ProviderType::ImapPassword)
        );
        assert_eq!(
            ProviderType::from_db_str(ProviderType::GoogleOauth.as_db_str()),
            Some(ProviderType::GoogleOauth)
        );
        assert_eq!(ProviderType::from_db_str("bogus"), None);
    }
}
