pub mod credentials;
pub mod endpoints;
pub mod oauth;
pub mod provider;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("credential not found")]
    NotFound,
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AuthError::NotFound,
            other => AuthError::Keychain(other.to_string()),
        }
    }
}
