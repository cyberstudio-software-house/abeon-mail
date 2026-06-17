use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("authentication failed")]
    Auth,
    #[error("io error: {0}")]
    Io(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("tls error: {0}")]
    Tls(String),
}

impl From<std::io::Error> for ProtocolError {
    fn from(e: std::io::Error) -> Self {
        ProtocolError::Io(e.to_string())
    }
}

impl From<async_imap::error::Error> for ProtocolError {
    fn from(e: async_imap::error::Error) -> Self {
        match e {
            async_imap::error::Error::Io(io) => ProtocolError::Io(io.to_string()),
            async_imap::error::Error::ConnectionLost => ProtocolError::Io("connection lost".into()),
            other => ProtocolError::Protocol(other.to_string()),
        }
    }
}
