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

pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .expect("failed to build reqwest client");
        Self { client }
    }
}

impl Default for ReqwestHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl TokenHttp for ReqwestHttp {
    async fn post_form(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, String), OAuthError> {
        let resp = self
            .client
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        Ok((status, body))
    }

    async fn get_bearer(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<(u16, String), OAuthError> {
        let resp = self
            .client
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| OAuthError::Network(e.to_string()))?;
        Ok((status, body))
    }
}

pub async fn exchange_code(
    http: &dyn TokenHttp,
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, OAuthError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    exchange_code_with_now(http, client_id, client_secret, code, verifier, redirect_uri, now).await
}

pub(crate) async fn exchange_code_with_now(
    http: &dyn TokenHttp,
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    now: i64,
) -> Result<OAuthTokens, OAuthError> {
    use crate::oauth::google::GOOGLE_TOKEN_URI;
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    let (status, body) = http.post_form(GOOGLE_TOKEN_URI, &form).await?;
    parse_token_response(status, &body, now)
}

pub async fn refresh_tokens(
    http: &dyn TokenHttp,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<OAuthTokens, OAuthError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    use crate::oauth::google::GOOGLE_TOKEN_URI;
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
    ];
    let (status, body) = http.post_form(GOOGLE_TOKEN_URI, &form).await?;
    parse_token_response(status, &body, now)
}

pub async fn fetch_email(
    http: &dyn TokenHttp,
    access_token: &str,
) -> Result<String, OAuthError> {
    use crate::oauth::google::GOOGLE_USERINFO_URI;
    let (status, body) = http.get_bearer(GOOGLE_USERINFO_URI, access_token).await?;
    if status != 200 {
        return Err(OAuthError::Network(format!("userinfo status {status}")));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| OAuthError::Network(e.to_string()))?;
    v["email"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| OAuthError::Network("no email field in userinfo".into()))
}

fn parse_token_response(status: u16, body: &str, now: i64) -> Result<OAuthTokens, OAuthError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| OAuthError::Network(e.to_string()))?;

    if status != 200 {
        let err = v["error"].as_str().unwrap_or("");
        if err == "invalid_grant" {
            return Err(OAuthError::InvalidGrant);
        }
        return Err(OAuthError::Network(format!("token endpoint status {status}: {err}")));
    }

    let access_token = v["access_token"]
        .as_str()
        .ok_or_else(|| OAuthError::Network("missing access_token".into()))?
        .to_string();
    let refresh_token = v["refresh_token"].as_str().map(|s| s.to_string());
    let expires_in = v["expires_in"].as_i64().unwrap_or(3600);
    let expires_at = now + expires_in;

    Ok(OAuthTokens { access_token, refresh_token, expires_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHttp {
        responses: std::sync::Mutex<std::collections::VecDeque<(u16, String)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, String)>) -> Self {
            Self { responses: std::sync::Mutex::new(responses.into()) }
        }
    }

    #[async_trait::async_trait]
    impl TokenHttp for FakeHttp {
        async fn post_form(
            &self,
            _url: &str,
            _form: &[(&str, &str)],
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }

        async fn get_bearer(
            &self,
            _url: &str,
            _access_token: &str,
        ) -> Result<(u16, String), OAuthError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| OAuthError::Network("no more fake responses".into()))
        }
    }

    #[tokio::test]
    async fn exchange_code_parses_tokens() {
        let now = 1_700_000_000i64;
        let body = r#"{"access_token":"ACC","refresh_token":"REF","expires_in":3600}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let tokens = exchange_code_with_now(
            &http,
            "client_id",
            "client_secret",
            "code_xyz",
            "verifier_abc",
            "http://127.0.0.1:9999",
            now,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "ACC");
        assert_eq!(tokens.refresh_token.as_deref(), Some("REF"));
        assert_eq!(tokens.expires_at, now + 3600);
    }

    #[tokio::test]
    async fn refresh_invalid_grant_maps_to_error() {
        let body = r#"{"error":"invalid_grant"}"#;
        let http = FakeHttp::new(vec![(400, body.into())]);
        let result = refresh_tokens(&http, "client_id", "client_secret", "bad_refresh").await;
        assert!(matches!(result, Err(OAuthError::InvalidGrant)));
    }

    #[tokio::test]
    async fn fetch_email_parses_userinfo() {
        let body = r#"{"email":"user@gmail.com","sub":"12345"}"#;
        let http = FakeHttp::new(vec![(200, body.into())]);
        let email = fetch_email(&http, "some_access_token").await.unwrap();
        assert_eq!(email, "user@gmail.com");
    }
}
