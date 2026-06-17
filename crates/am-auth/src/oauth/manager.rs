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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{delete_password, store_password};
    use crate::oauth::client::TokenHttp;
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::any::Any;
    use std::collections::VecDeque;

    static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
    static INIT: std::sync::Once = std::sync::Once::new();

    fn install_in_mem_builder() {
        INIT.call_once(|| {
            *STORE.lock().unwrap() = Some(HashMap::new());
            keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
        });
    }

    struct InMemCred {
        service: String,
        user: String,
    }

    impl CredentialApi for InMemCred {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            let pw = String::from_utf8(secret.to_vec())
                .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
            STORE
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .insert((self.service.clone(), self.user.clone()), pw);
            Ok(())
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            STORE
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .get(&(self.service.clone(), self.user.clone()))
                .map(|s| s.as_bytes().to_vec())
                .ok_or(keyring::Error::NoEntry)
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            STORE
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .remove(&(self.service.clone(), self.user.clone()))
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    struct InMemCredBuilder;

    impl CredentialBuilderApi for InMemCredBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(InMemCred {
                service: service.to_string(),
                user: user.to_string(),
            }))
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::ProcessOnly
        }
    }

    struct FakeHttp {
        calls: Mutex<u32>,
        responses: Mutex<VecDeque<(u16, String)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self {
                calls: Mutex::new(0),
                responses: Mutex::new(responses.into()),
            }
        }
        fn call_count(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    #[async_trait::async_trait]
    impl TokenHttp for FakeHttp {
        async fn post_form(
            &self,
            _url: &str,
            _form: &[(&str, &str)],
        ) -> Result<(u16, String), OAuthError> {
            *self.calls.lock().unwrap() += 1;
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more responses".into()))
        }
        async fn get_bearer(
            &self,
            _url: &str,
            _access_token: &str,
        ) -> Result<(u16, String), OAuthError> {
            *self.calls.lock().unwrap() += 1;
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more responses".into()))
        }
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[tokio::test]
    async fn cached_not_expired_returns_without_http_call() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let http = Arc::new(FakeHttp::new(vec![]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let now = 1_700_000_000i64;
        let tokens = OAuthTokens {
            access_token: "CACHED_TOKEN".into(),
            refresh_token: Some("REF".into()),
            expires_at: now + 3600,
        };
        mgr.seed("ref@manager.test", &tokens);

        let result = mgr.valid_access_token("ref@manager.test", "client", now).await.unwrap();
        assert_eq!(result, "CACHED_TOKEN");
        assert_eq!(http.call_count(), 0);
    }

    #[tokio::test]
    async fn expired_triggers_refresh_from_keychain() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let auth_ref = "expired@manager.test";
        let _ = delete_password(auth_ref);
        store_password(auth_ref, "my_refresh_token").unwrap();

        let now = 1_700_000_000i64;
        let body = r#"{"access_token":"NEW_TOKEN","expires_in":3600}"#;
        let http = Arc::new(FakeHttp::new(vec![(200, body.into())]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let old = OAuthTokens {
            access_token: "OLD".into(),
            refresh_token: None,
            expires_at: now + 100,
        };
        mgr.seed(auth_ref, &old);

        let result = mgr.valid_access_token(auth_ref, "client", now).await.unwrap();
        assert_eq!(result, "NEW_TOKEN");
        assert_eq!(http.call_count(), 1);

        let _ = delete_password(auth_ref);
    }

    #[tokio::test]
    async fn invalid_grant_propagates() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();

        let auth_ref = "revoked@manager.test";
        let _ = delete_password(auth_ref);
        store_password(auth_ref, "revoked_token").unwrap();

        let now = 1_700_000_000i64;
        let body = r#"{"error":"invalid_grant"}"#;
        let http = Arc::new(FakeHttp::new(vec![(400, body.into())]));
        let mgr = OAuthTokenManager::new(Arc::clone(&http) as Arc<dyn TokenHttp>);

        let old = OAuthTokens {
            access_token: "OLD".into(),
            refresh_token: None,
            expires_at: now + 100,
        };
        mgr.seed(auth_ref, &old);

        let result = mgr.valid_access_token(auth_ref, "client", now).await;
        assert!(matches!(result, Err(OAuthError::InvalidGrant)));

        let _ = delete_password(auth_ref);
    }
}
