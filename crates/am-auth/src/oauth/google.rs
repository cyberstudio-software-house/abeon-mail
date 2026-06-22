use crate::oauth::OAuthError;

pub const GOOGLE_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_USERINFO_URI: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
pub const GOOGLE_SCOPES: &str = "https://mail.google.com/ openid email";

const BAKED_CLIENT_ID: Option<&str> = option_env!("ABEONMAIL_GOOGLE_CLIENT_ID");
const BAKED_CLIENT_SECRET: Option<&str> = option_env!("ABEONMAIL_GOOGLE_CLIENT_SECRET");

fn resolve_secret(runtime: Option<String>, baked: Option<&str>) -> Option<String> {
    runtime
        .filter(|v| !v.is_empty())
        .or_else(|| baked.map(str::to_string))
        .filter(|v| !v.is_empty())
}

pub fn google_client_id() -> Result<String, OAuthError> {
    resolve_secret(
        std::env::var("ABEONMAIL_GOOGLE_CLIENT_ID").ok(),
        BAKED_CLIENT_ID,
    )
    .ok_or_else(|| OAuthError::Config("ABEONMAIL_GOOGLE_CLIENT_ID not set".into()))
}

pub fn google_client_secret() -> Result<String, OAuthError> {
    resolve_secret(
        std::env::var("ABEONMAIL_GOOGLE_CLIENT_SECRET").ok(),
        BAKED_CLIENT_SECRET,
    )
    .ok_or_else(|| OAuthError::Config("ABEONMAIL_GOOGLE_CLIENT_SECRET not set".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_runtime_over_baked() {
        assert_eq!(
            resolve_secret(Some("runtime".into()), Some("baked")),
            Some("runtime".to_string())
        );
    }

    #[test]
    fn resolve_falls_back_to_baked_when_runtime_absent() {
        assert_eq!(
            resolve_secret(None, Some("baked")),
            Some("baked".to_string())
        );
    }

    #[test]
    fn resolve_ignores_empty_runtime_and_uses_baked() {
        assert_eq!(
            resolve_secret(Some(String::new()), Some("baked")),
            Some("baked".to_string())
        );
    }

    #[test]
    fn resolve_none_when_both_absent() {
        assert_eq!(resolve_secret(None, None), None);
    }
}
