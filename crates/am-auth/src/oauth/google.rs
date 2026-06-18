use crate::oauth::OAuthError;

pub const GOOGLE_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_USERINFO_URI: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
pub const GOOGLE_SCOPES: &str = "https://mail.google.com/ openid email";

pub fn google_client_id() -> Result<String, OAuthError> {
    std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID")
        .map_err(|_| OAuthError::Config("ABEONMAIL_GOOGLE_CLIENT_ID not set".into()))
}

pub fn google_client_secret() -> Result<String, OAuthError> {
    std::env::var("ABEONMAIL_GOOGLE_CLIENT_SECRET")
        .map_err(|_| OAuthError::Config("ABEONMAIL_GOOGLE_CLIENT_SECRET not set".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_client_id_reads_env_then_missing() {
        std::env::set_var("ABEONMAIL_GOOGLE_CLIENT_ID", "test-client-id-123");
        let id = google_client_id().unwrap();
        assert_eq!(id, "test-client-id-123");

        std::env::remove_var("ABEONMAIL_GOOGLE_CLIENT_ID");
        let result = google_client_id();
        assert!(matches!(result, Err(OAuthError::Config(_))));
    }
}
