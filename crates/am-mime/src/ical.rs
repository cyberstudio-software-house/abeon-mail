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

pub(crate) struct ResolvedTime {
    pub epoch: i64,
    pub all_day: bool,
}

pub(crate) struct VtzRule {
    pub offset_to: i32,
    pub month: u32,
    pub weekday: i64,
    pub nth: i32,
    pub hour: u32,
    pub minute: u32,
}

pub(crate) struct Vtimezone {
    pub standard: Option<VtzRule>,
    pub daylight: Option<VtzRule>,
}

pub(crate) fn civil_to_epoch(y: i64, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> i64 {
    let m = m as i64;
    let d = d as i64;
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + (hh as i64) * 3600 + (mm as i64) * 60 + ss as i64
}

fn weekday_of_epoch_day(days: i64) -> i64 {
    ((days % 7) + 4 + 7 * 1000) % 7
}

fn nth_weekday_local(year: i64, month: u32, weekday: i64, nth: i32, hour: u32, minute: u32) -> i64 {
    let days_in_month = {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        match month {
            1 => 31,
            2 => if leap { 29 } else { 28 },
            3 => 31,
            4 => 30,
            5 => 31,
            6 => 30,
            7 => 31,
            8 => 31,
            9 => 30,
            10 => 31,
            11 => 30,
            _ => 31,
        }
    };
    let day = if nth < 0 {
        let mut d = days_in_month;
        loop {
            let ed = civil_to_epoch(year, month, d, 0, 0, 0) / 86400;
            if weekday_of_epoch_day(ed) == weekday {
                break d;
            }
            d -= 1;
        }
    } else {
        let mut count = 0;
        let mut d = 1;
        loop {
            let ed = civil_to_epoch(year, month, d, 0, 0, 0) / 86400;
            if weekday_of_epoch_day(ed) == weekday {
                count += 1;
                if count == nth {
                    break d;
                }
            }
            d += 1;
            if d > days_in_month {
                break days_in_month;
            }
        }
    };
    civil_to_epoch(year, month, day, hour, minute, 0)
}

impl Vtimezone {
    pub fn offset_at(&self, y: i64, m: u32, d: u32, hh: u32, mm: u32) -> i32 {
        let event_local = civil_to_epoch(y, m, d, hh, mm, 0);
        match (&self.standard, &self.daylight) {
            (Some(std), Some(dst)) => {
                let dst_start = nth_weekday_local(y, dst.month, dst.weekday, dst.nth, dst.hour, dst.minute);
                let std_start = nth_weekday_local(y, std.month, std.weekday, std.nth, std.hour, std.minute);
                let in_dst = if dst_start <= std_start {
                    event_local >= dst_start && event_local < std_start
                } else {
                    event_local >= dst_start || event_local < std_start
                };
                if in_dst {
                    dst.offset_to
                } else {
                    std.offset_to
                }
            }
            (Some(std), None) => std.offset_to,
            (None, Some(dst)) => dst.offset_to,
            (None, None) => 0,
        }
    }
}

pub(crate) fn resolve_dt(
    value: &str,
    tzid: Option<&str>,
    is_date: bool,
    tzs: &std::collections::HashMap<String, Vtimezone>,
) -> Option<ResolvedTime> {
    let v = value.trim();
    if is_date || (v.len() == 8 && !v.contains('T')) {
        let y: i64 = v.get(0..4)?.parse().ok()?;
        let mo: u32 = v.get(4..6)?.parse().ok()?;
        let d: u32 = v.get(6..8)?.parse().ok()?;
        return Some(ResolvedTime { epoch: civil_to_epoch(y, mo, d, 0, 0, 0), all_day: true });
    }
    let is_utc = v.ends_with('Z');
    let core = v.trim_end_matches('Z');
    let y: i64 = core.get(0..4)?.parse().ok()?;
    let mo: u32 = core.get(4..6)?.parse().ok()?;
    let d: u32 = core.get(6..8)?.parse().ok()?;
    let hh: u32 = core.get(9..11)?.parse().ok()?;
    let mm: u32 = core.get(11..13)?.parse().ok()?;
    let ss: u32 = core.get(13..15).and_then(|s| s.parse().ok()).unwrap_or(0);
    let local = civil_to_epoch(y, mo, d, hh, mm, ss);
    if is_utc {
        return Some(ResolvedTime { epoch: local, all_day: false });
    }
    if let Some(tz) = tzid.and_then(|t| tzs.get(t)) {
        let offset = tz.offset_at(y, mo, d, hh, mm) as i64;
        return Some(ResolvedTime { epoch: local - offset, all_day: false });
    }
    Some(ResolvedTime { epoch: local, all_day: false })
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

#[cfg(test)]
mod dt_tests {
    use super::*;
    use std::collections::HashMap;

    fn cet() -> HashMap<String, Vtimezone> {
        let mut m = HashMap::new();
        m.insert("Central European Standard Time".to_string(), Vtimezone {
            standard: Some(VtzRule { offset_to: 3600, month: 10, weekday: 0, nth: -1, hour: 3, minute: 0 }),
            daylight: Some(VtzRule { offset_to: 7200, month: 3, weekday: 0, nth: -1, hour: 2, minute: 0 }),
        });
        m
    }

    #[test]
    fn civil_epoch_unix_reference() {
        assert_eq!(civil_to_epoch(1970, 1, 1, 0, 0, 0), 0);
        assert_eq!(civil_to_epoch(2025, 10, 24, 10, 0, 0), 1761300000);
    }

    #[test]
    fn utc_suffix_is_direct() {
        let r = resolve_dt("20251024T080000Z", None, false, &HashMap::new()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 8, 0, 0));
        assert!(!r.all_day);
    }

    #[test]
    fn date_value_is_all_day_midnight() {
        let r = resolve_dt("20251024", None, true, &HashMap::new()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 0, 0, 0));
        assert!(r.all_day);
    }

    #[test]
    fn summer_date_uses_cest_plus_two() {
        let r = resolve_dt("20250701T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 7, 1, 8, 0, 0));
    }

    #[test]
    fn winter_date_uses_cet_plus_one() {
        let r = resolve_dt("20251201T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 12, 1, 9, 0, 0));
    }

    #[test]
    fn sample_event_oct24_is_dst_plus_two() {
        let r = resolve_dt("20251024T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 8, 0, 0));
    }

    #[test]
    fn floating_time_treated_as_utc_naive() {
        let r = resolve_dt("20251024T100000", None, false, &HashMap::new()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 10, 0, 0));
    }
}
