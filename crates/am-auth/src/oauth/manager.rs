use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::oauth::{OAuthError, OAuthTokens, TokenHttp};

pub struct OAuthTokenManager {
    cache: Mutex<HashMap<String, OAuthTokens>>,
    http: Arc<dyn TokenHttp>,
}

impl OAuthTokenManager {
    pub fn new(http: Arc<dyn TokenHttp>) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            http,
        }
    }

    pub fn seed(&self, auth_ref: &str, tokens: &OAuthTokens) {
        let mut guard = self.cache.lock().unwrap();
        guard.insert(auth_ref.to_string(), tokens.clone());
    }

    pub async fn valid_access_token(
        &self,
        auth_ref: &str,
        client_id: &str,
        now: i64,
    ) -> Result<String, OAuthError> {
        {
            let guard = self.cache.lock().unwrap();
            if let Some(cached) = guard.get(auth_ref) {
                if cached.expires_at - now > 300 {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let refresh_token = crate::credentials::load_password(auth_ref)
            .map_err(|_| OAuthError::Keychain)?;

        let new_tokens =
            crate::oauth::client::refresh_tokens(self.http.as_ref(), client_id, &refresh_token)
                .await?;

        {
            let mut guard = self.cache.lock().unwrap();
            guard.insert(auth_ref.to_string(), new_tokens.clone());
        }

        Ok(new_tokens.access_token)
    }
}
