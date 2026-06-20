use base64::Engine;

pub fn decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let mut last_was_encoded_word = false;

    while let Some(start) = rest.find("=?") {
        let (before, tail) = rest.split_at(start);
        let between_is_whitespace = before.trim().is_empty() && !before.is_empty();
        if !(last_was_encoded_word && between_is_whitespace) {
            out.push_str(before);
        }

        match parse_encoded_word(tail) {
            Some((decoded, consumed)) => {
                out.push_str(&decoded);
                rest = &tail[consumed..];
                last_was_encoded_word = true;
            }
            None => {
                out.push_str("=?");
                rest = &tail[2..];
                last_was_encoded_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_encoded_word(s: &str) -> Option<(String, usize)> {
    let after_prefix = &s[2..];
    let charset_end = after_prefix.find('?')?;
    let charset = &after_prefix[..charset_end];

    let after_charset = &after_prefix[charset_end + 1..];
    let encoding_end = after_charset.find('?')?;
    let encoding = &after_charset[..encoding_end];

    let after_encoding = &after_charset[encoding_end + 1..];
    let payload_end = after_encoding.find("?=")?;
    let payload = &after_encoding[..payload_end];
    if payload.contains('?') {
        return None;
    }

    let end = 2 + charset_end + 1 + encoding_end + 1 + payload_end + 2;

    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .ok()?,
        "Q" => decode_q(payload),
        _ => return None,
    };

    let enc = encoding_rs::Encoding::for_label(charset.as_bytes())?;
    let (decoded, _, _) = enc.decode(&bytes);
    Some((decoded.into_owned(), end))
}

fn decode_q(payload: &str) -> Vec<u8> {
    let bytes = payload.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'=');
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn plain_text_passthrough() {
        assert_eq!(decode("Just a subject"), "Just a subject");
    }

    #[test]
    fn utf8_quoted_printable() {
        assert_eq!(decode("=?utf-8?Q?Hello_=C5=9Awiat?="), "Hello Świat");
    }

    #[test]
    fn utf8_base64() {
        assert_eq!(decode("=?UTF-8?B?SGVsbG8gd29ybGQ=?="), "Hello world");
    }

    #[test]
    fn iso_8859_1_quoted_printable() {
        assert_eq!(decode("=?ISO-8859-1?Q?caf=E9?="), "café");
    }

    #[test]
    fn adjacent_words_join_without_separating_whitespace() {
        assert_eq!(
            decode("=?utf-8?B?SGVsbG8g?= =?utf-8?B?d29ybGQ=?="),
            "Hello world"
        );
    }

    #[test]
    fn mixed_plain_and_encoded() {
        assert_eq!(decode("Re: =?utf-8?Q?test?= done"), "Re: test done");
    }

    #[test]
    fn quoted_printable_payload_starting_with_equals() {
        assert_eq!(
            decode("=?UTF-8?Q?=c5=81ukasz_Pra=c5=bcmowski?="),
            "Łukasz Prażmowski"
        );
    }

    #[test]
    fn malformed_token_returned_verbatim() {
        assert_eq!(decode("=?utf-8?X?broken?="), "=?utf-8?X?broken?=");
        assert_eq!(decode("=?notacharset?Q?x?="), "=?notacharset?Q?x?=");
    }
}
