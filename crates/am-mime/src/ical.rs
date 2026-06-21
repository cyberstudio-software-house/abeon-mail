#![allow(dead_code)]

pub(crate) struct ContentLine {
    pub name: String,
    pub params: Vec<(String, String)>,
    pub value: String,
}

impl ContentLine {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }

    pub fn unescaped(&self) -> String {
        let mut out = String::with_capacity(self.value.len());
        let mut chars = self.value.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') | Some('N') => out.push('\n'),
                    Some(other) => out.push(other),
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        out
    }
}

pub(crate) fn unfold(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw_line in raw.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = out.last_mut() {
                last.push_str(&line[1..]);
                continue;
            }
        }
        out.push(line.to_string());
    }
    out.retain(|l| !l.is_empty());
    out
}

pub(crate) fn parse_line(line: &str) -> Option<ContentLine> {
    let mut in_quote = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ':' if !in_quote => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);

    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    for c in head.chars() {
        match c {
            '"' => q = !q,
            ';' if !q => {
                parts.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    parts.push(cur);

    let mut iter = parts.into_iter();
    let name = iter.next()?.trim().to_ascii_uppercase();
    let params = iter
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_uppercase(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();

    Some(ContentLine {
        name,
        params,
        value: value.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfold_joins_continuation_lines() {
        let raw = "DESCRIPTION:Hello\r\n World\r\nSUMMARY:Hi\r\n";
        let lines = unfold(raw);
        assert_eq!(lines, vec!["DESCRIPTION:HelloWorld".to_string(), "SUMMARY:Hi".to_string()]);
    }

    #[test]
    fn parse_line_splits_name_params_value() {
        let cl = parse_line("DTSTART;TZID=Central European Standard Time:20251024T100000").unwrap();
        assert_eq!(cl.name, "DTSTART");
        assert_eq!(cl.param("TZID"), Some("Central European Standard Time"));
        assert_eq!(cl.value, "20251024T100000");
    }

    #[test]
    fn parse_line_handles_quoted_param_and_colon_in_value() {
        let cl = parse_line("ATTENDEE;CN=\"Doe, John\";X=1:mailto:j@x.com").unwrap();
        assert_eq!(cl.param("CN"), Some("Doe, John"));
        assert_eq!(cl.value, "mailto:j@x.com");
    }

    #[test]
    fn unescaped_decodes_text_escapes() {
        let cl = parse_line("DESCRIPTION:a\\nb\\, c\\; d\\\\e").unwrap();
        assert_eq!(cl.unescaped(), "a\nb, c; d\\e");
    }
}
