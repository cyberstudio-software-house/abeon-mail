# Kliknięcie w powiadomienie systemowe — otwarcie i focus okna — Design

**Status:** approved (design), pending plan
**Data:** 2026-07-29
**Poprzednie:** recipient autocomplete (@ 63ae825, v0.5.0)
**Kontekst:** naprawa zgłoszonego buga — kliknięcie w powiadomienie systemowe nie
otwiera ani nie fokusuje okna aplikacji.

## Diagnoza (root cause)

Kliknięcie nie ma jak wrócić do aplikacji, bo nikt na nie nie czeka.

`tauri-plugin-notification` w wersji desktopowej udostępnia dokładnie trzy
komendy (`src/commands.rs` pluginu): `is_permission_granted`,
`request_permission`, `notify`. Metoda `show()` w `desktop.rs` wykonuje:

```rust
tauri::async_runtime::spawn(async move { let _ = notification.show(); });
```

`NotificationHandle` zwracany przez `notify-rust` — jedyne miejsce pozwalające
nasłuchiwać interakcji — jest natychmiast porzucany. Frontendowe `onAction()`
z pakietu JS podpina się pod kanał `actionPerformed`, rejestrowany wyłącznie
przez warstwę Android/iOS; na desktopie nigdy nie zostanie wywołane. Dodanie
`onAction()` w `events.ts` dałoby więc pozór naprawy bez działania.

Bug nie jest regresją — to brakujące ogniwo, którego nigdy nie było.

## Weryfikacja środowiskowa

Przeprowadzona na docelowym środowisku (COSMIC / Wayland) przed wyborem
rozwiązania.

Serwer powiadomień: `cosmic-notifications 0.1.0` (System76), spec 1.2.
Capabilities zawierają `actions`.

Powiadomienie testowe wysłane przez `gdbus` z akcjami `["default", "Otworz"]`,
z `gdbus monitor` w tle. Po kliknięciu w treść:

```
ActivationToken    (uint32 27, 'td2dMqhGqHo61ZA5iLjTJiKOAfVRtNj4')
ActionInvoked      (uint32 27, 'default')
NotificationClosed (uint32 27, uint32 2)
```

Wnioski:

1. Serwer honoruje konwencję akcji `default` — kliknięcie w treść (bez
   rysowania przycisku) wraca jako `ActionInvoked`. Warunkiem jest
   zadeklarowanie przez powiadomienie co najmniej jednej akcji.
2. `NotificationClosed` (reason 2 = dismissed) przychodzi **po** akcji, nie
   zamiast niej.
3. Podnoszenie okna nie wymaga obsługi `ActivationToken`. Zweryfikowane
   niezależnie: uruchomienie drugiej instancji `/usr/bin/abeonmail` wywołuje
   handler `tauri-plugin-single-instance` (`src-tauri/src/lib.rs`), który
   wykonuje `show()` + `unminimize()` + `set_focus()` — okno podnosi się i
   otrzymuje fokus. Ta sama trójka wystarczy dla powiadomień.

`notify-rust` 4.18 nie obsługuje `ActivationToken` (brak wystąpień w źródle),
więc gdyby punkt 3 wypadł negatywnie, konieczny byłby własny nasłuch D-Bus.
Nie jest.

## Zablokowane decyzje zakresowe

1. **Zachowanie kliknięcia:** focus okna + otwarcie wiadomości. Dla `count == 1`
   otwierana jest konkretna wiadomość; dla agregatu (`count > 1`) — przejście do
   folderu Inbox, którego dotyczyło powiadomienie.
2. **Platformy:** jedna wspólna ścieżka dla Linux/Windows/macOS. Realna
   weryfikacja kliknięcia wyłącznie na Linuksie (patrz Ograniczenia).
3. **Powiadomienie o błędzie wysyłki:** kliknięcie podnosi okno, bez zmiany
   widoku. Baner `SendErrorsBanner` i tak jest widoczny.
4. **Jedno powiadomienie na kategorię:** dwa stałe identyfikatory — jeden dla
   nowej poczty, drugi dla błędów wysyłki. Kolejne powiadomienie w danej
   kategorii zastępuje poprzednie, kategorie nie kolidują. Ogranicza liczbę
   oczekujących wątków do dwóch.
5. **Plugin zostaje** wpięty wyłącznie dla API uprawnień
   (`isPermissionGranted` / `requestPermission` w `NotificationsProvider`).
   Wysyłkę i obsługę kliknięcia przejmuje własna warstwa.

## Architektura

Orkiestracja wysyłki przenosi się z frontendu do Rusta, ponieważ uchwyt
powiadomienia żyje po stronie Rusta. **Gating zostaje we froncie** — tam
naturalnie żyje stan (`notificationsEnabled`, `isFocused()`). To przesunięcie
granicy o jeden krok względem etapu 7b, przy zachowaniu jego filozofii: logika
treści w `am-storage`, orkiestracja tam, gdzie stan.

Przepływ dla nowej poczty:

```
NewMessages{account_id, folder_id, count}
   → events.ts: gating (notificationsEnabled? okno nieaktywne?)
   → commands.show_new_mail_notification(account_id, folder_id, count)
   → notifications_repo: treść + identyfikatory celu
   → notify-rust: .id(STAŁE) .action("default", …) .show()
   → dedykowany wątek: wait_for_response()
        ├─ Default / Action(_) → focus okna + emit NotificationActivated
        └─ Closed(_)           → brak akcji
   → events.ts: nasłuch notificationActivated → nawigacja w store
```

Deklaracja akcji `default` jest obowiązkowa — bez niej serwer XDG nie wyśle
`ActionInvoked` (potwierdzone testem powyżej).

## Rust — am-core

`NotificationContent` rozszerzony o cel kliknięcia:

```rust
pub struct NotificationContent {
    pub title: String,
    pub body: String,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}
```

Oba identyfikatory wypełniane wyłącznie dla `count == 1`.

## Rust — am-storage (`notifications_repo`)

`build_new_mail_notification` — bez zmiany sygnatury i bez nowych zapytań.
Istniejący `SELECT … ORDER BY date DESC LIMIT 1` poszerzony o `id` i
`thread_id`. Zero migracji.

## Rust — am-app (`notify.rs`, nowy moduł)

```rust
pub fn show(app: &AppHandle, id: u32, title: String, body: String, target: NotificationActivated)
```

Cel kliknięcia opisuje wyłącznie `NotificationActivated` — ten sam typ, który
zostanie wyemitowany po aktywacji. `thread_id`/`message_id` z
`NotificationContent` są do niego przepisywane przez komendę, żeby nie
utrzymywać dwóch źródeł prawdy o celu.

Stałe identyfikatory (`id`) są dwa: jeden dla powiadomień o nowej poczcie,
drugi dla błędów wysyłki. Powiadomienia w obrębie jednej kategorii zastępują
się nawzajem, kategorie nie kolidują ze sobą.

Cały cykl — `show()` oraz `wait_for_response()` — wykonywany w jednym
`std::thread::spawn`. Powód: `wait_for_response` konsumuje uchwyt i blokuje,
więc pozostawienie `show()` w wątku wywołującym wymuszałoby przenoszenie
uchwytu między wątkami. Konsekwencja: komenda nie raportuje błędu wysyłki —
parytet z obecnym pluginem, który również ignoruje wynik.

Mapowanie odpowiedzi na decyzję wydzielone jako czysta funkcja (testowalna bez
D-Bus):

- `Default` → aktywacja (Linux),
- `Action(_)` → aktywacja (Windows — `notify-rust` nie wspiera tam `action()`,
  klik wraca jako własny klucz, a akcja jest tylko jedna),
- `Closed(_)` → brak akcji.

Podnoszenie okna: `focus_main_window()` wydzielone z `tray.rs` do miejsca
wspólnego dla traya i powiadomień, zamiast duplikowania.

## Rust — am-app (`events.rs`, `commands.rs`)

Nowy event, dopisany do `collect_events![…]`:

```rust
pub struct NotificationActivated {
    pub account_id: Option<i64>,
    pub folder_id: Option<i64>,
    pub thread_id: Option<i64>,
    pub message_id: Option<i64>,
}
```

Wszystkie pola opcjonalne — powiadomienie o błędzie wysyłki emituje same
`None`, a handler kończy się na podniesieniu okna.

Dwie cienkie komendy dopisane do `collect_commands![…]`:
`show_new_mail_notification(account_id, folder_id, count)` oraz
`show_send_error_notification(error)`.

## Frontend

`src/ipc/events.ts` — `sendNotification` znika z obu miejsc (nowa poczta oraz
błąd wysyłki) na rzecz komend. Gating pozostaje bez zmian. Dochodzi nasłuch
`events.notificationActivated`.

Nawigacja: store nie ma jednej przestrzeni identyfikatorów — `selectRow(id)`
rozgałęzia się po `selectMode`, ustawiając `selectedThreadId` albo
`selectedMessageId`. Dlatego backend oddaje oba identyfikatory, a frontend
wybiera właściwy. Handler ustawia konto i folder **zawsze**, a zaznaczenie
wiersza próbuje dopiero potem.

Zmiana typu IPC i nowy event wymagają `npm run gen:bindings`.

## Obsługa błędów i przypadki brzegowe

**Oczekujące wątki.** Każde powiadomienie trzyma wątek zablokowany do momentu
zamknięcia powiadomienia. Serwer deklaruje `persistence`, więc powiadomienia
mogą wisieć w centrum powiadomień godzinami. Stałe id dla powiadomień o poczcie
ogranicza liczbę żywych wątków do dwóch (poczta + błąd wysyłki). Trade-off:
powiadomienie o mailu z drugiego konta nadpisze poprzednie.

**Podwójne zliczenie kliknięcia.** `NotificationClosed` przychodzi po
`ActionInvoked`. `wait_for_response` oddaje jedną odpowiedź i kończy wątek, więc
problem nie występuje. Przy ewentualnym przejściu na osobne haki
`wait_for_action` + `on_close` trzeba by je rozróżniać.

**Nieaktualny cel.** Między pokazaniem powiadomienia a kliknięciem wiadomość
może zostać usunięta, przeniesiona lub przeczytana na innym urządzeniu. Folder
ustawiany jest zawsze; brak wiersza o danym id kończy się niezaznaczeniem
niczego, bez błędu.

**Brak serwera powiadomień / błąd D-Bus.** `show()` zwraca `Err`, logowany na
`stderr`; wątek się kończy, aplikacja działa dalej — jak dziś.

**Okno schowane do traya.** `show()` przywraca ukryte okno, co pokrywa
scenariusz „zamknąłem do traya, przyszedł mail".

## Testy

**Rust — `notifications_repo`** (dopisane do istniejącego `mod tests`):
`count == 1` zwraca `thread_id`/`message_id` najnowszej wiadomości; `count > 1`
zwraca w nich `None`; folder spoza Inboxa nadal zwraca `None` jako całość.

**Rust — `notify.rs`:** mapowanie odpowiedzi na decyzję — `Default` →
aktywacja, `Action(_)` → aktywacja, `Closed(Dismissed)` / `Closed(Expired)` /
`Closed(CloseAction)` → brak akcji.

**Frontend — `src/ipc/events.test.tsx`** (istnieje, mockuje dziś
`sendNotification` — do przestawienia na mock komendy): wywołanie komendy
zamiast `sendNotification`; nienaruszony gating (wyłączone powiadomienia,
aktywne okno); `notificationActivated` z pełnym celem ustawia konto, folder i
zaznaczenie; z samymi `null` nie rusza nawigacji.

**Weryfikacja manualna** (jedyna możliwa dla realnego kliknięcia): zbudowana
paczka, kliknięcie w powiadomienie, `gdbus monitor` w tle jako świadek.

## Ograniczenia

1. **Windows i macOS pozostaną niezweryfikowane.** Kod jest wspólny, ale klik
   zostanie sprawdzony wyłącznie na Linuksie. Na Windows `notify-rust` nie
   wspiera `action()`, dlatego mapowanie traktuje `Action(_)` jak aktywację —
   założenie oparte na dokumentacji biblioteki, nie na teście.
2. **Realne kliknięcie nie jest pokryte testem automatycznym** — wymaga serwera
   D-Bus i interakcji użytkownika.
3. **Znane wcześniejsze faile vitest** (12: ConversationView ×3,
   useDebouncedValue ×3, store ×6) nie są związane z tą zmianą i nie są w jej
   zakresie.
