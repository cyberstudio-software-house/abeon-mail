use std::str::FromStr;

use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{Address, AsyncTransport, Tokio1Executor};

use crate::error::ProtocolError;

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
}

pub async fn send_raw(
    config: &SmtpConfig,
    password: &str,
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
    let transport = builder
        .port(config.port)
        .credentials(Credentials::new(config.username.clone(), password.to_string()))
        .build();

    transport
        .send_raw(&envelope, bytes)
        .await
        .map(|_| ())
        .map_err(|e| ProtocolError::Protocol(e.to_string()))
}
