use std::collections::HashSet;

pub fn is_enabled(value: Option<String>) -> bool {
    matches!(value.as_deref(), Some("true"))
}

pub fn parse_folder_ids(value: Option<String>) -> Vec<i64> {
    match value {
        Some(s) => serde_json::from_str::<Vec<i64>>(&s).unwrap_or_default(),
        None => Vec::new(),
    }
}

pub fn missing_uids(local: &[i64], server: &[i64]) -> Vec<i64> {
    let local_set: HashSet<i64> = local.iter().copied().collect();
    server.iter().copied().filter(|u| !local_set.contains(u)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_enabled_only_true_string() {
        assert!(is_enabled(Some("true".into())));
        assert!(!is_enabled(Some("false".into())));
        assert!(!is_enabled(Some("1".into())));
        assert!(!is_enabled(None));
    }

    #[test]
    fn parse_folder_ids_handles_valid_junk_and_none() {
        assert_eq!(parse_folder_ids(Some("[3,7]".into())), vec![3, 7]);
        assert_eq!(parse_folder_ids(Some("not json".into())), Vec::<i64>::new());
        assert_eq!(parse_folder_ids(None), Vec::<i64>::new());
    }

    #[test]
    fn missing_uids_returns_server_minus_local() {
        assert_eq!(missing_uids(&[2, 3], &[1, 2, 3, 4]), vec![1, 4]);
        assert_eq!(missing_uids(&[1, 2], &[1, 2]), Vec::<i64>::new());
    }
}
