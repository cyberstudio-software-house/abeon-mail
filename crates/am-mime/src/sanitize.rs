use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct SanitizedHtml {
    pub html: String,
    pub blocked_remote_content: bool,
}

fn is_remote_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_safe_image_src(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("cid:") || lower.starts_with("data:")
}

pub fn sanitize_html(raw_html: &str) -> SanitizedHtml {
    let blocked = Arc::new(Mutex::new(false));
    let blocked_clone = Arc::clone(&blocked);

    let html = ammonia::Builder::default()
        .rm_tags(&["iframe", "object", "embed", "form", "input", "button", "select", "textarea"])
        .add_clean_content_tags(&["iframe", "object", "embed", "form"])
        .add_url_schemes(&["cid", "data"])
        .set_tag_attribute_value("a", "target", "_blank")
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| {
            if attribute.starts_with("on") {
                return None;
            }
            if element == "img" && attribute == "src" {
                if is_remote_url(value) {
                    *blocked_clone.lock().unwrap() = true;
                    return None;
                }
                if !is_safe_image_src(value) {
                    return None;
                }
            }
            Some(value.into())
        })
        .clean(raw_html)
        .to_string();

    let blocked_remote_content = *blocked.lock().unwrap();

    SanitizedHtml {
        html,
        blocked_remote_content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_script_removed() {
        let result = sanitize_html("<p>hello</p><script>alert('xss')</script>");
        assert!(!result.html.contains("script"));
        assert!(!result.html.contains("alert"));
    }

    #[test]
    fn test_onclick_stripped() {
        let result = sanitize_html("<div onclick=\"evil()\">click me</div>");
        assert!(!result.html.contains("onclick"));
    }

    #[test]
    fn test_remote_img_blocked() {
        let result = sanitize_html("<img src=\"https://tracker.example.com/pixel.png\">");
        assert!(result.blocked_remote_content);
        assert!(!result.html.contains("https://tracker.example.com"));
    }

    #[test]
    fn test_inline_survives() {
        let result = sanitize_html("<b>bold</b>");
        assert!(result.html.contains("<b>bold</b>"));
    }

    #[test]
    fn test_link_gets_rel_target() {
        let result = sanitize_html("<a href=\"https://example.com\">link</a>");
        assert!(result.html.contains("noopener noreferrer"));
        assert!(result.html.contains("target=\"_blank\""));
    }

    #[test]
    fn test_cid_image_allowed() {
        let result = sanitize_html("<img src=\"cid:part1.abc123@example.com\">");
        assert!(!result.blocked_remote_content);
        assert!(result.html.contains("cid:"));
    }

    #[test]
    fn test_data_image_allowed() {
        let result = sanitize_html("<img src=\"data:image/png;base64,abc123\">");
        assert!(!result.blocked_remote_content);
        assert!(result.html.contains("data:image/png"));
    }

    #[test]
    fn test_iframe_removed() {
        let result = sanitize_html("<iframe src=\"https://evil.com\"></iframe><p>safe</p>");
        assert!(!result.html.contains("iframe"));
    }

    #[test]
    fn test_onmouseover_stripped() {
        let result = sanitize_html("<a href=\"/\" onmouseover=\"evil()\">link</a>");
        assert!(!result.html.contains("onmouseover"));
    }
}
