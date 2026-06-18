use std::sync::Arc;

use am_core::account::{Account, ProviderType};
use am_protocols::imap::ImapAuth;
use am_protocols::smtp::SmtpAuth;

use crate::service::SyncError;

#[derive(Clone)]
pub enum AccountAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl AccountAuth {
    pub fn to_imap(&self) -> ImapAuth {
        match self {
            AccountAuth::Password(pw) => ImapAuth::Password(pw.clone()),
            AccountAuth::XOauth2 { user, access_token } => ImapAuth::XOauth2 {
                user: user.clone(),
                access_token: access_token.clone(),
            },
        }
    }

    pub fn to_smtp(&self) -> SmtpAuth {
        match self {
            AccountAuth::Password(pw) => SmtpAuth::Password(pw.clone()),
            AccountAuth::XOauth2 { user, access_token } => SmtpAuth::XOauth2 {
                user: user.clone(),
                access_token: access_token.clone(),
            },
        }
    }
}

#[async_trait::async_trait]
pub trait CredentialSource: Send + Sync {
    async fn auth_for(&self, account: &Account) -> Result<AccountAuth, SyncError>;
}

pub struct KeychainCredentialSource {
    token_manager: am_auth::oauth::manager::OAuthTokenManager,
    client_id: Option<String>,
    client_secret: Option<String>,
}

impl KeychainCredentialSource {
    pub fn new() -> Arc<Self> {
        let http = Arc::new(am_auth::oauth::client::ReqwestHttp::new());
        let token_manager =
            am_auth::oauth::manager::OAuthTokenManager::new(http as Arc<dyn am_auth::oauth::TokenHttp>);
        let client_id = std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID").ok();
        let client_secret = std::env::var("ABEONMAIL_GOOGLE_CLIENT_SECRET").ok();
        Arc::new(Self { token_manager, client_id, client_secret })
    }

    pub fn token_manager(&self) -> &am_auth::oauth::manager::OAuthTokenManager {
        &self.token_manager
    }
}

impl Default for KeychainCredentialSource {
    fn default() -> Self {
        let http = Arc::new(am_auth::oauth::client::ReqwestHttp::new());
        let token_manager =
            am_auth::oauth::manager::OAuthTokenManager::new(http as Arc<dyn am_auth::oauth::TokenHttp>);
        let client_id = std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID").ok();
        let client_secret = std::env::var("ABEONMAIL_GOOGLE_CLIENT_SECRET").ok();
        Self { token_manager, client_id, client_secret }
    }
}

#[async_trait::async_trait]
impl CredentialSource for KeychainCredentialSource {
    async fn auth_for(&self, account: &Account) -> Result<AccountAuth, SyncError> {
        match account.provider_type {
            ProviderType::ImapPassword => {
                let pw = am_auth::credentials::load_password(&account.email)?;
                Ok(AccountAuth::Password(pw))
            }
            ProviderType::GoogleOauth => {
                let client_id = self
                    .client_id
                    .as_deref()
                    .ok_or(SyncError::Auth)?;
                let client_secret = self
                    .client_secret
                    .as_deref()
                    .ok_or(SyncError::Auth)?;
                let now = crate::service::now_secs();
                let token = self
                    .token_manager
                    .valid_access_token(&account.email, client_id, client_secret, now)
                    .await
                    .map_err(SyncError::from)?;
                Ok(AccountAuth::XOauth2 {
                    user: account.email.clone(),
                    access_token: token,
                })
            }
        }
    }
}

pub struct PasswordCreds(pub String);

#[async_trait::async_trait]
impl CredentialSource for PasswordCreds {
    async fn auth_for(&self, _account: &Account) -> Result<AccountAuth, SyncError> {
        Ok(AccountAuth::Password(self.0.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_account(provider: ProviderType) -> Account {
        Account {
            id: 1,
            email: "test@example.com".into(),
            display_name: "Test".into(),
            provider_type: provider,
            color: None,
            position: 0,
            requires_reauth: false,
        }
    }

    struct FakeCreds {
        auth: AccountAuth,
    }

    #[async_trait::async_trait]
    impl CredentialSource for FakeCreds {
        async fn auth_for(&self, _account: &Account) -> Result<AccountAuth, SyncError> {
            Ok(self.auth.clone())
        }
    }

    #[tokio::test]
    async fn fake_creds_returns_password() {
        let creds = FakeCreds { auth: AccountAuth::Password("pw".into()) };
        let account = fake_account(ProviderType::ImapPassword);
        let auth = creds.auth_for(&account).await.unwrap();
        assert!(matches!(auth, AccountAuth::Password(_)));
    }

    #[tokio::test]
    async fn fake_creds_returns_xoauth2() {
        let creds = FakeCreds {
            auth: AccountAuth::XOauth2 {
                user: "u@g.com".into(),
                access_token: "tok".into(),
            },
        };
        let account = fake_account(ProviderType::GoogleOauth);
        let auth = creds.auth_for(&account).await.unwrap();
        assert!(matches!(auth, AccountAuth::XOauth2 { .. }));
    }

    #[test]
    fn account_auth_to_imap_password() {
        let a = AccountAuth::Password("pw".into());
        assert!(matches!(a.to_imap(), ImapAuth::Password(_)));
    }

    #[test]
    fn account_auth_to_smtp_xoauth2() {
        let a = AccountAuth::XOauth2 {
            user: "u@g.com".into(),
            access_token: "tok".into(),
        };
        let s = a.to_smtp();
        assert!(matches!(s, SmtpAuth::XOauth2 { .. }));
    }

    #[test]
    fn oauth_error_invalid_grant_maps_to_needs_reauth() {
        let err = am_auth::oauth::OAuthError::InvalidGrant;
        let sync_err = SyncError::from(err);
        assert!(matches!(sync_err, SyncError::NeedsReauth));
    }

    #[test]
    fn oauth_error_keychain_maps_to_keychain() {
        let err = am_auth::oauth::OAuthError::Keychain;
        let sync_err = SyncError::from(err);
        assert!(matches!(sync_err, SyncError::Keychain));
    }

    #[test]
    fn oauth_error_network_maps_to_protocol() {
        let err = am_auth::oauth::OAuthError::Network("timeout".into());
        let sync_err = SyncError::from(err);
        assert!(matches!(sync_err, SyncError::Protocol(_)));
    }
}
