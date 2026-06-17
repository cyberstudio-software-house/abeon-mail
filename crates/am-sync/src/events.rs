#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEvent {
    Progress { account_id: i64, folder_id: i64, fetched: i64, total: i64 },
    NewMessages { account_id: i64, folder_id: i64, count: i64 },
    MailboxChanged { account_id: i64, folder_id: i64 },
}

pub trait SyncEventSink: Send + Sync {
    fn emit(&self, event: SyncEvent);
}

#[derive(Default)]
pub struct NoopSink;

impl SyncEventSink for NoopSink {
    fn emit(&self, _event: SyncEvent) {}
}

#[cfg(test)]
pub struct RecordingSink {
    pub events: std::sync::Mutex<Vec<SyncEvent>>,
}

#[cfg(test)]
impl RecordingSink {
    pub fn new() -> Self {
        Self { events: std::sync::Mutex::new(Vec::new()) }
    }
}

#[cfg(test)]
impl SyncEventSink for RecordingSink {
    fn emit(&self, event: SyncEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_sink_collects_events() {
        let sink = RecordingSink::new();
        sink.emit(SyncEvent::MailboxChanged { account_id: 1, folder_id: 2 });
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }
}
