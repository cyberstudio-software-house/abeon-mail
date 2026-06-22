use crate::oauth::OAuthError;

pub const MICROSOFT_AUTH_URI: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
pub const MICROSOFT_TOKEN_URI: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/token";
pub const MICROSOFT_SCOPES: &str = "https://outlook.office.com/IMAP.AccessAsUser.All \
     https://outlook.office.com/SMTP.Send offline_access openid email";

const BAKED_CLIENT_ID: Option<&str> = option_env!("ABEONMAIL_MICROSOFT_CLIENT_ID");

pub fn microsoft_client_id() -> Result<String, OAuthError> {
    std::env::var("ABEONMAIL_MICROSOFT_CLIENT_ID")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| BAKED_CLIENT_ID.map(str::to_string))
        .filter(|v| !v.is_empty())
        .ok_or_else(|| OAuthError::Config("ABEONMAIL_MICROSOFT_CLIENT_ID not set".into()))
}
