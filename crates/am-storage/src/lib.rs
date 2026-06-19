mod db;
pub mod accounts_repo;
pub mod attachments_repo;
pub mod drafts_repo;
pub mod folders_repo;
pub mod labels_repo;
pub mod messages_repo;
pub mod queue_repo;
pub mod search_repo;
pub mod settings_repo;
pub mod signatures_repo;
pub mod smart_repo;
pub mod snooze_repo;
pub mod threads_repo;

pub use db::{Database, StorageError};
