# Meeting Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a summary card above the email body for iCalendar meeting invites (Teams / Google Meet / Zoom / Webex) with the meeting time in the user's timezone, a join link, and RSVP (Accept/Tentative/Decline) that emails a `METHOD:REPLY` to the organizer.

**Architecture:** Thick Rust core: a hand-rolled iCalendar parser in `am-mime` turns the stored `text/calendar` attachment bytes into an `am-core::MeetingInvite` (resolving named-Windows timezones to a UTC epoch via the file's own `VTIMEZONE`). A new Tauri command exposes it; the React `MeetingInviteCard` formats the epoch in the browser's local timezone. RSVP is a self-contained queue op drained by the sync engine through the existing SMTP pipeline; the chosen response is persisted in a new `meeting_responses` table.

**Tech Stack:** Rust (rusqlite/refinery, mail-builder, mail-parser, serde, specta), Tauri 2 + tauri-specta bindings, React + TypeScript + @tanstack/react-query + zustand, vitest.

## Global Constraints

- Code identifiers/strings in English only; no code comments (document in `docs/` if essential). User-facing copy may be Polish but match existing UI (existing reader UI uses English labels — keep English for consistency).
- No new Cargo or npm dependency (iCal parsing is hand-rolled).
- Migrations are refinery-embedded from `crates/am-storage/src/migrations`; next free version is **V15**.
- Regenerate bindings after adding/altering any Tauri command: `npm run gen:bindings` (Node 24 at `$HOME/.nvm/versions/node/v24.14.0/bin`).
- Frontend tests: any new `lucide-react` icon must be added to `src/test/lucide-stub.js` or vitest OOMs. `tsconfig` has `noUnusedLocals`/`noUnusedParameters` — unused imports break `npm run build` (vitest does not typecheck).
- Commit style: Conventional Commits, no co-author line, no push.
- Gates per task: `cargo test -p <crate>` for Rust tasks, `npx vitest run <file>` for frontend; whole-feature gates at the end.

---

### Task 1: am-core meeting domain types

**Files:**
- Create: `crates/am-core/src/meeting.rs`
- Modify: `crates/am-core/src/lib.rs` (add `pub mod meeting;`)
- Test: inline `#[cfg(test)]` in `meeting.rs`

**Interfaces:**
- Produces: `am_core::meeting::{MeetingProvider, MeetingMethod, RsvpStatus, MeetingInvite, InviteReply}`; `RsvpStatus::partstat(&self) -> &'static str`; `RsvpStatus::verb(&self) -> &'static str`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsvp_partstat_and_verb() {
        assert_eq!(RsvpStatus::Accepted.partstat(), "ACCEPTED");
        assert_eq!(RsvpStatus::Tentative.partstat(), "TENTATIVE");
        assert_eq!(RsvpStatus::Declined.partstat(), "DECLINED");
        assert_eq!(RsvpStatus::Accepted.verb(), "Accepted");
        assert_eq!(RsvpStatus::Declined.verb(), "Declined");
    }

    #[test]
    fn invite_roundtrips_through_json() {
        let m = MeetingInvite {
            title: "Sync".into(), organizer: Some("o@x.com".into()), organizer_name: None,
            location: None, start_epoch: Some(1), end_epoch: Some(2), all_day: false,
            join_url: None, provider: MeetingProvider::Other, dial_in: None,
            method: MeetingMethod::Request, cancelled: false, uid: Some("u".into()),
            attendee_email: None, response: None, can_rsvp: false,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: MeetingInvite = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `cargo test -p am-core meeting` → FAIL (module missing).

- [ ] **Step 3: Implement `meeting.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingProvider { Teams, GoogleMeet, Zoom, Webex, Other }

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingMethod { Request, Cancel, Reply, Other }

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RsvpStatus { Accepted, Tentative, Declined }

impl RsvpStatus {
    pub fn partstat(&self) -> &'static str {
        match self { RsvpStatus::Accepted => "ACCEPTED", RsvpStatus::Tentative => "TENTATIVE", RsvpStatus::Declined => "DECLINED" }
    }
    pub fn verb(&self) -> &'static str {
        match self { RsvpStatus::Accepted => "Accepted", RsvpStatus::Tentative => "Tentative", RsvpStatus::Declined => "Declined" }
    }
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MeetingInvite {
    pub title: String,
    pub organizer: Option<String>,
    pub organizer_name: Option<String>,
    pub location: Option<String>,
    pub start_epoch: Option<i64>,
    pub end_epoch: Option<i64>,
    pub all_day: bool,
    pub join_url: Option<String>,
    pub provider: MeetingProvider,
    pub dial_in: Option<String>,
    pub method: MeetingMethod,
    pub cancelled: bool,
    pub uid: Option<String>,
    pub attendee_email: Option<String>,
    pub response: Option<RsvpStatus>,
    pub can_rsvp: bool,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct InviteReply {
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: String,
    pub subject: String,
    pub text_body: String,
    pub ics: String,
}
```

Add `pub mod meeting;` to `crates/am-core/src/lib.rs` (alongside the other `pub mod` lines).

- [ ] **Step 4: Run to verify it passes** — `cargo test -p am-core meeting` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): add am-core meeting domain types"`

---

### Task 2: iCalendar lexer (unfold + tokenize + unescape)

**Files:**
- Create: `crates/am-mime/src/ical.rs`
- Modify: `crates/am-mime/src/lib.rs` (add `pub mod ical;`)
- Test: inline `#[cfg(test)]` in `ical.rs`

**Interfaces:**
- Produces: `pub(crate) struct ContentLine { pub name: String, pub params: Vec<(String, String)>, pub value: String }`; `impl ContentLine { pub fn param(&self, key: &str) -> Option<&str>; pub fn unescaped(&self) -> String }`; `pub(crate) fn unfold(raw: &str) -> Vec<String>`; `pub(crate) fn parse_line(line: &str) -> Option<ContentLine>`.

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfold_joins_continuation_lines() {
        let raw = "DESCRIPTION:Hello\r\n World\r\nSUMMARY:Hi\r\n";
        let lines = unfold(raw);
        assert_eq!(lines, vec!["DESCRIPTION:Hello World".to_string(), "SUMMARY:Hi".to_string()]);
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
```

- [ ] **Step 2: Run to verify they fail** — `cargo test -p am-mime ical` → FAIL.

- [ ] **Step 3: Implement the lexer**

```rust
pub(crate) struct ContentLine {
    pub name: String,
    pub params: Vec<(String, String)>,
    pub value: String,
}

impl ContentLine {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
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
    // Split at first colon that is not inside a quoted param value.
    let mut in_quote = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ':' if !in_quote => { colon = Some(i); break; }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);

    // head = NAME(;PARAM=VAL)* with ';' separators outside quotes
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    for c in head.chars() {
        match c {
            '"' => q = !q,
            ';' if !q => { parts.push(std::mem::take(&mut cur)); }
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    let mut iter = parts.into_iter();
    let name = iter.next()?.trim().to_ascii_uppercase();
    let params = iter
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()))
        })
        .collect();
    Some(ContentLine { name, params, value: value.to_string() })
}
```

Add `pub mod ical;` to `crates/am-mime/src/lib.rs`.

- [ ] **Step 4: Run to verify they pass** — `cargo test -p am-mime ical` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): add iCalendar lexer (unfold/tokenize/unescape)"`

---

### Task 3: Datetime + VTIMEZONE resolution to UTC epoch

**Files:**
- Modify: `crates/am-mime/src/ical.rs`
- Test: inline `#[cfg(test)]` in `ical.rs`

**Interfaces:**
- Consumes: `ContentLine` (Task 2).
- Produces: `pub(crate) struct ResolvedTime { pub epoch: i64, pub all_day: bool }`; `pub(crate) struct VtzRule { pub offset_to: i32, pub month: u32, pub weekday: i64, pub nth: i32, pub hour: u32, pub minute: u32 }`; `pub(crate) struct Vtimezone { pub standard: Option<VtzRule>, pub daylight: Option<VtzRule> }`; `pub(crate) fn civil_to_epoch(y: i64, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> i64`; `pub(crate) fn resolve_dt(value: &str, tzid: Option<&str>, is_date: bool, tzs: &std::collections::HashMap<String, Vtimezone>) -> Option<ResolvedTime>`; `impl Vtimezone { pub fn offset_at(&self, y: i64, m: u32, d: u32, hh: u32, mm: u32) -> i32 }`.

**Notes:** `civil_to_epoch` uses Howard Hinnant's days-from-civil (pure integer, no chrono). `offset_at` evaluates the yearly DST rules; `weekday` is 0=Sunday..6=Saturday matching iCal `BYDAY` (SU/MO/…). Northern vs southern hemisphere handled by comparing transition month order.

- [ ] **Step 1: Write failing tests**

```rust
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
        // 2025-07-01 10:00 CEST (+2) == 08:00 UTC
        let r = resolve_dt("20250701T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 7, 1, 8, 0, 0));
    }

    #[test]
    fn winter_date_uses_cet_plus_one() {
        // 2025-12-01 10:00 CET (+1) == 09:00 UTC
        let r = resolve_dt("20251201T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 12, 1, 9, 0, 0));
    }

    #[test]
    fn sample_event_oct24_is_dst_plus_two() {
        // 2025-10-24 10:00 is before the last-Sunday-of-October switch → still CEST (+2) == 08:00 UTC
        let r = resolve_dt("20251024T100000", Some("Central European Standard Time"), false, &cet()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 8, 0, 0));
    }

    #[test]
    fn floating_time_treated_as_utc_naive() {
        let r = resolve_dt("20251024T100000", None, false, &HashMap::new()).unwrap();
        assert_eq!(r.epoch, civil_to_epoch(2025, 10, 24, 10, 0, 0));
    }
}
```

- [ ] **Step 2: Run to verify they fail** — `cargo test -p am-mime dt_tests` → FAIL.

- [ ] **Step 3: Implement resolution**

```rust
use std::collections::HashMap;

pub(crate) struct ResolvedTime { pub epoch: i64, pub all_day: bool }

pub(crate) struct VtzRule {
    pub offset_to: i32,
    pub month: u32,
    pub weekday: i64, // 0=Sun..6=Sat
    pub nth: i32,     // 1..=5 or -1 (last)
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
    // 1970-01-01 is Thursday=4 in 0=Sun..6=Sat
    ((days % 7) + 4 + 7 * 1000) % 7
}

fn nth_weekday_local(year: i64, month: u32, weekday: i64, nth: i32, hour: u32, minute: u32) -> i64 {
    let days_in_month = {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        match month { 1 => 31, 2 => if leap { 29 } else { 28 }, 3 => 31, 4 => 30, 5 => 31,
            6 => 30, 7 => 31, 8 => 31, 9 => 30, 10 => 31, 11 => 30, _ => 31 }
    };
    let day = if nth < 0 {
        let mut d = days_in_month;
        loop {
            let ed = civil_to_epoch(year, month, d, 0, 0, 0) / 86400;
            if weekday_of_epoch_day(ed) == weekday { break d; }
            d -= 1;
        }
    } else {
        let mut count = 0;
        let mut d = 1;
        loop {
            let ed = civil_to_epoch(year, month, d, 0, 0, 0) / 86400;
            if weekday_of_epoch_day(ed) == weekday { count += 1; if count == nth { break d; } }
            d += 1;
            if d > days_in_month { break days_in_month; }
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
                if in_dst { dst.offset_to } else { std.offset_to }
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
    tzs: &HashMap<String, Vtimezone>,
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
```

- [ ] **Step 4: Run to verify they pass** — `cargo test -p am-mime dt_tests` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): resolve iCal datetimes to UTC epoch via VTIMEZONE"`

---

### Task 4: parse_invite — assemble MeetingInvite (provider/link/dial-in)

**Files:**
- Modify: `crates/am-mime/src/ical.rs`
- Test: inline `#[cfg(test)]` in `ical.rs`; fixture `crates/am-mime/tests/fixtures/teams-invite.ics` (copy of `docs/attachment`)

**Interfaces:**
- Consumes: lexer (Task 2), resolution (Task 3), `am_core::meeting::*` (Task 1).
- Produces: `pub fn parse_invite(bytes: &[u8]) -> Option<am_core::meeting::MeetingInvite>`.

**Notes:** Parse all content lines once; collect `VTIMEZONE` blocks into the `HashMap<String, Vtimezone>` (track current `TZID`, and whether inside `STANDARD`/`DAYLIGHT`, reading `TZOFFSETTO`, `RRULE` `BYMONTH`/`BYDAY`, and the sub-`DTSTART` time). Then read the first `VEVENT`. `BYDAY` weekday map: SU=0,MO=1,TU=2,WE=3,TH=4,FR=5,SA=6; `BYDAY=-1SU` → weekday=0, nth=-1; `BYDAY=2SU` → weekday=0, nth=2. Organizer/attendee values look like `mailto:x@y` (case-insensitive `mailto:` prefix). `provider`/`join_url` per spec ordering. `dial_in`: first `tel:` token in DESCRIPTION, else first `+\d[\d \-]{6,}` match.

- [ ] **Step 1: Write failing tests** (copy `docs/attachment` to the fixture path first)

```bash
mkdir -p crates/am-mime/tests/fixtures
cp docs/attachment crates/am-mime/tests/fixtures/teams-invite.ics
```

```rust
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
        // 2025-10-24 10:00 CEST == 08:00 UTC
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
```

- [ ] **Step 2: Run to verify they fail** — `cargo test -p am-mime parse_tests` → FAIL.

- [ ] **Step 3: Implement `parse_invite`** (and private helpers `parse_vtimezones`, `detect_link`, `detect_dial_in`, `byday`, `strip_mailto`). Pseudocode contract to implement:

```rust
use am_core::meeting::{MeetingInvite, MeetingMethod, MeetingProvider};

const KNOWN_HOSTS: &[(&str, MeetingProvider)] = &[
    ("teams.microsoft.com", MeetingProvider::Teams),
    ("meet.google.com", MeetingProvider::GoogleMeet),
    ("zoom.us", MeetingProvider::Zoom),
    ("webex.com", MeetingProvider::Webex),
];

fn strip_mailto(v: &str) -> String {
    v.strip_prefix("mailto:").or_else(|| v.strip_prefix("MAILTO:")).unwrap_or(v).to_string()
}

fn first_url(text: &str) -> Option<String> {
    let start = text.find("https://")?;
    let rest = &text[start..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn detect_provider_in(text: &str) -> Option<(MeetingProvider, String)> {
    let mut best: Option<(usize, MeetingProvider)> = None;
    for (host, prov) in KNOWN_HOSTS {
        if let Some(idx) = text.find(host) {
            if best.map_or(true, |(b, _)| idx < b) { best = Some((idx, *prov)); }
        }
    }
    // Re-extract the URL that contains the matched host (search backward to https://).
    // Implementation: find host index, find the "https://" preceding it, take until delimiter.
    best.and_then(|(_, prov)| {
        for (host, _) in KNOWN_HOSTS {
            if let Some(hidx) = text.find(host) {
                if let Some(s) = text[..hidx].rfind("https://") {
                    let rest = &text[s..];
                    let end = rest.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"').unwrap_or(rest.len());
                    return Some((prov, rest[..end].to_string()));
                }
            }
        }
        None
    })
}
```

`parse_invite` algorithm:
1. `let text = String::from_utf8_lossy(bytes); let lines: Vec<ContentLine> = unfold(&text).iter().filter_map(|l| parse_line(l)).collect();`
2. First pass: build `tzs: HashMap<String, Vtimezone>` by walking `BEGIN:VTIMEZONE`/`TZID`/`BEGIN:STANDARD`|`DAYLIGHT`/`TZOFFSETTO`/`RRULE`/`DTSTART`/`END`.
3. `method` from top-level `METHOD` (`REQUEST`→Request, `CANCEL`→Cancel, `REPLY`→Reply, else Other).
4. Second pass over the first `VEVENT` (between `BEGIN:VEVENT`..`END:VEVENT`): collect `SUMMARY`, `LOCATION`, `UID`, `STATUS`, `DESCRIPTION` (unescaped), `ORGANIZER` (+`CN` param → organizer_name), `DTSTART`/`DTEND` (+`TZID`/`VALUE` params, via `resolve_dt`), and raw values for `X-MICROSOFT-SKYPETEAMSMEETINGURL`, `X-GOOGLE-CONFERENCE`.
5. Link detection order: Teams X-field → `(Teams, url)`; Google X-field → `(GoogleMeet, url)`; else `detect_provider_in(&description)` then `detect_provider_in(&location)`; else `first_url(&description)` → `(Other, url)`.
6. `cancelled = method == Cancel || status == "CANCELLED"`.
7. `can_rsvp`, `attendee_email`, `response` left default (`false`/`None`) — filled by the command in Task 9.
8. Return `None` if no `VEVENT` seen.

Make `parse_invite` set `title` to `SUMMARY` (unescaped) or `"(no title)"` when empty.

- [ ] **Step 4: Run to verify they pass** — `cargo test -p am-mime parse_tests` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): parse iCal VEVENT into MeetingInvite"`

---

### Task 5: build_reply_ics — generate METHOD:REPLY calendar

**Files:**
- Modify: `crates/am-mime/src/ical.rs`
- Test: inline `#[cfg(test)]` in `ical.rs`

**Interfaces:**
- Consumes: `am_core::meeting::{MeetingInvite, RsvpStatus}`.
- Produces: `pub fn build_reply_ics(invite: &MeetingInvite, status: RsvpStatus, attendee_email: &str) -> String`.

**Notes:** Re-serialize start/end as UTC `…Z` from `start_epoch`/`end_epoch` via an `epoch_to_ical_utc(epoch) -> String` helper (inverse of `civil_to_epoch`, format `YYYYMMDDTHHMMSSZ`). Lines must be CRLF-terminated. Fold lines >75 octets is acceptable to skip for the short fields we emit (UID may be long — fold it).

- [ ] **Step 1: Write failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify they fail** — `cargo test -p am-mime reply_tests` → FAIL.

- [ ] **Step 3: Implement `build_reply_ics` + `epoch_to_ical_utc`**

```rust
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
    if let Some(uid) = &invite.uid { s.push_str(&format!("UID:{}\r\n", uid)); }
    if let Some(org) = &invite.organizer { s.push_str(&format!("ORGANIZER:mailto:{}\r\n", org)); }
    s.push_str(&format!("ATTENDEE;PARTSTAT={}:mailto:{}\r\n", status.partstat(), attendee_email));
    s.push_str(&format!("SUMMARY:{}\r\n", invite.title));
    if let Some(start) = invite.start_epoch { s.push_str(&format!("DTSTART:{}\r\n", epoch_to_ical_utc(start))); }
    if let Some(end) = invite.end_epoch { s.push_str(&format!("DTEND:{}\r\n", epoch_to_ical_utc(end))); }
    s.push_str("SEQUENCE:0\r\n");
    s.push_str("END:VEVENT\r\n");
    s.push_str("END:VCALENDAR\r\n");
    s
}
```

- [ ] **Step 4: Run to verify they pass** — `cargo test -p am-mime reply_tests` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): build METHOD:REPLY iCalendar for RSVP"`

---

### Task 6: build_invite_reply — RFC822 with text/calendar part

**Files:**
- Modify: `crates/am-mime/src/compose.rs`
- Test: inline `#[cfg(test)]` in `compose.rs`

**Interfaces:**
- Consumes: `am_core::meeting::InviteReply`.
- Produces: `pub fn build_invite_reply(reply: &am_core::meeting::InviteReply) -> Vec<u8>`.

**Notes:** Mirror `build_message`'s use of `MessageBuilder` + `MimePart`. Build `multipart/alternative` with a `text/plain` part and a `text/calendar; method=REPLY; charset=utf-8` part. Do NOT route through `sanitize_html`.

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn invite_reply_has_calendar_part_and_headers() {
    use am_core::meeting::InviteReply;
    let r = InviteReply {
        from_address: "me@x.com".into(), from_name: Some("Me".into()),
        to: "org@x.com".into(), subject: "Accepted: Plant Tour".into(),
        text_body: "Me has accepted.".into(),
        ics: "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n".into(),
    };
    let bytes = super::build_invite_reply(&r);
    let text = String::from_utf8_lossy(&bytes).to_lowercase();
    assert!(text.contains("text/calendar"));
    assert!(text.contains("method=reply"));
    let parsed = mail_parser::MessageParser::default().parse(&bytes).unwrap();
    assert_eq!(parsed.subject().unwrap(), "Accepted: Plant Tour");
    assert_eq!(parsed.to().unwrap().first().unwrap().address().unwrap(), "org@x.com");
}
```

- [ ] **Step 2: Run to verify it fails** — `cargo test -p am-mime invite_reply` → FAIL.

- [ ] **Step 3: Implement `build_invite_reply`**

```rust
pub fn build_invite_reply(reply: &am_core::meeting::InviteReply) -> Vec<u8> {
    let from = match &reply.from_name {
        Some(name) => Address::new_address(Some(name.clone()), reply.from_address.clone()),
        None => Address::new_address(None::<String>, reply.from_address.clone()),
    };
    let text_part = MimePart::new("text/plain", BodyPart::Text(reply.text_body.clone().into()));
    let cal_part = MimePart::new(
        "text/calendar; method=REPLY; charset=utf-8",
        BodyPart::Text(reply.ics.clone().into()),
    );
    let body = MimePart::new("multipart/alternative", vec![text_part, cal_part]);
    MessageBuilder::new()
        .from(from)
        .to(reply.to.clone())
        .subject(reply.subject.clone())
        .body(body)
        .write_to_vec()
        .unwrap_or_default()
}
```

- [ ] **Step 4: Run to verify it passes** — `cargo test -p am-mime invite_reply` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(meeting): build RFC822 RSVP reply with text/calendar part"`

---

### Task 7: am-storage — V15 migration + meeting_responses_repo

**Files:**
- Create: `crates/am-storage/src/migrations/V15__meeting_responses.sql`
- Create: `crates/am-storage/src/meeting_responses_repo.rs`
- Modify: `crates/am-storage/src/lib.rs` (add `pub mod meeting_responses_repo;`)
- Test: inline `#[cfg(test)]` in the repo

**Interfaces:**
- Produces: `meeting_responses_repo::set_response(db: &Database, message_id: i64, status: am_core::meeting::RsvpStatus, now: i64) -> Result<(), StorageError>`; `get_response(db: &Database, message_id: i64) -> Result<Option<am_core::meeting::RsvpStatus>, StorageError>`.

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE meeting_responses (
    message_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,
    responded_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use am_core::meeting::RsvpStatus;
    use crate::db::Database;
    // reuse a seed_message helper pattern from attachments_repo tests

    #[test]
    fn set_then_get_roundtrips_and_upserts() {
        let db = Database::open_in_memory().unwrap();
        let msg_id = super::tests_support::seed_message(&db);
        assert_eq!(get_response(&db, msg_id).unwrap(), None);
        set_response(&db, msg_id, RsvpStatus::Tentative, 100).unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), Some(RsvpStatus::Tentative));
        set_response(&db, msg_id, RsvpStatus::Accepted, 200).unwrap();
        assert_eq!(get_response(&db, msg_id).unwrap(), Some(RsvpStatus::Accepted));
    }
}
```

(For the seed helper, copy the `seed_message` body from `attachments_repo.rs` tests into a small `tests_support` module or inline it — the executor should mirror that existing helper.)

- [ ] **Step 3: Run to verify they fail** — `cargo test -p am-storage meeting_responses` → FAIL.

- [ ] **Step 4: Implement the repo**

```rust
use rusqlite::params;
use am_core::meeting::RsvpStatus;
use crate::db::{Database, StorageError};

fn status_str(s: RsvpStatus) -> &'static str {
    match s { RsvpStatus::Accepted => "accepted", RsvpStatus::Tentative => "tentative", RsvpStatus::Declined => "declined" }
}
fn status_from(s: &str) -> Option<RsvpStatus> {
    match s { "accepted" => Some(RsvpStatus::Accepted), "tentative" => Some(RsvpStatus::Tentative), "declined" => Some(RsvpStatus::Declined), _ => None }
}

pub fn set_response(db: &Database, message_id: i64, status: RsvpStatus, now: i64) -> Result<(), StorageError> {
    db.conn().execute(
        "INSERT INTO meeting_responses (message_id, status, responded_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, responded_at = excluded.responded_at",
        params![message_id, status_str(status), now],
    )?;
    Ok(())
}

pub fn get_response(db: &Database, message_id: i64) -> Result<Option<RsvpStatus>, StorageError> {
    let conn = db.conn();
    let row: Option<String> = conn.query_row(
        "SELECT status FROM meeting_responses WHERE message_id = ?1",
        params![message_id],
        |r| r.get(0),
    ).map(Some).or_else(|e| match e { rusqlite::Error::QueryReturnedNoRows => Ok(None), other => Err(other) })?;
    Ok(row.and_then(|s| status_from(&s)))
}
```

Add `pub mod meeting_responses_repo;` to `crates/am-storage/src/lib.rs`.

- [ ] **Step 5: Run to verify they pass + migration runs** — `cargo test -p am-storage meeting_responses` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(meeting): V15 meeting_responses table + repo"`

---

### Task 8: am-sync — enqueue + drain RSVP replies + engine wiring

**Files:**
- Modify: `crates/am-sync/src/send.rs`
- Modify: `crates/am-sync/src/engine.rs` (call `drain_invite_replies` in the account loop, after `drain_outbox`)
- Test: inline `#[cfg(test)]` in `send.rs`

**Interfaces:**
- Consumes: `am_core::meeting::InviteReply`, `am_mime::compose::build_invite_reply`.
- Produces: `pub fn enqueue_invite_reply(db: &Database, account_id: i64, reply: &am_core::meeting::InviteReply) -> Result<(), SyncError>`; `pub async fn drain_invite_replies(db: &Database, account_id: i64, creds: &dyn CredentialSource, sink: &dyn SyncEventSink, now: i64) -> Result<(), SyncError>`.

**Notes:** Mirror `enqueue_send`/`drain_outbox`. The op_type is `"send_invite_reply"`; the payload is `serde_json::to_string(reply)`. Drain: filter `op.op_type == "send_invite_reply"`, deserialize `InviteReply`, `build_invite_reply`, `send_raw` to `[reply.to]` from `reply.from_address`; success → `mark_done`; error → `handle_send_failure` (reuse). No Sent APPEND.

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn enqueue_invite_reply_creates_op() {
    use am_core::meeting::InviteReply;
    let db = Database::open_in_memory().unwrap();
    let account_id = /* seed account, mirror existing send.rs tests */ seed_account(&db);
    let reply = InviteReply {
        from_address: "me@x.com".into(), from_name: None, to: "org@x.com".into(),
        subject: "Accepted: X".into(), text_body: "ok".into(), ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into(),
    };
    enqueue_invite_reply(&db, account_id, &reply).unwrap();
    let due = queue_repo::list_due(&db, account_id, now_secs() + 1).unwrap();
    assert!(due.iter().any(|o| o.op_type == "send_invite_reply"));
}
```

(Use the same account-seeding helper already present in `send.rs`'s test module.)

- [ ] **Step 2: Run to verify it fails** — `cargo test -p am-sync enqueue_invite_reply` → FAIL.

- [ ] **Step 3: Implement enqueue + drain in `send.rs`**

```rust
pub fn enqueue_invite_reply(db: &Database, account_id: i64, reply: &am_core::meeting::InviteReply) -> Result<(), SyncError> {
    let payload = serde_json::to_string(reply).map_err(|e| SyncError::Other(e.to_string()))?;
    queue_repo::enqueue(db, account_id, "send_invite_reply", &payload)?;
    Ok(())
}

pub async fn drain_invite_replies(db: &Database, account_id: i64, creds: &dyn CredentialSource, sink: &dyn SyncEventSink, now: i64) -> Result<(), SyncError> {
    let due = queue_repo::list_due(db, account_id, now)?;
    let ops: Vec<_> = due.into_iter().filter(|o| o.op_type == "send_invite_reply").collect();
    if ops.is_empty() { return Ok(()); }
    let account = accounts_repo::get_account(db, account_id)?;
    let endpoints = load_endpoints_pub(db, account_id)?;
    let auth = creds.auth_for(&account).await?;
    for op in ops {
        let reply: am_core::meeting::InviteReply = match serde_json::from_str(&op.payload) {
            Ok(v) => v,
            Err(_) => { queue_repo::mark_done(db, op.id)?; continue; }
        };
        let bytes = am_mime::compose::build_invite_reply(&reply);
        let smtp = smtp_config(&endpoints, &account.email);
        let recipients = vec![reply.to.clone()];
        match send_raw(&smtp, &auth.to_smtp(), &reply.from_address, &recipients, &bytes).await {
            Ok(()) => queue_repo::mark_done(db, op.id)?,
            Err(e) => handle_send_failure(db, sink, account_id, op.id, op.attempts, &e.to_string(), now_secs())?,
        }
    }
    Ok(())
}
```

(If `SyncError` has no `Other` variant, map the serde error with the same pattern the crate already uses for serialization failures — check the enum and reuse.)

- [ ] **Step 4: Wire the engine** — in `crates/am-sync/src/engine.rs` account loop, right after the existing `drain_outbox(...)` call (~line 91), add:

```rust
let _ = crate::send::drain_invite_replies(&db, account_id, creds.as_ref(), sink.as_ref(), now).await;
```

- [ ] **Step 5: Run to verify it passes** — `cargo test -p am-sync` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(meeting): queue + drain RSVP replies through SMTP"`

---

### Task 9: am-app — meeting_invite, respond_to_invite, open_external_url + bindings

**Files:**
- Modify: `crates/am-app/src/commands.rs`
- Modify: `crates/am-app/src/lib.rs` (register 3 commands in `collect_commands![...]`)
- Test: inline unit tests for the pure helper `select_calendar_attachment`

**Interfaces:**
- Consumes: `am_mime::ical::parse_invite`, `am_storage::{attachments_repo, meeting_responses_repo, accounts_repo, messages_repo}`, `am_sync::send::enqueue_invite_reply`.
- Produces commands: `meeting_invite(message_id: i64) -> Option<MeetingInvite>`; `respond_to_invite(message_id: i64, status: RsvpStatus) -> Result<(), String>`; `open_external_url(url: String) -> Result<(), String>`.

**Notes:** To find the calendar attachment, the command needs raw rows incl. mime_type/content. `attachments_repo::list_meta` excludes content; add a small helper `attachments_repo::list_calendar(db, message_id) -> Vec<(String /*mime*/, String /*filename*/, Vec<u8>)>` (SELECT mime_type, filename, content WHERE message_id=?1) OR reuse `list_meta`+`get_content`. Implement `attachments_repo::calendar_content(db, message_id) -> Result<Option<Vec<u8>>, StorageError>` that returns the first row where `lower(mime_type) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics'`. The pure selector `select_calendar_attachment` lives in commands.rs only if needed; otherwise put the SQL in the repo and unit-test the repo.

- [ ] **Step 1: Add repo accessor + test** in `attachments_repo.rs`:

```rust
pub fn calendar_content(db: &Database, message_id: i64) -> Result<Option<Vec<u8>>, StorageError> {
    let conn = db.conn();
    let row: Option<Vec<u8>> = conn.query_row(
        "SELECT content FROM attachments
         WHERE message_id = ?1 AND content IS NOT NULL
           AND (lower(mime_type) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics')
         ORDER BY id ASC LIMIT 1",
        params![message_id],
        |r| r.get(0),
    ).map(Some).or_else(|e| match e { rusqlite::Error::QueryReturnedNoRows => Ok(None), other => Err(other) })?;
    Ok(row)
}
```

Test (in attachments_repo tests): insert a `text/calendar` attachment with bytes, assert `calendar_content` returns them; insert only a PDF, assert `None`.

- [ ] **Step 2: Run to verify it fails then implement** — `cargo test -p am-storage calendar_content` → FAIL → implement → PASS.

- [ ] **Step 3: Implement the three commands in `commands.rs`**

```rust
#[tauri::command]
#[specta::specta]
pub fn meeting_invite(state: tauri::State<'_, AppState>, message_id: i64) -> Result<Option<am_core::meeting::MeetingInvite>, String> {
    let bytes = match am_storage::attachments_repo::calendar_content(&state.db, message_id).map_err(|e| e.to_string())? {
        Some(b) => b, None => return Ok(None),
    };
    let mut invite = match am_mime::ical::parse_invite(&bytes) { Some(i) => i, None => return Ok(None) };
    invite.response = am_storage::meeting_responses_repo::get_response(&state.db, message_id).map_err(|e| e.to_string())?;
    if let Ok(msg) = am_storage::messages_repo::get_account_email_for_message(&state.db, message_id) {
        invite.attendee_email = Some(msg);
    }
    invite.can_rsvp = !invite.cancelled && invite.uid.is_some() && invite.organizer.is_some() && invite.attendee_email.is_some();
    Ok(Some(invite))
}

#[tauri::command]
#[specta::specta]
pub fn respond_to_invite(state: tauri::State<'_, AppState>, message_id: i64, status: am_core::meeting::RsvpStatus) -> Result<(), String> {
    let bytes = am_storage::attachments_repo::calendar_content(&state.db, message_id).map_err(|e| e.to_string())?
        .ok_or("No calendar attachment")?;
    let invite = am_mime::ical::parse_invite(&bytes).ok_or("Not a meeting invite")?;
    let organizer = invite.organizer.clone().ok_or("Invite has no organizer")?;
    let account_email = am_storage::messages_repo::get_account_email_for_message(&state.db, message_id).map_err(|e| e.to_string())?;
    let account_id = am_storage::messages_repo::account_id_for_message(&state.db, message_id).map_err(|e| e.to_string())?;
    let ics = am_mime::ical::build_reply_ics(&invite, status, &account_email);
    let reply = am_core::meeting::InviteReply {
        from_address: account_email.clone(),
        from_name: None,
        to: organizer,
        subject: format!("{}: {}", status.verb(), invite.title),
        text_body: format!("{} has responded: {}.", account_email, status.verb()),
        ics,
    };
    am_sync::send::enqueue_invite_reply(&state.db, account_id, &reply).map_err(|e| e.to_string())?;
    am_storage::meeting_responses_repo::set_response(&state.db, message_id, status, am_sync::service::now_secs()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_external_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("tel:")) {
        return Err("Unsupported URL scheme".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}
```

This requires two small `messages_repo` accessors — add them with tests (mirror existing `get_recipients`):

```rust
pub fn account_id_for_message(db: &Database, message_id: i64) -> Result<i64, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT f.account_id FROM messages m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
        params![message_id], |r| r.get(0),
    ).map_err(|e| match e { rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound, other => StorageError::Sqlite(other) })
}

pub fn get_account_email_for_message(db: &Database, message_id: i64) -> Result<String, StorageError> {
    let conn = db.conn();
    conn.query_row(
        "SELECT a.email FROM messages m JOIN folders f ON m.folder_id = f.id JOIN accounts a ON f.account_id = a.id WHERE m.id = ?1",
        params![message_id], |r| r.get(0),
    ).map_err(|e| match e { rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound, other => StorageError::Sqlite(other) })
}
```

(Verify the messages↔folders↔accounts column names against `V1__initial_schema.sql` and adjust the JOINs to match; add a repo test that seeds an account+folder+message and asserts both accessors.)

- [ ] **Step 4: Register commands** in `crates/am-app/src/lib.rs` `collect_commands![...]` (add `commands::meeting_invite, commands::respond_to_invite, commands::open_external_url,` near `commands::open_attachment`).

- [ ] **Step 5: Regenerate bindings** — `npm run gen:bindings` then verify `MeetingInvite`, `RsvpStatus`, `meetingInvite`, `respondToInvite`, `openExternalUrl` appear in `src/ipc/bindings.ts`.

- [ ] **Step 6: Build + test** — `cargo test -p am-app -p am-storage` → PASS; `cargo build` → clean.

- [ ] **Step 7: Commit** — `git commit -am "feat(meeting): commands meeting_invite/respond_to_invite/open_external_url"`

---

### Task 10: Frontend — queries + meeting formatter

**Files:**
- Modify: `src/ipc/queries.ts`
- Create: `src/shared/meeting/meeting.ts`
- Test: Create `src/shared/meeting/meeting.test.ts`

**Interfaces:**
- Consumes: `commands.meetingInvite`, `commands.respondToInvite`, `RsvpStatus`, `MeetingInvite`, `MeetingProvider` from `bindings`.
- Produces: `useMeetingInvite(messageId: number | null)`; `useRespondToInvite()`; `formatMeetingRange(startEpoch, endEpoch, allDay, timeFormat)`; `providerLabel(provider)`.

**Notes:** Formatter uses `Intl.DateTimeFormat` in the browser's local timezone. `timeFormat` is the existing `"system" | "12h" | "24h"`; map to `hour12` (use existing helper if `shared/datetime` exposes one — mirror `formatMessageTime`). For all-day, omit time.

- [ ] **Step 1: Write failing formatter tests**

```ts
import { describe, it, expect } from "vitest";
import { formatMeetingRange, providerLabel } from "./meeting";

describe("formatMeetingRange", () => {
  it("formats a same-day range with start and end time", () => {
    // 2025-10-24 08:00Z .. 09:00Z
    const out = formatMeetingRange(1761292800, 1761296400, false, "24h");
    expect(out).toMatch(/2025/);
    expect(out).toContain("–"); // en dash between times
  });

  it("formats all-day without a time", () => {
    const out = formatMeetingRange(1761264000, null, true, "system");
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("providerLabel", () => {
  it("maps provider enum to a human label", () => {
    expect(providerLabel("teams")).toBe("Microsoft Teams");
    expect(providerLabel("google_meet")).toBe("Google Meet");
    expect(providerLabel("zoom")).toBe("Zoom");
    expect(providerLabel("other")).toBe("Online meeting");
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/shared/meeting/meeting.test.ts` → FAIL.

- [ ] **Step 3: Implement `meeting.ts`**

```ts
import type { MeetingProvider, TimeFormat } from "../../ipc/bindings";

function hour12(timeFormat: TimeFormat): boolean | undefined {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return undefined;
}

export function providerLabel(provider: MeetingProvider): string {
  switch (provider) {
    case "teams": return "Microsoft Teams";
    case "google_meet": return "Google Meet";
    case "zoom": return "Zoom";
    case "webex": return "Webex";
    default: return "Online meeting";
  }
}

export function formatMeetingRange(
  startEpoch: number,
  endEpoch: number | null,
  allDay: boolean,
  timeFormat: TimeFormat,
): string {
  const start = new Date(startEpoch * 1000);
  if (allDay) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(start);
  }
  const h12 = hour12(timeFormat);
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: h12 });
  const datePart = dateFmt.format(start);
  const startTime = timeFmt.format(start);
  if (endEpoch == null) return `${datePart}, ${startTime}`;
  const end = new Date(endEpoch * 1000);
  return `${datePart}, ${startTime}–${timeFmt.format(end)}`;
}
```

(If `TimeFormat` is not an exported binding type, import it from wherever `shared/datetime/datetime.ts` defines it — match the existing source of truth.)

- [ ] **Step 4: Add the hooks to `queries.ts`** (mirror `useMessageAttachments` and `useSetFlag`):

```ts
export function useMeetingInvite(messageId: number | null) {
  return useQuery({
    queryKey: ["meeting-invite", messageId],
    queryFn: () => commands.meetingInvite(messageId!).then(unwrap),
    enabled: messageId != null,
  });
}

export function useRespondToInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, status }: { messageId: number; status: RsvpStatus }) =>
      commands.respondToInvite(messageId, status).then(unwrap),
    onSuccess: (_d, { messageId }) => {
      queryClient.invalidateQueries({ queryKey: ["meeting-invite", messageId] });
    },
  });
}
```

(Import `RsvpStatus` from `./bindings` at the top of `queries.ts`.)

- [ ] **Step 5: Run to verify formatter tests pass** — `npx vitest run src/shared/meeting/meeting.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(meeting): frontend queries + date-range formatter"`

---

### Task 11: Frontend — MeetingInviteCard + ConversationView wiring + CSS

**Files:**
- Create: `src/features/reader/MeetingInviteCard.tsx`
- Modify: `src/features/reader/ConversationView.tsx` (render in `ActiveMessage`)
- Modify: `src/features/reader/reader.css` (`.meeting-card*`)
- Modify: `src/test/lucide-stub.js` (add any new icons used: `Video`, `Phone`, `Check`, `X`, `HelpCircle`, `Calendar` — check which already exist)
- Test: Create `src/features/reader/MeetingInviteCard.test.tsx`

**Interfaces:**
- Consumes: `useMeetingInvite`, `useRespondToInvite` (Task 10), `formatMeetingRange`, `providerLabel`, `useUiStore` (`timeFormat`).
- Produces: `<MeetingInviteCard messageId={number} />`.

**Notes:** Render `null` until data loads or when `data == null` or `data.start_epoch == null`. RSVP buttons disabled when `!can_rsvp`. Join button hidden when no `join_url`. When `cancelled`, show a "Cancelled" badge and hide Join + RSVP. Active RSVP button reflects `response`. Use `commands.openExternalUrl` for Join and dial-in. Any new lucide icon must be in `lucide-stub.js`.

- [ ] **Step 1: Write failing component tests**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MeetingInviteCard } from "./MeetingInviteCard";

const mockRespond = vi.fn();
vi.mock("../../ipc/queries", () => ({
  useMeetingInvite: () => ({ data: globalThis.__invite, isLoading: false }),
  useRespondToInvite: () => ({ mutate: mockRespond }),
}));
vi.mock("../../ipc/bindings", () => ({ commands: { openExternalUrl: vi.fn() } }));
vi.mock("../../app/store", () => ({ useUiStore: (sel: any) => sel({ timeFormat: "24h" }) }));

function setInvite(overrides = {}) {
  (globalThis as any).__invite = {
    title: "Plant Tour 2.0", organizer: "org@x.com", organizer_name: null, location: "Microsoft Teams Meeting",
    start_epoch: 1761292800, end_epoch: 1761296400, all_day: false,
    join_url: "https://teams.microsoft.com/l/meetup-join/abc", provider: "teams", dial_in: "+48 22 536 42 02",
    method: "request", cancelled: false, uid: "U1", attendee_email: "me@x.com", response: null, can_rsvp: true,
    ...overrides,
  };
}

beforeEach(() => { mockRespond.mockReset(); setInvite(); });

describe("MeetingInviteCard", () => {
  it("renders title, provider and join button", () => {
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.getByText("Plant Tour 2.0")).toBeTruthy();
    expect(screen.getByText(/Microsoft Teams/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /join/i })).toBeTruthy();
  });

  it("RSVP click triggers the mutation with the chosen status", () => {
    render(<MeetingInviteCard messageId={1} />);
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(mockRespond).toHaveBeenCalledWith({ messageId: 1, status: "accepted" });
  });

  it("cancelled invite hides join and RSVP and shows a badge", () => {
    setInvite({ cancelled: true });
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
  });

  it("no join_url hides the join button", () => {
    setInvite({ join_url: null, provider: "other" });
    render(<MeetingInviteCard messageId={1} />);
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  });

  it("renders nothing when there is no invite", () => {
    (globalThis as any).__invite = null;
    const { container } = render(<MeetingInviteCard messageId={1} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/features/reader/MeetingInviteCard.test.tsx` → FAIL.

- [ ] **Step 3: Implement `MeetingInviteCard.tsx`**

```tsx
import { Video, Phone, Calendar } from "lucide-react";
import { useMeetingInvite, useRespondToInvite } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import type { RsvpStatus } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { formatMeetingRange, providerLabel } from "../../shared/meeting/meeting";

const RSVP_OPTIONS: { status: RsvpStatus; label: string }[] = [
  { status: "accepted", label: "Accept" },
  { status: "tentative", label: "Tentative" },
  { status: "declined", label: "Decline" },
];

export function MeetingInviteCard({ messageId }: { messageId: number }) {
  const { data } = useMeetingInvite(messageId);
  const respond = useRespondToInvite();
  const timeFormat = useUiStore((s) => s.timeFormat);

  if (!data || data.start_epoch == null) return null;

  const when = formatMeetingRange(data.start_epoch, data.end_epoch, data.all_day, timeFormat);

  return (
    <div className="meeting-card">
      <div className="meeting-card__head">
        <Calendar size={18} className="meeting-card__icon" />
        <div className="meeting-card__title-wrap">
          <span className="meeting-card__title">{data.title}</span>
          <span className="meeting-card__when">{when}</span>
        </div>
        {data.cancelled && <span className="meeting-card__badge meeting-card__badge--cancelled">Cancelled</span>}
        {!data.cancelled && <span className="meeting-card__badge">{providerLabel(data.provider)}</span>}
      </div>

      <dl className="meeting-card__meta">
        {data.organizer && (
          <div className="meeting-card__row"><dt>Organizer</dt><dd>{data.organizer_name || data.organizer}</dd></div>
        )}
        {data.location && (
          <div className="meeting-card__row"><dt>Location</dt><dd>{data.location}</dd></div>
        )}
      </dl>

      {!data.cancelled && data.response && (
        <p className="meeting-card__response">Your response: {data.response}</p>
      )}

      {!data.cancelled && (
        <div className="meeting-card__actions">
          {data.can_rsvp && (
            <div className="meeting-card__rsvp" role="group" aria-label="Respond to invitation">
              {RSVP_OPTIONS.map((o) => (
                <button
                  key={o.status}
                  type="button"
                  className={`meeting-card__rsvp-btn${data.response === o.status ? " meeting-card__rsvp-btn--active" : ""}`}
                  onClick={() => respond.mutate({ messageId, status: o.status })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {data.join_url && (
            <button type="button" className="meeting-card__join" onClick={() => commands.openExternalUrl(data.join_url!)}>
              <Video size={16} /> Join meeting
            </button>
          )}
          {data.dial_in && (
            <button type="button" className="meeting-card__dialin" onClick={() => commands.openExternalUrl(`tel:${data.dial_in!.replace(/[^0-9+]/g, "")}`)}>
              <Phone size={14} /> {data.dial_in}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Ensure lucide stub** — add `Video`, `Phone` (and `Calendar` if missing) to `src/test/lucide-stub.js`.

- [ ] **Step 5: Wire into `ConversationView.tsx`** — import `MeetingInviteCard`, and in `ActiveMessage` render it directly above `<MessageBodyView messageId={message.id} />`:

```tsx
<MeetingInviteCard messageId={message.id} />
<MessageBodyView messageId={message.id} />
```

- [ ] **Step 6: Add CSS** in `reader.css` (`.meeting-card`, `.meeting-card__head`, `.meeting-card__title`, `.meeting-card__when`, `.meeting-card__badge`, `.meeting-card__badge--cancelled`, `.meeting-card__meta/__row`, `.meeting-card__response`, `.meeting-card__actions`, `.meeting-card__rsvp`, `.meeting-card__rsvp-btn`, `.meeting-card__rsvp-btn--active`, `.meeting-card__join`, `.meeting-card__dialin`) using existing reader tokens (`--accent`, `--border-subtle`, `--text-*`). Keep it visually consistent with `.reader__details`.

- [ ] **Step 7: Run to verify component tests pass** — `npx vitest run src/features/reader/MeetingInviteCard.test.tsx` → PASS.

- [ ] **Step 8: Whole-feature gates** —
  - `cargo test --workspace` → green (skip live GreenMail/Docker if unavailable; note it).
  - `npx vitest run` → green.
  - `npm run build` → clean (tsc + vite).

- [ ] **Step 9: Commit** — `git commit -am "feat(meeting): meeting invite card in the reader"`

---

## Self-Review notes (author)

- **Spec coverage:** card fields (Task 11) ✓; user-TZ time (Tasks 3/10) ✓; universal link detection Teams/Meet/Zoom/Webex/fallback (Task 4) ✓; RSVP send `METHOD:REPLY` (Tasks 5/6/8/9) ✓; RSVP persisted+shown (Tasks 7/9/11) ✓; send-immediately (Task 9) ✓; cancellations (Tasks 4/11) ✓; all-day (Tasks 3/10) ✓; safe link open (Task 9) ✓; hand-rolled parser / no new deps (Tasks 2–5) ✓.
- **Verify-against-codebase flags for executors:** confirm `SyncError` serde-error variant name (Task 8); confirm `TimeFormat` export + `hour12` helper location in `shared/datetime` (Task 10); confirm messages/folders/accounts column names for the JOINs (Task 9); confirm which lucide icons already exist in the stub (Task 11); confirm `am-mime` already depends on `am-core` (it does — `parse.rs` uses `am_core::message`).
- **Out of scope (carried from spec):** no Sent APPEND for RSVP; response keyed by message_id not UID; no calendar export; RRULE only nth-weekday.
