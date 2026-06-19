#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedQuery {
    pub fts_match: Option<String>,
    pub require_attachment: bool,
}

fn escape_term(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    format!("\"{escaped}\"*")
}

pub fn parse_query(raw: &str) -> ParsedQuery {
    let mut clauses: Vec<String> = Vec::new();
    let mut require_attachment = false;

    for token in raw.split_whitespace() {
        match token.split_once(':') {
            Some((key, value)) => {
                let key_lower = key.to_ascii_lowercase();
                match key_lower.as_str() {
                    "from" => {
                        if !value.is_empty() {
                            clauses.push(format!("from_address : {}", escape_term(value)));
                        }
                    }
                    "to" => {
                        if !value.is_empty() {
                            clauses.push(format!("to_addresses : {}", escape_term(value)));
                        }
                    }
                    "subject" => {
                        if !value.is_empty() {
                            clauses.push(format!("subject : {}", escape_term(value)));
                        }
                    }
                    "has" => {
                        if value.eq_ignore_ascii_case("attachment") {
                            require_attachment = true;
                        }
                    }
                    _ => clauses.push(escape_term(token)),
                }
            }
            None => clauses.push(escape_term(token)),
        }
    }

    let fts_match = if clauses.is_empty() {
        None
    } else {
        Some(clauses.join(" AND "))
    };

    ParsedQuery {
        fts_match,
        require_attachment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_term_is_quoted_and_prefixed() {
        let p = parse_query("report");
        assert_eq!(p.fts_match.as_deref(), Some("\"report\"*"));
        assert!(!p.require_attachment);
    }

    #[test]
    fn multiple_terms_joined_with_and() {
        let p = parse_query("quarterly report");
        assert_eq!(p.fts_match.as_deref(), Some("\"quarterly\"* AND \"report\"*"));
    }

    #[test]
    fn from_to_subject_map_to_columns() {
        let p = parse_query("from:alice to:bob subject:budget");
        assert_eq!(
            p.fts_match.as_deref(),
            Some("from_address : \"alice\"* AND to_addresses : \"bob\"* AND subject : \"budget\"*")
        );
    }

    #[test]
    fn operator_keys_are_case_insensitive() {
        let p = parse_query("From:Alice");
        assert_eq!(p.fts_match.as_deref(), Some("from_address : \"Alice\"*"));
    }

    #[test]
    fn has_attachment_sets_flag_without_clause() {
        let p = parse_query("has:attachment");
        assert_eq!(p.fts_match, None);
        assert!(p.require_attachment);
    }

    #[test]
    fn has_attachment_combines_with_terms() {
        let p = parse_query("invoice has:attachment");
        assert_eq!(p.fts_match.as_deref(), Some("\"invoice\"*"));
        assert!(p.require_attachment);
    }

    #[test]
    fn empty_or_whitespace_yields_none() {
        assert_eq!(parse_query(""), ParsedQuery::default());
        assert_eq!(parse_query("   \t "), ParsedQuery::default());
    }

    #[test]
    fn empty_value_operator_is_skipped() {
        let p = parse_query("from:");
        assert_eq!(p, ParsedQuery::default());
    }

    #[test]
    fn embedded_double_quote_is_escaped() {
        let p = parse_query("a\"b");
        assert_eq!(p.fts_match.as_deref(), Some("\"a\"\"b\"*"));
    }

    #[test]
    fn unknown_operator_is_treated_as_free_term() {
        let p = parse_query("foo:bar");
        assert_eq!(p.fts_match.as_deref(), Some("\"foo:bar\"*"));
    }

    #[test]
    fn has_with_other_value_is_ignored() {
        let p = parse_query("has:something");
        assert_eq!(p, ParsedQuery::default());
    }
}
