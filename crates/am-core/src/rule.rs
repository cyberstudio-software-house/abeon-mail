use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    From,
    Subject,
    Recipient,
    HasAttachment,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Contains,
    Is,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleCondition {
    pub field: ConditionField,
    pub op: ConditionOp,
    pub value: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleActionKind {
    Label,
    MarkRead,
    Flag,
    Snooze,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleAction {
    pub kind: RuleActionKind,
    pub value: String,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    All,
    Any,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    pub enabled: bool,
    pub match_type: MatchType,
    pub conditions: Vec<RuleCondition>,
    pub actions: Vec<RuleAction>,
    pub position: i64,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct RuleInput {
    pub name: String,
    pub enabled: bool,
    pub match_type: MatchType,
    pub conditions: Vec<RuleCondition>,
    pub actions: Vec<RuleAction>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuleMessage {
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub recipients: Vec<String>,
    pub has_attachments: bool,
}

fn text_matches(op: ConditionOp, haystack: &str, needle: &str) -> bool {
    let h = haystack.to_lowercase();
    let n = needle.to_lowercase();
    match op {
        ConditionOp::Contains => h.contains(&n),
        ConditionOp::Is => h == n,
    }
}

fn condition_matches(cond: &RuleCondition, msg: &RuleMessage) -> bool {
    match cond.field {
        ConditionField::From => {
            text_matches(cond.op, &msg.from_address, &cond.value)
                || msg
                    .from_name
                    .as_deref()
                    .map(|name| text_matches(cond.op, name, &cond.value))
                    .unwrap_or(false)
        }
        ConditionField::Subject => text_matches(cond.op, &msg.subject, &cond.value),
        ConditionField::Recipient => msg
            .recipients
            .iter()
            .any(|r| text_matches(cond.op, r, &cond.value)),
        ConditionField::HasAttachment => {
            let want = cond.value.eq_ignore_ascii_case("true");
            msg.has_attachments == want
        }
    }
}

pub fn rule_matches(rule: &Rule, msg: &RuleMessage) -> bool {
    if rule.conditions.is_empty() {
        return false;
    }
    match rule.match_type {
        MatchType::All => rule.conditions.iter().all(|c| condition_matches(c, msg)),
        MatchType::Any => rule.conditions.iter().any(|c| condition_matches(c, msg)),
    }
}

pub fn snooze_wake_at(now: i64, value: &str) -> i64 {
    let hours = value
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|h| *h > 0)
        .unwrap_or(24);
    now + hours * 3600
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg() -> RuleMessage {
        RuleMessage {
            from_address: "alice@work.com".into(),
            from_name: Some("Alice Smith".into()),
            subject: "Quarterly Report".into(),
            recipients: vec!["team@work.com".into(), "me@home.com".into()],
            has_attachments: true,
        }
    }

    fn rule(match_type: MatchType, conditions: Vec<RuleCondition>) -> Rule {
        Rule {
            id: 1, account_id: 1, name: "r".into(), enabled: true,
            match_type, conditions, actions: vec![], position: 0,
        }
    }

    fn cond(field: ConditionField, op: ConditionOp, value: &str) -> RuleCondition {
        RuleCondition { field, op, value: value.into() }
    }

    #[test]
    fn from_matches_address_and_name_case_insensitively() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Contains, "WORK.COM")]), &msg()));
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Contains, "alice smith")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::From, ConditionOp::Is, "bob@work.com")]), &msg()));
    }

    #[test]
    fn subject_contains_and_is() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Contains, "report")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Is, "report")]), &msg()));
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Subject, ConditionOp::Is, "quarterly report")]), &msg()));
    }

    #[test]
    fn recipient_matches_any_of_to_or_cc() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Recipient, ConditionOp::Contains, "home.com")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::Recipient, ConditionOp::Contains, "nope.com")]), &msg()));
    }

    #[test]
    fn has_attachment_boolean() {
        assert!(rule_matches(&rule(MatchType::All, vec![cond(ConditionField::HasAttachment, ConditionOp::Is, "true")]), &msg()));
        assert!(!rule_matches(&rule(MatchType::All, vec![cond(ConditionField::HasAttachment, ConditionOp::Is, "false")]), &msg()));
    }

    #[test]
    fn all_requires_every_condition_any_requires_one() {
        let c = vec![
            cond(ConditionField::Subject, ConditionOp::Contains, "report"),
            cond(ConditionField::From, ConditionOp::Contains, "nobody"),
        ];
        assert!(!rule_matches(&rule(MatchType::All, c.clone()), &msg()));
        assert!(rule_matches(&rule(MatchType::Any, c), &msg()));
    }

    #[test]
    fn empty_conditions_never_match() {
        assert!(!rule_matches(&rule(MatchType::All, vec![]), &msg()));
        assert!(!rule_matches(&rule(MatchType::Any, vec![]), &msg()));
    }

    #[test]
    fn conditions_round_trip_through_json() {
        let conditions = vec![cond(ConditionField::From, ConditionOp::Is, "a@b.c")];
        let json = serde_json::to_string(&conditions).unwrap();
        let back: Vec<RuleCondition> = serde_json::from_str(&json).unwrap();
        assert_eq!(conditions, back);
    }

    #[test]
    fn action_kind_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&RuleActionKind::MarkRead).unwrap(), "\"mark_read\"");
    }

    #[test]
    fn snooze_wake_at_uses_hours_with_fallback() {
        assert_eq!(snooze_wake_at(1000, "2"), 1000 + 2 * 3600);
        assert_eq!(snooze_wake_at(1000, "bad"), 1000 + 24 * 3600);
        assert_eq!(snooze_wake_at(1000, "0"), 1000 + 24 * 3600);
    }
}
