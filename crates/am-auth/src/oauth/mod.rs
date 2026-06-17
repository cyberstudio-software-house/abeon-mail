pub mod client;
pub mod google;
pub mod manager;
pub mod pkce;

pub use client::{OAuthTokens, TokenHttp};

#[derive(thiserror::Error, Debug)]
pub enum OAuthError {
    #[error("oauth config error: {0}")]
    Config(String),
    #[error("oauth network error: {0}")]
    Network(String),
    #[error("oauth consent revoked")]
    InvalidGrant,
    #[error("oauth keychain error")]
    Keychain,
}
