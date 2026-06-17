use crate::oauth::OAuthError;

#[derive(Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[async_trait::async_trait]
pub trait TokenHttp: Send + Sync {
    async fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, String), OAuthError>;
    async fn get_bearer(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<(u16, String), OAuthError>;
}

pub async fn refresh_tokens(
    _http: &dyn TokenHttp,
    _client_id: &str,
    _refresh_token: &str,
) -> Result<OAuthTokens, OAuthError> {
    Err(OAuthError::Network("not implemented".into()))
}
