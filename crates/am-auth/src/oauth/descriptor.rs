use crate::oauth::client::{OAuthTokens, TokenHttp};
use crate::oauth::google;
use crate::oauth::microsoft;
use crate::oauth::OAuthError;

#[derive(Clone, Debug)]
pub enum EmailSource {
    Userinfo(&'static str),
    IdTokenClaim,
}

#[derive(Clone, Debug)]
pub struct OAuthProvider {
    pub auth_uri: &'static str,
    pub token_uri: &'static str,
    pub scopes: &'static str,
    pub extra_auth_params: &'static str,
    pub uses_client_secret: bool,
    pub email_source: EmailSource,
}

impl OAuthProvider {
    pub fn google() -> Self {
        Self {
            auth_uri: google::GOOGLE_AUTH_URI,
            token_uri: google::GOOGLE_TOKEN_URI,
            scopes: google::GOOGLE_SCOPES,
            extra_auth_params: "access_type=offline&prompt=consent",
            uses_client_secret: true,
            email_source: EmailSource::Userinfo(google::GOOGLE_USERINFO_URI),
        }
    }

    pub fn microsoft() -> Self {
        Self {
            auth_uri: microsoft::MICROSOFT_AUTH_URI,
            token_uri: microsoft::MICROSOFT_TOKEN_URI,
            scopes: microsoft::MICROSOFT_SCOPES,
            extra_auth_params: "prompt=select_account",
            uses_client_secret: false,
            email_source: EmailSource::IdTokenClaim,
        }
    }
}

pub async fn resolve_email(
    http: &dyn TokenHttp,
    provider: &OAuthProvider,
    tokens: &OAuthTokens,
) -> Result<String, OAuthError> {
    match provider.email_source {
        EmailSource::Userinfo(uri) => {
            crate::oauth::client::fetch_email(http, uri, &tokens.access_token).await
        }
        EmailSource::IdTokenClaim => {
            let id_token = tokens
                .id_token
                .as_deref()
                .ok_or_else(|| OAuthError::Network("no id_token returned for email lookup".into()))?;
            crate::oauth::client::email_from_id_token(id_token)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::client::{OAuthTokens, TokenHttp};
    use crate::oauth::OAuthError;

    struct ExplodingHttp;

    #[async_trait::async_trait]
    impl TokenHttp for ExplodingHttp {
        async fn post_form(&self, _u: &str, _f: &[(&str, &str)]) -> Result<(u16, String), OAuthError> {
            Err(OAuthError::Network("network must not be used".into()))
        }
        async fn get_bearer(&self, _u: &str, _t: &str) -> Result<(u16, String), OAuthError> {
            Err(OAuthError::Network("network must not be used".into()))
        }
    }

    #[tokio::test]
    async fn resolve_email_uses_id_token_for_microsoft_without_network() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"user@outlook.com"}"#);
        let tokens = OAuthTokens {
            access_token: "A".into(),
            refresh_token: None,
            id_token: Some(format!("e30.{payload}.sig")),
            expires_at: 0,
        };
        let email = resolve_email(&ExplodingHttp, &OAuthProvider::microsoft(), &tokens)
            .await
            .unwrap();
        assert_eq!(email, "user@outlook.com");
    }

    #[test]
    fn google_descriptor_uses_client_secret_and_userinfo() {
        let p = OAuthProvider::google();
        assert_eq!(p.token_uri, crate::oauth::google::GOOGLE_TOKEN_URI);
        assert_eq!(p.auth_uri, crate::oauth::google::GOOGLE_AUTH_URI);
        assert!(p.uses_client_secret);
        assert!(matches!(p.email_source, EmailSource::Userinfo(_)));
        assert!(p.extra_auth_params.contains("access_type=offline"));
    }

    #[test]
    fn microsoft_descriptor_is_public_client_with_id_token_email() {
        let p = OAuthProvider::microsoft();
        assert_eq!(p.token_uri, crate::oauth::microsoft::MICROSOFT_TOKEN_URI);
        assert_eq!(p.auth_uri, crate::oauth::microsoft::MICROSOFT_AUTH_URI);
        assert!(!p.uses_client_secret);
        assert!(matches!(p.email_source, EmailSource::IdTokenClaim));
        assert!(p.scopes.contains("IMAP.AccessAsUser.All"));
        assert!(p.scopes.contains("offline_access"));
    }
}
