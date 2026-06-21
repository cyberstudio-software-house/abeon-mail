use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingProvider { Teams, GoogleMeet, Zoom, Webex, Other }

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingMethod { Request, Cancel, Reply, Other }

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RsvpStatus { Accepted, Tentative, Declined }

impl RsvpStatus {
    pub fn partstat(&self) -> &'static str {
        match self { RsvpStatus::Accepted => "ACCEPTED", RsvpStatus::Tentative => "TENTATIVE", RsvpStatus::Declined => "DECLINED" }
    }
    pub fn verb(&self) -> &'static str {
        match self { RsvpStatus::Accepted => "Accepted", RsvpStatus::Tentative => "Tentative", RsvpStatus::Declined => "Declined" }
    }
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MeetingInvite {
    pub title: String,
    pub organizer: Option<String>,
    pub organizer_name: Option<String>,
    pub location: Option<String>,
    pub start_epoch: Option<i64>,
    pub end_epoch: Option<i64>,
    pub all_day: bool,
    pub join_url: Option<String>,
    pub provider: MeetingProvider,
    pub dial_in: Option<String>,
    pub method: MeetingMethod,
    pub cancelled: bool,
    pub uid: Option<String>,
    pub attendee_email: Option<String>,
    pub response: Option<RsvpStatus>,
    pub can_rsvp: bool,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct InviteReply {
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: String,
    pub subject: String,
    pub text_body: String,
    pub ics: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsvp_partstat_and_verb() {
        assert_eq!(RsvpStatus::Accepted.partstat(), "ACCEPTED");
        assert_eq!(RsvpStatus::Tentative.partstat(), "TENTATIVE");
        assert_eq!(RsvpStatus::Declined.partstat(), "DECLINED");
        assert_eq!(RsvpStatus::Accepted.verb(), "Accepted");
        assert_eq!(RsvpStatus::Declined.verb(), "Declined");
    }

    #[test]
    fn invite_roundtrips_through_json() {
        let m = MeetingInvite {
            title: "Sync".into(), organizer: Some("o@x.com".into()), organizer_name: None,
            location: None, start_epoch: Some(1), end_epoch: Some(2), all_day: false,
            join_url: None, provider: MeetingProvider::Other, dial_in: None,
            method: MeetingMethod::Request, cancelled: false, uid: Some("u".into()),
            attendee_email: None, response: None, can_rsvp: false,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: MeetingInvite = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
