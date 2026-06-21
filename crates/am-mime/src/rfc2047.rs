use base64::Engine;
use encoding_rs::Encoding;

pub fn decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let mut last_was_encoded_word = false;
    let mut pending: Option<(&'static Encoding, Vec<u8>)> = None;

    while let Some(start) = rest.find("=?") {
        let (before, tail) = rest.split_at(start);
        let between_is_whitespace = before.trim().is_empty() && !before.is_empty();
        let suppress_before = last_was_encoded_word && between_is_whitespace;

        match parse_encoded_word(tail) {
            Some((enc, bytes, consumed)) => {
                if suppress_before {
                    match &mut pending {
                        Some((penc, buf)) if std::ptr::eq(*penc, enc) => {
                            buf.extend_from_slice(&bytes)
                        }
                        _ => {
                            flush(&mut pending, &mut out);
                            pending = Some((enc, bytes));
                        }
                    }
                } else {
                    flush(&mut pending, &mut out);
                    out.push_str(before);
                    pending = Some((enc, bytes));
                }
                rest = &tail[consumed..];
                last_was_encoded_word = true;
            }
            None => {
                flush(&mut pending, &mut out);
                if !suppress_before {
                    out.push_str(before);
                }
                out.push_str("=?");
                rest = &tail[2..];
                last_was_encoded_word = false;
            }
        }
    }
    flush(&mut pending, &mut out);
    out.push_str(rest);
    out
}

fn flush(pending: &mut Option<(&'static Encoding, Vec<u8>)>, out: &mut String) {
    if let Some((enc, bytes)) = pending.take() {
        let (decoded, _, _) = enc.decode(&bytes);
        out.push_str(&decoded);
    }
}

fn parse_encoded_word(s: &str) -> Option<(&'static Encoding, Vec<u8>, usize)> {
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

    let enc = Encoding::for_label(charset.as_bytes())?;

    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .ok()?,
        "Q" => decode_q(payload),
        _ => return None,
    };

    Some((enc, bytes, end))
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

    #[test]
    fn multibyte_char_split_across_base64_words() {
        assert_eq!(decode("=?UTF-8?B?Unp1xA==?= =?UTF-8?B?hw==?="), "Rzuć");
    }

    #[test]
    fn multibyte_char_split_across_quoted_printable_words() {
        assert_eq!(decode("=?UTF-8?Q?=c5?= =?UTF-8?Q?=82=c4=85ka?="), "łąka");
    }
}
