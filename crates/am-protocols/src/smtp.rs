use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine};
use lettre::address::Envelope;
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{Address, AsyncTransport, Tokio1Executor};

use crate::error::ProtocolError;

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
}

#[derive(Clone)]
pub enum SmtpAuth {
    Password(String),
    XOauth2 { user: String, access_token: String },
}

impl std::fmt::Debug for SmtpAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SmtpAuth::Password(_) => f.write_str("SmtpAuth::Password(***)"),
            SmtpAuth::XOauth2 { user, .. } => {
                write!(f, "SmtpAuth::XOauth2 {{ user: {user:?}, access_token: *** }}")
            }
        }
    }
}

pub async fn send_raw(
    config: &SmtpConfig,
    auth: &SmtpAuth,
    from: &str,
    recipients: &[String],
    bytes: &[u8],
) -> Result<(), ProtocolError> {
    let from_addr =
        Address::from_str(from).map_err(|e| ProtocolError::Protocol(e.to_string()))?;
    let mut to_addrs = Vec::with_capacity(recipients.len());
    for r in recipients {
        to_addrs.push(Address::from_str(r).map_err(|e| ProtocolError::Protocol(e.to_string()))?);
    }
    let envelope = Envelope::new(Some(from_addr), to_addrs)
        .map_err(|e| ProtocolError::Protocol(e.to_string()))?;

    let builder = if !config.tls {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
    } else if config.port == 587 {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            .map_err(|e| ProtocolError::Tls(e.to_string()))?
    };

    let transport = match auth {
        SmtpAuth::Password(pw) => builder
            .port(config.port)
            .credentials(Credentials::new(config.username.clone(), pw.clone()))
            .build(),
        SmtpAuth::XOauth2 { user, access_token } => {
            let raw = format!("user={user}\x01auth=Bearer {access_token}\x01\x01");
            let _sasl = STANDARD.encode(raw.as_bytes());
            builder
                .port(config.port)
                .authentication(vec![Mechanism::Xoauth2])
                .credentials(Credentials::new(user.clone(), access_token.clone()))
                .build()
        }
    };

    transport
        .send_raw(&envelope, bytes)
        .await
        .map(|_| ())
        .map_err(|e| ProtocolError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xoauth2_sasl_format_is_correct() {
        let user = "user@gmail.com";
        let token = "ya29.some_token";
        let raw = format!("user={user}\x01auth=Bearer {token}\x01\x01");
        let encoded = STANDARD.encode(raw.as_bytes());
        let decoded = String::from_utf8(STANDARD.decode(&encoded).unwrap()).unwrap();
        assert_eq!(decoded, "user=user@gmail.com\x01auth=Bearer ya29.some_token\x01\x01");
    }

    #[test]
    fn smtp_auth_debug_redacts_password() {
        let auth = SmtpAuth::Password("secret123".into());
        let debug = format!("{auth:?}");
        assert!(!debug.contains("secret123"));
        assert!(debug.contains("***"));
    }

    #[test]
    fn smtp_auth_debug_redacts_token() {
        let auth = SmtpAuth::XOauth2 {
            user: "u@g.com".into(),
            access_token: "tok123".into(),
        };
        let debug = format!("{auth:?}");
        assert!(!debug.contains("tok123"));
        assert!(debug.contains("u@g.com"));
    }
}
