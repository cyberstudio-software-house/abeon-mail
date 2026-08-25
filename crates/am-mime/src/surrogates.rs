use std::borrow::Cow;

const HIGH_START: u32 = 0xD800;
const HIGH_END: u32 = 0xDBFF;
const LOW_START: u32 = 0xDC00;
const LOW_END: u32 = 0xDFFF;

fn combine(high: u32, low: u32) -> u32 {
    0x10000 + ((high - HIGH_START) << 10) + (low - LOW_START)
}

fn parse_numeric_entity(s: &str) -> Option<(u32, usize)> {
    let body = s.strip_prefix("&#")?;
    let (digits, radix, prefix_len) = match body.as_bytes().first() {
        Some(b'x') | Some(b'X') => (&body[1..], 16, 3),
        _ => (body, 10, 2),
    };
    let end = digits.find(';')?;
    if end == 0 || end > 8 {
        return None;
    }
    let value = u32::from_str_radix(&digits[..end], radix).ok()?;
    Some((value, prefix_len + end + 1))
}

fn parse_surrogate_pair_entity(s: &str) -> Option<(u32, usize)> {
    let (high, high_len) = parse_numeric_entity(s)?;
    if !(HIGH_START..=HIGH_END).contains(&high) {
        return None;
    }
    let (low, low_len) = parse_numeric_entity(&s[high_len..])?;
    if !(LOW_START..=LOW_END).contains(&low) {
        return None;
    }
    Some((combine(high, low), high_len + low_len))
}

pub fn repair_html_entities(html: &str) -> Cow<'_, str> {
    if !html.contains("&#") {
        return Cow::Borrowed(html);
    }

    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut repaired = false;

    while let Some(pos) = rest.find("&#") {
        out.push_str(&rest[..pos]);
        let candidate = &rest[pos..];
        match parse_surrogate_pair_entity(candidate) {
            Some((code_point, consumed)) => {
                out.push_str(&format!("&#{code_point};"));
                rest = &candidate[consumed..];
                repaired = true;
            }
            None => {
                out.push_str("&#");
                rest = &candidate[2..];
            }
        }
    }
    out.push_str(rest);

    if repaired {
        Cow::Owned(out)
    } else {
        Cow::Borrowed(html)
    }
}

fn cesu8_unit(bytes: &[u8]) -> Option<u32> {
    let (&first, tail) = bytes.split_first()?;
    if first != 0xED || tail.len() < 2 {
        return None;
    }
    if tail[0] & 0xC0 != 0x80 || tail[1] & 0xC0 != 0x80 {
        return None;
    }
    Some(0xD000 | ((tail[0] as u32 & 0x3F) << 6) | (tail[1] as u32 & 0x3F))
}

fn cesu8_pair(bytes: &[u8]) -> Option<u32> {
    let high = cesu8_unit(bytes)?;
    if !(HIGH_START..=HIGH_END).contains(&high) {
        return None;
    }
    let low = cesu8_unit(bytes.get(3..)?)?;
    if !(LOW_START..=LOW_END).contains(&low) {
        return None;
    }
    Some(combine(high, low))
}

pub fn repair_cesu8(bytes: &[u8]) -> Cow<'_, [u8]> {
    if !bytes.contains(&0xED) {
        return Cow::Borrowed(bytes);
    }

    let mut out: Option<Vec<u8>> = None;
    let mut i = 0;
    while i < bytes.len() {
        match cesu8_pair(&bytes[i..]) {
            Some(code_point) => {
                let buf = out.get_or_insert_with(|| bytes[..i].to_vec());
                let mut encoded = [0u8; 4];
                let ch = char::from_u32(code_point).expect("surrogate pair yields a scalar value");
                buf.extend_from_slice(ch.encode_utf8(&mut encoded).as_bytes());
                i += 6;
            }
            None => {
                if let Some(buf) = out.as_mut() {
                    buf.push(bytes[i]);
                }
                i += 1;
            }
        }
    }

    match out {
        Some(buf) => Cow::Owned(buf),
        None => Cow::Borrowed(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_pair_becomes_single_code_point() {
        assert_eq!(repair_html_entities("a&#55357;&#56898;b"), "a&#128578;b");
    }

    #[test]
    fn hex_pair_becomes_single_code_point() {
        assert_eq!(repair_html_entities("&#xD83D;&#xDE0A;"), "&#128522;");
    }

    #[test]
    fn mixed_radix_pair_is_combined() {
        assert_eq!(repair_html_entities("&#xD83D;&#56898;"), "&#128578;");
    }

    #[test]
    fn non_surrogate_entities_stay_verbatim() {
        assert_eq!(
            repair_html_entities("&#324;&#128578;&amp;"),
            "&#324;&#128578;&amp;"
        );
    }

    #[test]
    fn lone_high_surrogate_stays_verbatim() {
        assert_eq!(repair_html_entities("&#55357;x"), "&#55357;x");
    }

    #[test]
    fn lone_low_surrogate_stays_verbatim() {
        assert_eq!(repair_html_entities("&#56898;"), "&#56898;");
    }

    #[test]
    fn separated_surrogates_are_not_joined() {
        assert_eq!(
            repair_html_entities("&#55357; &#56898;"),
            "&#55357; &#56898;"
        );
    }

    #[test]
    fn malformed_entity_does_not_break_scan() {
        assert_eq!(
            repair_html_entities("&#nope &#55357;&#56898;"),
            "&#nope &#128578;"
        );
    }

    #[test]
    fn html_without_entities_is_borrowed() {
        assert!(matches!(
            repair_html_entities("<p>hi</p>"),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn cesu8_pair_becomes_utf8_emoji() {
        let input = [0xED, 0xA0, 0xBD, 0xED, 0xB9, 0x82];
        assert_eq!(repair_cesu8(&input).as_ref(), "\u{1F642}".as_bytes());
    }

    #[test]
    fn cesu8_repair_keeps_surrounding_bytes() {
        let mut input = b"ab".to_vec();
        input.extend_from_slice(&[0xED, 0xA0, 0xBD, 0xED, 0xB9, 0x82]);
        input.extend_from_slice("ć".as_bytes());
        assert_eq!(
            String::from_utf8(repair_cesu8(&input).into_owned()).unwrap(),
            "ab\u{1F642}ć"
        );
    }

    #[test]
    fn valid_utf8_is_borrowed_unchanged() {
        let input = "zażółć \u{1F642}".as_bytes();
        assert!(matches!(repair_cesu8(input), Cow::Borrowed(_)));
    }

    #[test]
    fn lone_cesu8_surrogate_is_left_for_the_decoder() {
        let input = [0xED, 0xA0, 0xBD, b'x'];
        assert!(matches!(repair_cesu8(&input), Cow::Borrowed(_)));
    }

    #[test]
    fn three_byte_ed_sequence_that_is_not_a_surrogate_survives() {
        let input = "\u{D000}".as_bytes();
        assert_eq!(repair_cesu8(input).as_ref(), input);
    }
}
