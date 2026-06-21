# Meeting invites (zaproszenia na spotkania) — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-21
**Poprzednie:** reader panel polish (@ 1e9ea0f)
**Kontekst:** funkcja samodzielna (poza roadmapą etapów; Etap 7 COMPLETE).
Obsługa załączników iCalendar (`.ics`) typu zaproszenie na spotkanie — Microsoft
Teams, Google Meet, oraz uniwersalnie Zoom/Webex. Próbka: `docs/attachment`
(Exchange `METHOD:REQUEST`, Teams).

## Cel

Nad treścią maila zawierającego zaproszenie kalendarzowe pojawia się karta
podsumowania z: tytułem, **datą i godziną spotkania w strefie czasowej
użytkownika**, organizatorem, lokalizacją, **linkiem do spotkania** (jeśli jest)
oraz numerem dial-in. Karta pozwala odpowiedzieć na zaproszenie (**RSVP**:
Akceptuj / Wstępnie / Odrzuć) — odpowiedź jest wysyłana mailem (`METHOD:REPLY`)
do organizatora, a wybrany stan jest zapisywany lokalnie i pokazywany na karcie.

## Zablokowane decyzje zakresowe

1. **Zakres karty:** bogata + RSVP — tytuł, start–koniec w strefie użytkownika,
   organizator, lokalizacja, przycisk „Dołącz", dial-in oraz akcje RSVP.
2. **Platformy:** uniwersalnie — Teams (`X-MICROSOFT-SKYPETEAMSMEETINGURL`),
   Google Meet (`X-GOOGLE-CONFERENCE`), a dodatkowo dowolny link spotkania po
   znanych domenach (Zoom, Webex) wykrywany w `DESCRIPTION`/`LOCATION`; w
   ostateczności pierwszy link `https://` z opisu.
3. **Stan RSVP:** zapisywany lokalnie i pokazywany na karcie („Twoja odpowiedź:
   …"), z możliwością zmiany.
4. **Wysyłka RSVP:** natychmiast po kliknięciu, bez komentarza (jak „Send now"
   w Outlooku) — kolejka SMTP, bez otwierania composera.
5. **Parsowanie iCal:** własny mini-parser w Rust (zero nowych zależności).
6. **Granica strefy czasowej:** backend rozwiązuje czas do jednego momentu
   **UTC (epoch i64)** używając przesunięć z `VTIMEZONE`; front formatuje go w
   strefie systemowej użytkownika przez `Intl` (z poszanowaniem ustawienia
   System/12h/24h z `shared/datetime`).

## Architektura

Zaproszenie jest częścią `text/calendar` maila. Po otwarciu wiadomości treść i
załączniki są już wyekstrahowane do tabeli `attachments` (część `text/calendar`
ma `is_inline=0` i zapisane bajty `content`). Funkcja dokłada:

- parser iCal w `am-mime` (bajty → typ `am-core::MeetingInvite`),
- komendę odczytu `meeting_invite(message_id)` (znajdź część kalendarzową,
  sparsuj, dolep zapisany stan RSVP),
- migrację V15 + repo trwałości stanu RSVP,
- ścieżkę wysyłki odpowiedzi (`METHOD:REPLY`) jako nowy op kolejki,
- komendę `respond_to_invite`,
- bezpieczne otwieranie linków `open_external_url`,
- komponent `MeetingInviteCard` renderowany w `ActiveMessage` nad
  `<MessageBodyView>`.

Zasada „thick Rust core, thin React": całe parsowanie iCal, rozwiązywanie stref
i budowa odpowiedzi żyją w Rust; React tylko renderuje i formatuje.

## Rust — am-core

Nowy moduł `am_core::meeting` (serde + specta::Type):

```rust
pub enum MeetingProvider { Teams, GoogleMeet, Zoom, Webex, Other }
pub enum MeetingMethod   { Request, Cancel, Reply, Other }   // z METHOD
pub enum RsvpStatus      { Accepted, Tentative, Declined }

pub struct MeetingInvite {
    pub title: String,
    pub organizer: Option<String>,        // adres e-mail organizatora
    pub organizer_name: Option<String>,
    pub location: Option<String>,
    pub start_epoch: Option<i64>,         // UTC; None gdy nie da się rozwiązać
    pub end_epoch: Option<i64>,
    pub all_day: bool,
    pub join_url: Option<String>,
    pub provider: MeetingProvider,
    pub dial_in: Option<String>,          // numer tel. (best-effort)
    pub method: MeetingMethod,
    pub cancelled: bool,                  // METHOD:CANCEL lub STATUS:CANCELLED
    pub uid: Option<String>,
    pub attendee_email: Option<String>,   // adres konta odbierającego (dla RSVP)
    pub response: Option<RsvpStatus>,     // zapisany lokalnie stan RSVP
    pub can_rsvp: bool,                   // jest UID+organizer i nie cancelled
}
```

`response`/`attendee_email`/`can_rsvp` uzupełnia komenda (nie sam parser).

## Rust — am-mime (`ical.rs`)

Czysty, bez I/O, w pełni testowalny.

- **Unfolding + tokenizacja:** rozwija złamane linie (kontynuacja zaczyna się
  spacją/tabem), dzieli na `NAME;PARAM=VAL;…:VALUE`, rozkodowuje escapowanie
  wartości (`\n`, `\,`, `\;`, `\\`).
- **`parse_invite(bytes: &[u8]) -> Option<MeetingInvite>`:** wyciąga pierwszy
  `VEVENT` (`SUMMARY`, `DTSTART`, `DTEND`, `LOCATION`, `ORGANIZER`, `ATTENDEE*`,
  `DESCRIPTION`, `METHOD`, `STATUS`, `UID`, `SEQUENCE`, `X-*` linki) oraz mapę
  `VTIMEZONE`. `None` gdy brak `VEVENT`.
- **Wykrywanie linku/platformy** (kolejność): `X-MICROSOFT-SKYPETEAMSMEETINGURL`
  → Teams; `X-GOOGLE-CONFERENCE` → GoogleMeet; skan `DESCRIPTION`/`LOCATION` po
  domenach `teams.microsoft.com`→Teams, `meet.google.com`→GoogleMeet,
  `zoom.us`→Zoom, `webex.com`→Webex; w ostateczności pierwszy `https://` z opisu
  → `Other`. Brak linku → `provider=Other`, `join_url=None`.
- **Czas → epoch UTC** (`resolve_dt`):
  - wartość kończąca się `Z` → parsuj jako UTC wprost;
  - `VALUE=DATE` (8 cyfr) → `all_day=true`, epoch = lokalna północ tej daty
    traktowana jako UTC (front pokaże samą datę);
  - `TZID=X` + dopasowany `VTIMEZONE` → policz offset aktywny w dacie zdarzenia
    przez ewaluację reguł `STANDARD`/`DAYLIGHT` (`RRULE` typu
    `BYMONTH=…;BYDAY=nDAY` + `TZOFFSETTO`), odejmij od czasu lokalnego → UTC;
  - brak strefy/`VTIMEZONE` → czas „pływający": zwróć naiwny epoch (front
    potraktuje jako lokalny). Limit znany i udokumentowany.
- **`dial_in`:** pierwszy `tel:` lub numer telefonu z `DESCRIPTION` (best-effort,
  regex prosty).
- **`build_reply_ics(invite, status, attendee_email) -> String`:** generuje
  `VCALENDAR` `METHOD:REPLY` z jednym `VEVENT` (ten sam `UID`, `ORGANIZER`,
  jedna linia `ATTENDEE;PARTSTAT=…:mailto:<attendee>`, `SUMMARY`, `DTSTART`/
  `DTEND`, `SEQUENCE`). Mapowanie statusu→PARTSTAT: Accepted→`ACCEPTED`,
  Tentative→`TENTATIVE`, Declined→`DECLINED`. Łamanie linii ≤75 oktetów.

VTIMEZONE: bierzemy `STANDARD`/`DAYLIGHT` z `TZOFFSETTO` i regułą roczną
(`BYMONTH`, `BYDAY=-1SU`/`nDAY`, czas przejścia z `DTSTART` pod-komponentu).
Dla roku zdarzenia wyznaczamy obie daty przejścia i wybieramy offset obowiązujący
w dacie `DTSTART` zdarzenia. Pokrywa reguły EU/US (n-ta niedziela miesiąca), czyli
dokładnie to, co emitują Exchange i Google.

## Rust — am-mime (`compose.rs`)

`build_invite_reply(reply: &InviteReply) -> Vec<u8>` — RFC822 `multipart/
alternative` z `text/plain` (krótki opis typu „<Account> has accepted.") oraz
`text/calendar; method=REPLY; charset=UTF-8` (z `build_reply_ics`). Nagłówki:
`From` (konto), `To` (organizer), `Subject` („Accepted/Tentative/Declined:
<tytuł>"). Nie modyfikuje istniejącego `build_message`.

`InviteReply { from_address, from_name, to (organizer), subject, text_body,
ics }` — lekki typ w `am-core::meeting` (serde, dla payloadu kolejki).

## Rust — am-storage

- **Migracja V15** (`V15__meeting_responses.sql`):
  ```sql
  CREATE TABLE meeting_responses (
      message_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      status       TEXT NOT NULL,        -- accepted|tentative|declined
      responded_at INTEGER NOT NULL
  );
  ```
- **`meeting_responses_repo`:** `set_response(db, message_id, RsvpStatus)`
  (upsert, `responded_at = now`), `get_response(db, message_id) -> Option<RsvpStatus>`.

## Rust — am-sync (`send.rs`)

- `enqueue_invite_reply(db, account_id, &InviteReply)` — serializuje `InviteReply`
  do payloadu i `queue_repo::enqueue(account_id, "send_invite_reply", payload)`.
  (Samowystarczalne — **bez** wpisu w `drafts`.)
- `drain_invite_replies(db, account_id, creds, sink, now)` — analogiczne do
  `drain_outbox`: filtruje `op_type == "send_invite_reply"`, dla każdego buduje
  RFC822 przez `build_invite_reply`, wysyła `send_raw` z konta odbierającego do
  organizatora; sukces → `mark_done`; błąd → `handle_send_failure` (ten sam
  backoff). **Bez** APPEND do Sent w MVP (odpowiedź RSVP nie ląduje w Wysłanych).
- Silnik (`engine.rs`): dorzucenie czwartego `op_type` do pętli draina
  (`set_flag`/`send_message`/`sync_draft`/**`send_invite_reply`**, wzajemnie
  wykluczające filtry).

## Rust — am-app (komendy)

- `meeting_invite(message_id) -> Option<MeetingInvite>` — `attachments_repo`
  szuka części kalendarzowej (`mime_type` zaczyna się `text/calendar` lub nazwa
  `.ics`), pobiera `content`, `am_mime::ical::parse_invite`, dolepia
  `response = meeting_responses_repo::get_response`, ustawia `attendee_email`
  (e-mail konta wiadomości) i `can_rsvp`.
- `respond_to_invite(message_id, status: RsvpStatus) -> Result<(), String>` —
  parsuje zaproszenie, składa `InviteReply` (organizer z invite, attendee =
  e-mail konta), `enqueue_invite_reply`, `meeting_responses_repo::set_response`.
- `open_external_url(url: String) -> Result<(), String>` — allowlista schematów
  (`https`, `tel`), inaczej błąd; `tauri_plugin_opener::open_url`.

Bindings regenerowane (`npm run gen:bindings`). Nowe typy: `MeetingInvite`,
`MeetingProvider`, `MeetingMethod`, `RsvpStatus`.

## Frontend

- `ipc/queries.ts`: `useMeetingInvite(messageId | null)` (enabled gdy id≠null) +
  `useRespondToInvite()` (mutacja → invaliduje `["meeting-invite", messageId]`).
- `shared/meeting/meeting.ts`: czysty formatter zakresu dat z `start_epoch`/
  `end_epoch`/`all_day` w strefie lokalnej (`Intl.DateTimeFormat`, `hour12` z
  istniejącego `timeFormat`); etykiety platform; mapowanie statusu.
- `features/reader/MeetingInviteCard.tsx`: plakietka platformy + tytuł; zakres
  dat (lokalny); organizator; lokalizacja; **Dołącz** (→ `open_external_url`);
  dial-in (jeśli jest → `open_external_url('tel:…')`); segment RSVP (3 przyciski,
  aktywny wg `response`) + linia „Twoja odpowiedź: …"; plakietka **ODWOŁANE** gdy
  `cancelled` (chowa RSVP i Dołącz). Render tylko gdy invite i `start_epoch`.
- `features/reader/ConversationView.tsx`: w `ActiveMessage` `<MeetingInviteCard
  messageId={message.id} accountId={...} />` nad `<MessageBodyView>`.
- CSS w `reader.css` (`meeting-card__*`), tokeny istniejące.

## Przypadki brzegowe

- `METHOD:CANCEL`/`STATUS:CANCELLED` → karta „odwołane", bez RSVP/Dołącz.
- Brak linku → karta bez „Dołącz" (reszta widoczna).
- All-day → sama data (bez godzin).
- Konto spoza listy `ATTENDEE` → RSVP nadal działa, używa adresu konta.
- Wiele `VEVENT` (rekurencja `RECURRENCE-ID`, jak w próbce) → MVP bierze pierwszy.
- Brak `VTIMEZONE` dla nazwanej strefy → czas pływający (lokalny) — znany limit.
- Mail bez części kalendarzowej → komenda zwraca `None`, karta się nie renderuje.

## Testy

- **am-mime ical:** parse próbki `docs/attachment` (tytuł/organizer/location/
  start/end/join_url=Teams); rozwiązywanie stref: CET (zima)→+1h, CEST (lato)→
  +2h, `…Z`→wprost, all-day; wykrywanie platform Teams/Meet/Zoom/Webex/fallback;
  `build_reply_ics` (PARTSTAT per status, ten sam UID, ATTENDEE=konto);
  `unfold`/escape.
- **am-mime compose:** `build_invite_reply` → parsowalny RFC822 z częścią
  `text/calendar` `method=REPLY`, poprawny `To`/`Subject`.
- **am-storage:** `meeting_responses_repo` upsert + get + cascade na DELETE
  message.
- **am-sync:** `enqueue_invite_reply` tworzy op `send_invite_reply`;
  `drain_invite_replies` filtruje i (przy fake/greenmail) wysyła / backoff.
- **frontend:** `meeting.ts` formatter (strefa, 12h/24h, all-day, zakres);
  `MeetingInviteCard` render pól, klik RSVP → mutacja + podświetlenie, stan
  odwołany chowa akcje, brak linku chowa „Dołącz".

## Out of scope / future-work

- Brak APPEND odpowiedzi RSVP do folderu Sent.
- Klucz stanu RSVP po `message_id` (nie po UID zdarzenia) — aktualizacje/
  rekurencje nie współdzielą stanu.
- „Dodaj do kalendarza" / eksport `.ics` (aplikacja nie ma modułu kalendarza).
- Pełna ewaluacja `RRULE` poza wzorcem n-ta-niedziela (rzadkie strefy).
- Edycja komentarza przed wysłaniem RSVP (zdecydowano: wyślij od razu).
