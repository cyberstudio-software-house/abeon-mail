use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct SanitizedHtml {
    pub html: String,
    pub blocked_remote_content: bool,
}

fn normalize_url(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\t' && *c != '\n' && *c != '\r')
        .collect::<String>()
        .trim_start_matches(|c: char| c.is_ascii_whitespace() || c.is_ascii_control())
        .to_ascii_lowercase()
}

fn extract_scheme(normalized: &str) -> &str {
    normalized
        .find(':')
        .map(|i| &normalized[..i])
        .unwrap_or("")
}

fn is_remote_url(normalized: &str) -> bool {
    normalized.starts_with("http://") || normalized.starts_with("https://")
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

            let normalized = normalize_url(value);
            let scheme = extract_scheme(&normalized);

            if element == "img" && attribute == "src" {
                if is_remote_url(&normalized) {
                    *blocked_clone.lock().unwrap() = true;
                    return None;
                }
                if scheme == "cid" {
                    return Some(value.into());
                }
                if scheme == "data" && normalized.starts_with("data:image/") {
                    return Some(value.into());
                }
                return None;
            }

            if scheme == "data" || scheme == "cid" {
                return None;
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
        let result = sanitize_html("<img src=\"data:image/png;base64,iVBORw0KGgo=\">");
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

    #[test]
    fn test_data_html_href_blocked() {
        let result = sanitize_html("<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">click</a>");
        assert!(!result.html.contains("data:text/html"));
    }

    #[test]
    fn test_data_html_href_obfuscated_tab_blocked() {
        let result = sanitize_html("<a href=\"da\tta:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">click</a>");
        assert!(!result.html.contains("data:text/html"));
        assert!(!result.html.contains("da\tta:"));
    }

    #[test]
    fn test_javascript_href_blocked() {
        let result = sanitize_html("<a href=\"javascript:alert(1)\">click</a>");
        assert!(!result.html.contains("javascript:"));
    }

    #[test]
    fn test_cid_href_blocked() {
        let result = sanitize_html("<a href=\"cid:abc\">link</a>");
        assert!(!result.html.contains("cid:"));
    }

    #[test]
    fn test_data_html_img_src_blocked() {
        let result = sanitize_html("<img src=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">");
        assert!(!result.html.contains("data:text/html"));
    }

    #[test]
    fn test_data_image_png_img_src_allowed() {
        let result = sanitize_html("<img src=\"data:image/png;base64,iVBORw0KGgo=\">");
        assert!(result.html.contains("data:image/png"));
    }

    #[test]
    fn test_cid_img_src_allowed() {
        let result = sanitize_html("<img src=\"cid:logo\">");
        assert!(result.html.contains("cid:logo"));
    }

    #[test]
    fn test_remote_img_src_blocked_flag() {
        let result = sanitize_html("<img src=\"http://t/x.png\">");
        assert!(result.blocked_remote_content);
        assert!(!result.html.contains("http://t/x.png"));
    }

    #[test]
    fn test_vbscript_href_blocked() {
        let result = sanitize_html("<a href=\"vbscript:msgbox(1)\">x</a>");
        assert!(!result.html.contains("vbscript:"));
    }

    #[test]
    fn test_svg_image_data_uri_survives_on_img() {
        let result = sanitize_html("<img src=\"data:image/svg+xml,<svg></svg>\">");
        assert!(result.html.contains("data:image/svg+xml"));
    }

    #[test]
    fn test_inline_svg_tag_stripped() {
        let result = sanitize_html("<svg onload=\"alert(1)\"><circle/></svg>");
        assert!(!result.html.contains("onload"));
        assert!(!result.html.contains("<svg"));
    }
}
