#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("not found")]
    NotFound,
    #[error("invalid input: {0}")]
    InvalidInput(String),
}
