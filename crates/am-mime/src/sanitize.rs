use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct SanitizedHtml {
    pub html: String,
    pub blocked_remote_content: bool,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct ReaderHtml {
    pub html: String,
    pub blocked_remote_content: bool,
    pub remote_urls: Vec<String>,
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

fn email_style_properties() -> std::collections::HashSet<&'static str> {
    [
        "color", "font", "font-family", "font-size", "font-weight", "font-style",
        "font-variant", "line-height", "letter-spacing", "word-spacing", "text-align",
        "text-decoration", "text-transform", "text-indent", "text-shadow", "text-overflow",
        "white-space", "word-break", "word-wrap", "overflow-wrap", "direction",
        "vertical-align", "list-style", "list-style-type", "list-style-position",
        "width", "height", "max-width", "min-width", "max-height", "min-height",
        "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
        "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
        "display", "box-sizing", "overflow", "overflow-x", "overflow-y", "float", "clear",
        "position", "top", "right", "bottom", "left", "z-index",
        "border", "border-top", "border-right", "border-bottom", "border-left",
        "border-width", "border-style", "border-color", "border-radius",
        "border-collapse", "border-spacing",
        "border-top-left-radius", "border-top-right-radius",
        "border-bottom-left-radius", "border-bottom-right-radius",
        "background", "background-color", "background-image", "background-position",
        "background-repeat", "background-size", "background-clip", "background-origin",
        "box-shadow", "outline", "opacity", "visibility",
        "table-layout", "caption-side", "empty-cells",
        "flex", "flex-direction", "flex-wrap", "flex-flow", "justify-content",
        "align-items", "align-self", "align-content", "gap", "row-gap", "column-gap",
        "order", "flex-grow", "flex-shrink", "flex-basis",
        "cursor", "object-fit", "content",
    ]
    .into_iter()
    .collect()
}

fn sanitize_internal(
    raw_html: &str,
    allow_remote: bool,
    resolve_cid: bool,
    cid_map: &HashMap<String, String>,
    remote_map: &HashMap<String, String>,
) -> (String, bool, Vec<String>) {
    let blocked = Arc::new(Mutex::new(false));
    let blocked_clone = Arc::clone(&blocked);
    let remote = Arc::new(Mutex::new(Vec::<String>::new()));
    let remote_clone = Arc::clone(&remote);
    let cid_map = cid_map.clone();
    let remote_map = remote_map.clone();

    let html = ammonia::Builder::default()
        .rm_tags(&["iframe", "object", "embed", "form", "input", "button", "select", "textarea"])
        .add_clean_content_tags(&["iframe", "object", "embed", "form"])
        .add_url_schemes(&["cid", "data"])
        .add_generic_attributes(&[
            "style", "align", "valign", "bgcolor", "width", "height", "border",
            "cellpadding", "cellspacing",
        ])
        .filter_style_properties(email_style_properties())
        .set_tag_attribute_value("a", "target", "_self")
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| {
            if attribute.starts_with("on") {
                return None;
            }

            let normalized = normalize_url(value);
            let scheme = extract_scheme(&normalized);

            if element == "img" && attribute == "src" {
                if is_remote_url(&normalized) {
                    if let Some(data_uri) = remote_map.get(value) {
                        return Some(data_uri.clone().into());
                    }
                    if allow_remote {
                        remote_clone.lock().unwrap().push(value.to_string());
                        return Some(value.into());
                    }
                    *blocked_clone.lock().unwrap() = true;
                    return None;
                }
                if scheme == "cid" {
                    if !resolve_cid {
                        return Some(value.into());
                    }
                    let id = normalized
                        .trim_start_matches("cid:")
                        .trim_matches(|c| c == '<' || c == '>');
                    if let Some(data_uri) = cid_map.get(id) {
                        return Some(data_uri.clone().into());
                    }
                    return None;
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
    let remote_urls = std::mem::take(&mut *remote.lock().unwrap());
    (html, blocked_remote_content, remote_urls)
}

pub fn sanitize_html(raw_html: &str) -> SanitizedHtml {
    let (html, blocked_remote_content, _) =
        sanitize_internal(raw_html, false, false, &HashMap::new(), &HashMap::new());
    SanitizedHtml {
        html,
        blocked_remote_content,
    }
}

pub fn sanitize_for_reader(
    raw_html: &str,
    allow_remote: bool,
    cid_map: &HashMap<String, String>,
    remote_map: &HashMap<String, String>,
) -> ReaderHtml {
    let (html, blocked_remote_content, remote_urls) =
        sanitize_internal(raw_html, allow_remote, true, cid_map, remote_map);
    ReaderHtml {
        html,
        blocked_remote_content,
        remote_urls,
    }
}

fn normalize_for_match(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn is_void_element(name: &str) -> bool {
    matches!(
        name,
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input"
            | "link" | "meta" | "param" | "source" | "track" | "wbr"
    )
}

fn scan_tag_end(bytes: &[u8], start: usize) -> usize {
    let n = bytes.len();
    let mut i = start + 1;
    let mut quote: u8 = 0;
    while i < n {
        let c = bytes[i];
        if quote != 0 {
            if c == quote {
                quote = 0;
            }
        } else if c == b'"' || c == b'\'' {
            quote = c;
        } else if c == b'>' {
            return i + 1;
        }
        i += 1;
    }
    n
}

fn tag_name(slice: &str) -> String {
    let bytes = slice.as_bytes();
    let mut i = 1;
    if i < bytes.len() && bytes[i] == b'/' {
        i += 1;
    }
    let start = i;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_alphanumeric() || c == b'-' || c == b':' {
            i += 1;
        } else {
            break;
        }
    }
    slice[start..i].to_ascii_lowercase()
}

enum HtmlToken {
    Open { name: String, start: usize },
    Close { name: String, end: usize },
    SelfContained,
    Text { start: usize, end: usize },
}

fn tokenize(html: &str) -> Vec<HtmlToken> {
    let bytes = html.as_bytes();
    let n = bytes.len();
    let mut toks = Vec::new();
    let mut i = 0;
    let mut text_start = 0;
    while i < n {
        if bytes[i] == b'<' {
            if i > text_start {
                toks.push(HtmlToken::Text { start: text_start, end: i });
            }
            if html[i..].starts_with("<!--") {
                let end = html[i..].find("-->").map(|p| i + p + 3).unwrap_or(n);
                toks.push(HtmlToken::SelfContained);
                i = end;
                text_start = i;
                continue;
            }
            let tag_end = scan_tag_end(bytes, i);
            let slice = &html[i..tag_end];
            if slice.starts_with("<!") || slice.starts_with("<?") {
                toks.push(HtmlToken::SelfContained);
            } else if slice.starts_with("</") {
                toks.push(HtmlToken::Close { name: tag_name(slice), end: tag_end });
            } else {
                let name = tag_name(slice);
                if slice.trim_end().ends_with("/>") || is_void_element(&name) {
                    toks.push(HtmlToken::SelfContained);
                } else {
                    toks.push(HtmlToken::Open { name, start: i });
                }
            }
            i = tag_end;
            text_start = i;
        } else {
            i += 1;
        }
    }
    if n > text_start {
        toks.push(HtmlToken::Text { start: text_start, end: n });
    }
    toks
}

pub fn strip_leading_subject_heading(html: &str, subject: &str) -> String {
    let target = normalize_for_match(subject);
    if target.chars().count() < 3 {
        return html.to_string();
    }

    let toks = tokenize(html);

    let mut first_text = None;
    for (idx, t) in toks.iter().enumerate() {
        if let HtmlToken::Text { start, end } = t {
            if !html[*start..*end].trim().is_empty() {
                first_text = Some(idx);
                break;
            }
        }
    }
    let fi = match first_text {
        Some(v) => v,
        None => return html.to_string(),
    };

    let mut stack: Vec<(String, usize)> = Vec::new();
    for t in &toks[..fi] {
        match t {
            HtmlToken::Open { name, start } => stack.push((name.clone(), *start)),
            HtmlToken::Close { name, .. } => {
                if let Some(pos) = stack.iter().rposition(|(n, _)| n == name) {
                    stack.truncate(pos);
                }
            }
            _ => {}
        }
    }

    if stack.is_empty() {
        if let HtmlToken::Text { start, end } = toks[fi] {
            if normalize_for_match(&decode_entities(&html[start..end])) == target {
                let mut out = String::with_capacity(html.len());
                out.push_str(&html[..start]);
                out.push_str(&html[end..]);
                return out;
            }
        }
        return html.to_string();
    }

    let base_depth = stack.len();
    let mut depth = base_depth;
    let mut acc = String::new();
    let mut removal: Option<(usize, usize)> = None;
    for t in &toks[fi..] {
        match t {
            HtmlToken::Text { start, end } => acc.push_str(&html[*start..*end]),
            HtmlToken::Open { .. } => depth += 1,
            HtmlToken::SelfContained => {}
            HtmlToken::Close { end, .. } => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                if depth < base_depth {
                    let idx = depth;
                    if normalize_for_match(&decode_entities(&acc)) == target {
                        removal = Some((stack[idx].1, *end));
                        break;
                    }
                    if idx == 0 {
                        break;
                    }
                }
            }
        }
    }

    match removal {
        Some((s, e)) => {
            let mut out = String::with_capacity(html.len());
            out.push_str(&html[..s]);
            out.push_str(&html[e..]);
            out
        }
        None => html.to_string(),
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
        assert!(result.html.contains("target=\"_self\""));
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

    #[test]
    fn cid_image_resolved_to_data_uri() {
        let mut cid = HashMap::new();
        cid.insert("logo".to_string(), "data:image/png;base64,AAA".to_string());
        let r = sanitize_for_reader("<img src=\"cid:logo\">", false, &cid, &HashMap::new());
        assert!(r.html.contains("data:image/png;base64,AAA"));
        assert!(!r.html.contains("cid:logo"));
    }

    #[test]
    fn cid_image_dropped_when_unknown() {
        let r = sanitize_for_reader("<img src=\"cid:missing\">", false, &HashMap::new(), &HashMap::new());
        assert!(!r.html.contains("cid:missing"));
        assert!(!r.blocked_remote_content);
    }

    #[test]
    fn remote_collected_when_allowed() {
        let r = sanitize_for_reader("<img src=\"https://x/a.png\">", true, &HashMap::new(), &HashMap::new());
        assert_eq!(r.remote_urls, vec!["https://x/a.png".to_string()]);
        assert!(!r.blocked_remote_content);
    }

    #[test]
    fn remote_replaced_from_map() {
        let mut remote = HashMap::new();
        remote.insert("https://x/a.png".to_string(), "data:image/png;base64,BBB".to_string());
        let r = sanitize_for_reader("<img src=\"https://x/a.png\">", false, &HashMap::new(), &remote);
        assert!(r.html.contains("data:image/png;base64,BBB"));
        assert!(!r.html.contains("https://x/a.png"));
        assert!(!r.blocked_remote_content);
    }

    #[test]
    fn remote_blocked_when_not_allowed_and_absent() {
        let r = sanitize_for_reader("<img src=\"https://x/a.png\">", false, &HashMap::new(), &HashMap::new());
        assert!(r.blocked_remote_content);
        assert!(!r.html.contains("https://x/a.png"));
    }

    #[test]
    fn inline_style_is_preserved() {
        let result = sanitize_html("<div style=\"color:#635bff;padding:24px;border-radius:8px\">hi</div>");
        assert!(result.html.contains("color:#635bff"));
        assert!(result.html.contains("padding:24px"));
        assert!(result.html.contains("border-radius:8px"));
    }

    #[test]
    fn disallowed_style_property_is_stripped() {
        let result = sanitize_html("<div style=\"color:red;behavior:url(evil.htc);-moz-binding:url(x)\">hi</div>");
        assert!(result.html.contains("color:red"));
        assert!(!result.html.contains("behavior"));
        assert!(!result.html.contains("-moz-binding"));
    }

    #[test]
    fn table_presentational_attributes_survive() {
        let result = sanitize_html(
            "<table bgcolor=\"#f6f9fc\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\"><tr><td align=\"center\">x</td></tr></table>",
        );
        assert!(result.html.contains("bgcolor=\"#f6f9fc\""));
        assert!(result.html.contains("width=\"600\""));
        assert!(result.html.contains("align=\"center\""));
    }

    #[test]
    fn style_attribute_does_not_reintroduce_scripting() {
        let result = sanitize_html("<div style=\"color:red\" onclick=\"evil()\">hi</div>");
        assert!(result.html.contains("color:red"));
        assert!(!result.html.contains("onclick"));
    }

    #[test]
    fn strip_leading_heading_removes_matching_h1() {
        let out = strip_leading_subject_heading(
            "<h1>Weekly report</h1><p>Body content here</p>",
            "Weekly report",
        );
        assert_eq!(out, "<p>Body content here</p>");
    }

    #[test]
    fn strip_leading_heading_handles_nested_inline_tags() {
        let out = strip_leading_subject_heading(
            "<div><p><b>My</b> Subject</p><p>body</p></div>",
            "My Subject",
        );
        assert_eq!(out, "<div><p>body</p></div>");
    }

    #[test]
    fn strip_leading_heading_is_case_and_space_insensitive() {
        let out = strip_leading_subject_heading(
            "<p>  [Action required]   Review your   account </p><div>rest</div>",
            "[Action required] Review your account",
        );
        assert_eq!(out, "<div>rest</div>");
    }

    #[test]
    fn strip_leading_heading_decodes_entities() {
        let out = strip_leading_subject_heading(
            "<h2>Tom &amp; Jerry</h2><p>x</p>",
            "Tom & Jerry",
        );
        assert_eq!(out, "<p>x</p>");
    }

    #[test]
    fn strip_leading_heading_keeps_non_matching_body() {
        let html = "<h1>Different heading</h1><p>x</p>";
        assert_eq!(strip_leading_subject_heading(html, "Weekly report"), html);
    }

    #[test]
    fn strip_leading_heading_keeps_when_text_precedes() {
        let html = "<p>Hello there</p><h1>Weekly report</h1>";
        assert_eq!(strip_leading_subject_heading(html, "Weekly report"), html);
    }

    #[test]
    fn strip_leading_heading_noop_on_empty_subject() {
        let html = "<h1>Anything</h1>";
        assert_eq!(strip_leading_subject_heading(html, ""), html);
        assert_eq!(strip_leading_subject_heading(html, "ab"), html);
    }

    #[test]
    fn strip_leading_heading_ignores_self_closing_before_text() {
        let out = strip_leading_subject_heading(
            "<div><img src=\"data:image/png;base64,AA\"/><h1>Report</h1><p>b</p></div>",
            "Report",
        );
        assert_eq!(out, "<div><img src=\"data:image/png;base64,AA\"/><p>b</p></div>");
    }
}
