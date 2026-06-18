# Etap 6-polish — UI fidelity pass do szablonu

Data: 2026-06-18
Status: zaakceptowany (design)
Kontekst: wstawka po etapie 6a, przed 6b — dopracowanie wyglądu istniejącego UI do
szablonu `docs/templates/AbeonMail.html`.

## Cel

Dopasować wygląd działających powierzchni aplikacji (rail, lista wiadomości,
reader, compose) do języka wizualnego szablonu — kolory, typografia, odstępy,
promienie, cienie — oraz przenieść inline-style'e `MailboxRail` na CSS. Dodać
niefunkcjonalne placeholdery (Search / Snoozed / Labels) zgodne z chrome'em
szablonu, z jawnym oznaczeniem braku interakcji.

To pass wizualny: NIE dodaje nowych funkcji domenowych (te należą do 6b–6e).

## Źródło wizualne

`docs/templates/AbeonMail.html` (ekran główny). Pasek tytułu okna z kropkami w
lewym górnym rogu szablonu to atrapa chrome'u macOS — pomijamy (Tauri daje
prawdziwe okno). Layout: sidebar 264px · lista 360px · reader (flex).

Wartości z szablonu (do wiernego portu):
- Sidebar: `width:264px; background:#f8f8fc; border-right:1px solid #ececf4`.
- Logo-badge: 32px, `border-radius:9px`, `background:#4f46e5`, biała litera „A", 16px/800.
- Avatar konta w headerze: 30px, `background:#e0e7ff; color:#4338ca`, 11.5px/700.
- Search-box: `height:38px; background:#f0f0f6; border:1px solid #e6e6ee; border-radius:10px`, ikona + tekst `#9a9ab0` 13px.
- Nagłówek sekcji: 10.5px, 800, `letter-spacing:.09em`, `color:#aaaabf`.
- Pozycja sekcji: `padding:7px 12px; border-radius:9px; color:#55556c; 13px/600`, hover `#efeff7`; licznik `#a0a0b4` 11.5px/700.
- Compose: `height:36px; padding:0 16px; border-radius:9px; background:#4f46e5; color:#fff; 13px/700`, cień `0 6px 14px -6px rgba(79,70,229,.6)`.
- Nagłówek grupy dat: `padding:12px 18px 6px; 10.5px/800; letter-spacing:.07em; color:#aaaabf`.
- Wiersz listy: `padding:10px 16px`, zaznaczony `background:#eef0fe; border-left:3px solid #4f46e5`; avatar 34px; nazwa 13px/700 `#1a1a2e`; czas `#4f46e5` 11px/700; subject 12.5px/600 `#2a2a40`; preview 11.5px `#9090a6`.
- Reader: body `padding:30px 44px`, `max-width:840px; margin:0 auto`; subject `24px/800`; avatar nadawcy 46px; action-bar z przyciskami-ikonami 36px.

## Decyzje (zatwierdzone)

- **Jasny rail wg szablonu** w motywie light; w dark rail pozostaje ciemny →
  tokeny railu stają się theme-aware.
- **Pełne grupowanie dat** (TODAY/YESTERDAY/EARLIER) w wirtualizowanej liście.
- **Pełny re-layout readera** wg szablonu (tylko wpięte akcje).
- **Placeholder + polish** dla elementów przyszłych etapów (niefunkcjonalne atrapy).

## Zakres

### 1. Tokeny motywu (`src/shared/theme/tokens.css`)

Rail staje się theme-aware. Dodać/zmienić zmienne:
- light: `--bg-rail:#f8f8fc`, `--rail-border:#ececf4`, `--rail-item:#55556c`,
  `--rail-section:#aaaabf`, `--rail-hover:#efeff7`, `--rail-count:#a0a0b4`,
  `--rail-search-bg:#f0f0f6`, `--rail-search-border:#e6e6ee`, `--text-on-rail:#1a1a2e`.
- dark: zachować ciemny rail (`--bg-rail:#11111d`/obecny), z odpowiednikami
  rail-* dobranymi do ciemnego tła (jaśniejszy tekst, subtelne bordery).
- Wspólne: promienie 9–10px dla pozycji railu/przycisków; token cienia akcentu
  `--shadow-accent:0 6px 14px -6px rgba(79,70,229,.6)`.

### 2. Rail (`MailboxRail.tsx` → klasy CSS w nowym `MailboxRail.css`)

Przepisać inline-style'e na klasy CSS. Struktura wg szablonu:
- **Header**: logo-badge „A" + „AbeonMail" + avatar konta (inicjały pierwszego/
  wybranego konta, reuse `Avatar`).
- **Search (placeholder)**: stylowany box z ikoną + „Search"; element
  niefunkcjonalny — `aria-disabled="true"`, `title="Search — coming soon"`, brak
  `onClick`. Nie jest to `<input>` ani `<button>` z handlerem → nie „klikalny-martwy".
- **SMART FOLDERS**: All Inboxes / Unread / Flagged (istniejące, klikalne) +
  **Snoozed** jako pozycja `aria-disabled`, wyszarzona, bez handlera.
- **Accounts**: zachować obecną funkcjonalność (wybór konta, drag-drop reorder,
  remove confirm, reauth badge) — tylko restyling na klasy + avatar konta +
  pozycje folderów z istniejącym `unread_count` jako licznik wg szablonu.
- **LABELS (placeholder)**: nagłówek sekcji + muted „Coming soon", niefunkcjonalny.
- **Stopka**: **Add account** + **⚙ Settings** (zachowane, stylowane). Przycisk
  **Compose** PRZENIESIONY z railu do nagłówka listy (patrz niżej).

Zachować wszystkie istniejące `aria-label`/role (smart foldery, konta, remove,
reauth, „Open settings", drag handle) — testy i a11y nie mogą się zepsuć.

### 3. Lista wiadomości (`MessageListPane.tsx` + `MessageListPane.css`)

- **Nagłówek kolumny**: przycisk **Compose** (`aria-label="New message"`,
  otwiera composer — przenosi obecną akcję „New") + statyczna etykieta sortu
  „Newest" (placeholder, niefunkcjonalna, `aria-disabled`).
- **Grupowanie dat**: czysta funkcja `groupLabel(epochSeconds, nowSeconds) →
  "Today" | "Yesterday" | "Earlier"` (testowalna). Lista renderowana jako płaska
  tablica pozycji `{ kind: "header", label } | { kind: "item", ... }`; wirtualizer
  używa `estimateSize(index)` zwracającego wysokość nagłówka (~28px) dla nagłówków
  i `ROW_HEIGHT[density]` dla wierszy. Grupy w kolejności Today→Yesterday→Earlier
  (dane już posortowane malejąco po dacie). Dotyczy zarówno trybu wątkowego, jak i
  smart-folder (oba mają datę).
- **Wiersz**: styl wg szablonu (zaznaczony `#eef0fe` + lewy pasek akcentu, avatar
  34px [istnieje od 6a], typografia nazwa/czas/subject/preview). Zachować dot
  unread, badge'e (flag/count/attachment), kropkę koloru konta w trybie smart.

### 4. Reader (`ConversationView.tsx` + `reader.css`)

Pełny re-layout wg szablonu:
- **Action-bar** (sticky top): Reply / Reply all / Forward (istniejące, wpięte do
  `startReply`) + **Star** wpięty do istniejącego flagowania (`useSetFlag` /
  `setMessageFlags`, toggle `flagged` wiadomości). Brak archive/delete/more
  (niewpięte → pomijamy, bez martwych ikon).
- **Body**: `max-width:840px; margin:0 auto; padding:30px 44px`, subject 24px/800,
  każda wiadomość: avatar nadawcy 46px (reuse `Avatar`), nazwa 15px/700, „to",
  czas; treść przez istniejący `MessageBodyView` (sanitizacja bez zmian).
- **Box odpowiedzi** (dół): „Reply to <nadawca>…" jako afordancja otwierająca
  composer w trybie reply (reuse `startReply`→`openComposer`) + przycisk Send.

`MessageBodyView`/`SafeHtmlFrame` (sanitizacja HTML) — bez zmian logiki.

### 5. Placeholdery — zasada

Każdy placeholder (Search, Snoozed, LABELS, sort „Newest") jest **niefunkcjonalny
i jawnie oznaczony**: brak `onClick`, `aria-disabled="true"`, wizualnie wyszarzony /
muted. Cel: chrome zgodny z szablonem bez „klikalnych-martwych" elementów.

## Architektura / organizacja kodu

- `MailboxRail.tsx`: usunąć inline-style, wprowadzić `MailboxRail.css` (klasy
  `rail__header`, `rail__search`, `rail__section`, `rail__item`, `rail__count`,
  `rail__footer`, itp.). Logika (selektory store, dnd, mutacje) bez zmian.
- `MessageListPane.tsx`: wydzielić czystą funkcję grupowania (np. do
  `src/features/message-list/grouping.ts`) + typ pozycji listy; render nagłówków i
  wierszy w pętli wirtualizera.
- `ConversationView.tsx`: re-layout + nowe klasy w `reader.css`.
- Reuse istniejącego `Avatar` (z `src/shared/appearance/`) w railu i readerze.

## Obsługa błędów

Brak nowych ścieżek danych (pass wizualny). Placeholdery nie wykonują operacji.
Grupowanie dat operuje na już pobranych danych; pusty zbiór → brak nagłówków
(istniejący stan „No messages" zachowany).

## Testy

- `grouping.ts`: testy jednostkowe `groupLabel` (dzisiaj/wczoraj/wcześniej,
  granice dnia, strefa lokalna spójna z istniejącym `formatDate`).
- `MailboxRail.test.tsx`: zaktualizować pod nowy markup; potwierdzić zachowane
  role/aria (smart foldery, foldery, konta, remove, reauth, „Open settings",
  drag handle); Search/Snoozed/LABELS mają `aria-disabled` i brak handlera.
- `MessageListPane.test.tsx`: nagłówki grup dat renderowane; Compose
  (`aria-label="New message"`) otwiera composer; wiersze zachowują selekcję,
  unread dot, badge'e; sort „Newest" `aria-disabled`.
- `ConversationView.test.tsx`: zachowane Reply/Reply all/Forward; Star wywołuje
  flagowanie z poprawnym `messageId`/`flagged`; bottom „Reply to…" otwiera reply.
- Pełny `npm test` zielony; `npm run build` (tsc + vite) czysty.

## Świadomie poza zakresem

- Funkcjonalny Search (→ 6c), prawdziwe Labels (→ 6d), działający Snoozed (→ 6e).
- Zagnieżdżone drzewo folderów (brak hierarchii w modelu danych).
- Liczniki przy smart-folderach (wymagałyby nowych zapytań — brak danych).
- Archive/delete/more w readerze (niewpięte akcje domenowe).
- Funkcjonalny sort (kolejność i tak malejąco po dacie).

## Kryteria ukończenia

- Rail jasny w light / ciemny w dark, zgodny z szablonem; inline-style'e
  przeniesione na CSS; zachowana pełna funkcjonalność railu.
- Lista z nagłówkami grup dat i stylem wierszy wg szablonu; Compose w nagłówku.
- Reader z action-barem (Reply/Reply all/Forward/Star), wyśrodkowanym body i
  boxem odpowiedzi wg szablonu.
- Placeholdery (Search/Snoozed/LABELS/sort) wizualnie zgodne, `aria-disabled`,
  niefunkcjonalne.
- Wszystkie testy zielone; build czysty; **fidelity check** vs
  `docs/templates/AbeonMail.html` (rail/lista/reader) — zgodne.
