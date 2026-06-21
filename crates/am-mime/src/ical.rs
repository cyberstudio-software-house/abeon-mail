
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

use am_core::meeting::{MeetingInvite, MeetingMethod, MeetingProvider};
use std::collections::HashMap;

const KNOWN_HOSTS: &[(&str, MeetingProvider)] = &[
    ("teams.microsoft.com", MeetingProvider::Teams),
    ("meet.google.com", MeetingProvider::GoogleMeet),
    ("zoom.us", MeetingProvider::Zoom),
    ("webex.com", MeetingProvider::Webex),
];

fn strip_mailto(v: &str) -> String {
    v.strip_prefix("mailto:")
        .or_else(|| v.strip_prefix("MAILTO:"))
        .unwrap_or(v)
        .to_string()
}

fn first_url(text: &str) -> Option<String> {
    let start = text.find("https://")?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn detect_provider_in(text: &str) -> Option<(MeetingProvider, String)> {
    let mut best: Option<(usize, MeetingProvider)> = None;
    for (host, prov) in KNOWN_HOSTS {
        if let Some(idx) = text.find(host) {
            if best.is_none_or(|(b, _)| idx < b) {
                best = Some((idx, *prov));
            }
        }
    }
    best.and_then(|(host_idx, prov)| {
        let s = text[..host_idx].rfind("https://")?;
        let rest = &text[s..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"')
            .unwrap_or(rest.len());
        Some((prov, rest[..end].to_string()))
    })
}

fn byday(token: &str) -> Option<(i64, i32)> {
    let token = token.trim();
    let day_part = &token[token.len().saturating_sub(2)..];
    let weekday = match day_part.to_ascii_uppercase().as_str() {
        "SU" => 0,
        "MO" => 1,
        "TU" => 2,
        "WE" => 3,
        "TH" => 4,
        "FR" => 5,
        "SA" => 6,
        _ => return None,
    };
    let prefix = &token[..token.len() - 2];
    let nth = if prefix.is_empty() {
        1
    } else {
        prefix.parse::<i32>().ok()?
    };
    Some((weekday, nth))
}

fn parse_offset(value: &str) -> Option<i32> {
    let v = value.trim();
    let sign = match v.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let digits = &v[1..];
    if digits.len() < 4 {
        return None;
    }
    let hours: i32 = digits.get(0..2)?.parse().ok()?;
    let minutes: i32 = digits.get(2..4)?.parse().ok()?;
    let seconds: i32 = digits.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(sign * (hours * 3600 + minutes * 60 + seconds))
}

fn rrule_field<'a>(value: &'a str, key: &str) -> Option<&'a str> {
    for part in value.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            if k.eq_ignore_ascii_case(key) {
                return Some(v);
            }
        }
    }
    None
}

fn build_rule(offset_to: i32, rrule: Option<&str>, dtstart: Option<&str>) -> VtzRule {
    let (month, weekday, nth) = match rrule {
        Some(r) => {
            let month = rrule_field(r, "BYMONTH")
                .and_then(|m| m.parse::<u32>().ok())
                .unwrap_or(0);
            let (weekday, nth) = rrule_field(r, "BYDAY")
                .and_then(byday)
                .unwrap_or((0, 0));
            (month, weekday, nth)
        }
        None => (0, 0, 0),
    };
    let (hour, minute) = dtstart
        .map(|d| {
            let hh: u32 = d.get(9..11).and_then(|s| s.parse().ok()).unwrap_or(0);
            let mm: u32 = d.get(11..13).and_then(|s| s.parse().ok()).unwrap_or(0);
            (hh, mm)
        })
        .unwrap_or((0, 0));
    VtzRule { offset_to, month, weekday, nth, hour, minute }
}

fn parse_vtimezones(lines: &[ContentLine]) -> HashMap<String, Vtimezone> {
    let mut tzs: HashMap<String, Vtimezone> = HashMap::new();
    let mut tzid: Option<String> = None;
    let mut standard: Option<VtzRule> = None;
    let mut daylight: Option<VtzRule> = None;
    let mut in_vtimezone = false;
    let mut sub: Option<&'static str> = None;
    let mut offset_to: Option<i32> = None;
    let mut rrule: Option<String> = None;
    let mut sub_dtstart: Option<String> = None;

    for line in lines {
        let value = line.value.trim();
        if line.name == "BEGIN" {
            match value {
                "VTIMEZONE" => {
                    in_vtimezone = true;
                    tzid = None;
                    standard = None;
                    daylight = None;
                }
                "STANDARD" if in_vtimezone => {
                    sub = Some("STANDARD");
                    offset_to = None;
                    rrule = None;
                    sub_dtstart = None;
                }
                "DAYLIGHT" if in_vtimezone => {
                    sub = Some("DAYLIGHT");
                    offset_to = None;
                    rrule = None;
                    sub_dtstart = None;
                }
                _ => {}
            }
            continue;
        }
        if line.name == "END" {
            match value {
                "STANDARD" | "DAYLIGHT" if in_vtimezone => {
                    let rule = build_rule(
                        offset_to.unwrap_or(0),
                        rrule.as_deref(),
                        sub_dtstart.as_deref(),
                    );
                    if sub == Some("STANDARD") {
                        standard = Some(rule);
                    } else {
                        daylight = Some(rule);
                    }
                    sub = None;
                }
                "VTIMEZONE" if in_vtimezone => {
                    if let Some(id) = tzid.take() {
                        tzs.insert(id, Vtimezone {
                            standard: standard.take(),
                            daylight: daylight.take(),
                        });
                    }
                    in_vtimezone = false;
                }
                _ => {}
            }
            continue;
        }
        if !in_vtimezone {
            continue;
        }
        match line.name.as_str() {
            "TZID" if sub.is_none() => tzid = Some(line.value.clone()),
            "TZOFFSETTO" if sub.is_some() => offset_to = parse_offset(&line.value),
            "RRULE" if sub.is_some() => rrule = Some(line.value.clone()),
            "DTSTART" if sub.is_some() => sub_dtstart = Some(line.value.clone()),
            _ => {}
        }
    }
    tzs
}

fn method_from(value: &str) -> MeetingMethod {
    match value.trim().to_ascii_uppercase().as_str() {
        "REQUEST" => MeetingMethod::Request,
        "CANCEL" => MeetingMethod::Cancel,
        "REPLY" => MeetingMethod::Reply,
        _ => MeetingMethod::Other,
    }
}

fn detect_dial_in(description: &str) -> Option<String> {
    if let Some(idx) = description.find("tel:") {
        let rest = &description[idx + 4..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"')
            .unwrap_or(rest.len());
        let token = rest[..end].trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    let bytes = description.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let mut j = i + 1;
            let mut digit_count = 0;
            while j < bytes.len() {
                let c = bytes[j];
                if c.is_ascii_digit() {
                    digit_count += 1;
                    j += 1;
                } else if c == b' ' || c == b'-' {
                    j += 1;
                } else {
                    break;
                }
            }
            if digit_count >= 7 {
                let candidate = description[i..j].trim_end_matches([' ', '-']);
                return Some(candidate.to_string());
            }
        }
        i += 1;
    }
    None
}

pub fn parse_invite(bytes: &[u8]) -> Option<MeetingInvite> {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<ContentLine> = unfold(&text).iter().filter_map(|l| parse_line(l)).collect();

    let tzs = parse_vtimezones(&lines);

    let mut method = MeetingMethod::Other;
    let mut in_vevent = false;
    let mut seen_vevent = false;
    let mut depth_in_sub = false;

    let mut title: Option<String> = None;
    let mut location: Option<String> = None;
    let mut uid: Option<String> = None;
    let mut status: Option<String> = None;
    let mut description: Option<String> = None;
    let mut organizer: Option<String> = None;
    let mut organizer_name: Option<String> = None;
    let mut teams_url: Option<String> = None;
    let mut google_url: Option<String> = None;
    let mut start_epoch: Option<i64> = None;
    let mut end_epoch: Option<i64> = None;
    let mut all_day = false;

    for line in &lines {
        let value = line.value.trim();
        match line.name.as_str() {
            "BEGIN" if value == "VEVENT" => {
                if seen_vevent {
                    break;
                }
                in_vevent = true;
                seen_vevent = true;
                continue;
            }
            "END" if value == "VEVENT" && in_vevent => {
                in_vevent = false;
                continue;
            }
            "BEGIN" if in_vevent => {
                depth_in_sub = true;
                continue;
            }
            "END" if in_vevent && depth_in_sub => {
                depth_in_sub = false;
                continue;
            }
            "METHOD" if !in_vevent => {
                method = method_from(&line.value);
                continue;
            }
            _ => {}
        }

        if !in_vevent || depth_in_sub {
            continue;
        }

        match line.name.as_str() {
            "SUMMARY" => title = Some(line.unescaped()),
            "LOCATION" => location = Some(line.unescaped()),
            "UID" => uid = Some(line.value.clone()),
            "STATUS" => status = Some(line.value.trim().to_ascii_uppercase()),
            "DESCRIPTION" => description = Some(line.unescaped()),
            "ORGANIZER" => {
                organizer = Some(strip_mailto(line.value.trim()));
                if let Some(cn) = line.param("CN") {
                    if !cn.is_empty() {
                        organizer_name = Some(cn.to_string());
                    }
                }
            }
            "DTSTART" => {
                let is_date = line.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
                if let Some(r) = resolve_dt(&line.value, line.param("TZID"), is_date, &tzs) {
                    start_epoch = Some(r.epoch);
                    all_day = r.all_day;
                }
            }
            "DTEND" => {
                let is_date = line.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
                if let Some(r) = resolve_dt(&line.value, line.param("TZID"), is_date, &tzs) {
                    end_epoch = Some(r.epoch);
                }
            }
            "X-MICROSOFT-SKYPETEAMSMEETINGURL" => teams_url = Some(line.value.trim().to_string()),
            "X-GOOGLE-CONFERENCE" => google_url = Some(line.value.trim().to_string()),
            _ => {}
        }
    }

    if !seen_vevent {
        return None;
    }

    let description = description.unwrap_or_default();

    let (provider, join_url) = if let Some(url) = teams_url {
        (MeetingProvider::Teams, Some(url))
    } else if let Some(url) = google_url {
        (MeetingProvider::GoogleMeet, Some(url))
    } else if let Some((prov, url)) = detect_provider_in(&description) {
        (prov, Some(url))
    } else if let Some((prov, url)) =
        location.as_deref().and_then(detect_provider_in)
    {
        (prov, Some(url))
    } else if let Some(url) = first_url(&description) {
        (MeetingProvider::Other, Some(url))
    } else {
        (MeetingProvider::Other, None)
    };

    let dial_in = detect_dial_in(&description);

    let cancelled = method == MeetingMethod::Cancel || status.as_deref() == Some("CANCELLED");

    let title = match title {
        Some(t) if !t.is_empty() => t,
        _ => "(no title)".to_string(),
    };

    Some(MeetingInvite {
        title,
        organizer,
        organizer_name,
        location,
        start_epoch,
        end_epoch,
        all_day,
        join_url,
        provider,
        dial_in,
        method,
        cancelled,
        uid,
        attendee_email: None,
        response: None,
        can_rsvp: false,
    })
}

pub(crate) fn epoch_to_ical_utc(epoch: i64) -> String {
    let days = epoch.div_euclid(86400);
    let secs = epoch.rem_euclid(86400);
    let (hh, mm, ss) = ((secs / 3600) as u32, ((secs % 3600) / 60) as u32, (secs % 60) as u32);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", y, m, d, hh, mm, ss)
}

pub fn build_reply_ics(
    invite: &am_core::meeting::MeetingInvite,
    status: am_core::meeting::RsvpStatus,
    attendee_email: &str,
) -> String {
    let mut s = String::new();
    s.push_str("BEGIN:VCALENDAR\r\n");
    s.push_str("PRODID:-//AbeonMail//EN\r\n");
    s.push_str("VERSION:2.0\r\n");
    s.push_str("METHOD:REPLY\r\n");
    s.push_str("BEGIN:VEVENT\r\n");
    if let Some(uid) = &invite.uid {
        s.push_str(&format!("UID:{}\r\n", uid));
    }
    if let Some(org) = &invite.organizer {
        s.push_str(&format!("ORGANIZER:mailto:{}\r\n", org));
    }
    s.push_str(&format!("ATTENDEE;PARTSTAT={}:mailto:{}\r\n", status.partstat(), attendee_email));
    s.push_str(&format!("SUMMARY:{}\r\n", invite.title));
    if let Some(start) = invite.start_epoch {
        s.push_str(&format!("DTSTART:{}\r\n", epoch_to_ical_utc(start)));
    }
    if let Some(end) = invite.end_epoch {
        s.push_str(&format!("DTEND:{}\r\n", epoch_to_ical_utc(end)));
    }
    s.push_str("SEQUENCE:0\r\n");
    s.push_str("END:VEVENT\r\n");
    s.push_str("END:VCALENDAR\r\n");
    s
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

#[cfg(test)]
mod parse_tests {
    use super::*;
    use am_core::meeting::{MeetingMethod, MeetingProvider};

    const SAMPLE: &[u8] = include_bytes!("../tests/fixtures/teams-invite.ics");

    #[test]
    fn parses_sample_core_fields() {
        let inv = parse_invite(SAMPLE).unwrap();
        assert_eq!(inv.title, "Plant Tour 2.0 - project meeting");
        assert_eq!(inv.organizer.as_deref(), Some("Sebastian.Kowalski@alpla.com"));
        assert_eq!(inv.location.as_deref(), Some("Microsoft Teams Meeting"));
        assert_eq!(inv.method, MeetingMethod::Request);
        assert!(!inv.cancelled);
        assert!(inv.uid.is_some());
    }

    #[test]
    fn detects_teams_join_url() {
        let inv = parse_invite(SAMPLE).unwrap();
        assert_eq!(inv.provider, MeetingProvider::Teams);
        let url = inv.join_url.unwrap();
        assert!(url.starts_with("https://teams.microsoft.com/l/meetup-join/"));
    }

    #[test]
    fn resolves_sample_start_to_utc() {
        let inv = parse_invite(SAMPLE).unwrap();
        assert_eq!(inv.start_epoch, Some(civil_to_epoch(2025, 10, 24, 8, 0, 0)));
        assert_eq!(inv.end_epoch, Some(civil_to_epoch(2025, 10, 24, 9, 0, 0)));
    }

    #[test]
    fn detects_dial_in_number() {
        let inv = parse_invite(SAMPLE).unwrap();
        assert!(inv.dial_in.is_some());
    }

    #[test]
    fn zoom_link_in_description_is_detected() {
        let ics = b"BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Z\r\nDTSTART:20250101T100000Z\r\nDESCRIPTION:join https://us02web.zoom.us/j/123 now\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let inv = parse_invite(ics).unwrap();
        assert_eq!(inv.provider, MeetingProvider::Zoom);
        assert!(inv.join_url.unwrap().contains("zoom.us/j/123"));
    }

    #[test]
    fn cancel_method_sets_cancelled() {
        let ics = b"BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:C\r\nDTSTART:20250101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let inv = parse_invite(ics).unwrap();
        assert_eq!(inv.method, MeetingMethod::Cancel);
        assert!(inv.cancelled);
    }

    #[test]
    fn returns_none_without_vevent() {
        assert!(parse_invite(b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").is_none());
    }
}

#[cfg(test)]
mod reply_tests {
    use super::*;
    use am_core::meeting::{MeetingInvite, MeetingMethod, MeetingProvider, RsvpStatus};

    fn invite() -> MeetingInvite {
        MeetingInvite {
            title: "Plant Tour".into(), organizer: Some("org@x.com".into()), organizer_name: None,
            location: None, start_epoch: Some(civil_to_epoch(2025, 10, 24, 8, 0, 0)),
            end_epoch: Some(civil_to_epoch(2025, 10, 24, 9, 0, 0)), all_day: false,
            join_url: None, provider: MeetingProvider::Teams, dial_in: None,
            method: MeetingMethod::Request, cancelled: false, uid: Some("UID-123".into()),
            attendee_email: None, response: None, can_rsvp: true,
        }
    }

    #[test]
    fn reply_has_method_partstat_uid_attendee() {
        let ics = build_reply_ics(&invite(), RsvpStatus::Accepted, "me@x.com");
        assert!(ics.contains("METHOD:REPLY"));
        assert!(ics.contains("PARTSTAT=ACCEPTED"));
        assert!(ics.contains("UID:UID-123"));
        assert!(ics.contains("mailto:me@x.com"));
        assert!(ics.contains("ORGANIZER:mailto:org@x.com"));
        assert!(ics.contains("DTSTART:20251024T080000Z"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
    }

    #[test]
    fn declined_maps_partstat() {
        let ics = build_reply_ics(&invite(), RsvpStatus::Declined, "me@x.com");
        assert!(ics.contains("PARTSTAT=DECLINED"));
    }
}
