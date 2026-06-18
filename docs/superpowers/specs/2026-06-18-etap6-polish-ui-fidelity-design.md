# Etap 6-polish — UI fidelity pass do szablonu

Data: 2026-06-18
Status: zaakceptowany (design, wersja 2 — po porównaniu zrzutów)
Kontekst: wstawka po etapie 6a, przed 6b — dopracowanie wyglądu istniejącego UI do
szablonu `docs/templates/AbeonMail.html`.

## Cel

Dopasować wygląd działających powierzchni aplikacji (rail, lista wiadomości,
reader, compose) do języka wizualnego szablonu — kolory, typografia, odstępy,
promienie, cienie, **ikony wiodące**, **zagnieżdżone drzewo folderów** — oraz
przenieść inline-style'e `MailboxRail` na CSS. Dodać niefunkcjonalne placeholdery
(Search / Snoozed / Labels / sort) zgodne z chrome'em szablonu.

Pass jest **frontendowy** (brak zmian w Rust/schema). NIE dodaje funkcji domenowych
przyszłych etapów (Search/Labels/Snoozed pozostają atrapami).

## Źródło wizualne

`docs/templates/AbeonMail.html` (ekran główny) + zrzuty porównawcze
(current vs template) dostarczone 2026-06-18. Atrapa chrome'u macOS (kropki) —
pomijamy. Layout: sidebar 264px · lista 360px · reader (flex). Wartości kolorów/
metryk jak w poprzedniej wersji specu (sidebar #f8f8fc, item #55556c, hover #efeff7,
nagłówek sekcji #aaaabf 10.5px/800, count #a0a0b4, search #f0f0f6/#e6e6ee, compose
#4f46e5 z cieniem, wiersz zaznaczony #eef0fe + lewy pasek #4f46e5, avatary 34px/46px,
reader body max-840px, subject 24px/800).

## Decyzje (zatwierdzone)

- **Jasny rail wg szablonu** w light; ciemny w dark → tokeny railu theme-aware.
- **`lucide-react`** jako biblioteka ikon (1:1 z szablonem, tree-shakeable, offline).
- **Zagnieżdżone drzewo folderów** — budowane na froncie z `(remote_path, name)`.
- **Pełne grupowanie dat** (Today/Yesterday/Earlier) w wirtualizowanej liście.
- **Pełny re-layout readera** z toolbar-em ikon (wpięte funkcjonalne, reszta atrapy).
- **Placeholder + polish** dla elementów przyszłych etapów.

## Zależności

Dodać `lucide-react` (`package.json`). Import per-ikona (tree-shake). Używane ikony:
- Rail/smart: `Layers` (All Inboxes), `MailOpen`/`Mail` (Unread), `Flag` (Flagged),
  `Clock` (Snoozed), `Search`, `PencilLine` (Compose), `Settings` (⚙), `Plus`/`UserPlus`
  (Add account), `ChevronRight`/`ChevronDown` (tree), `Folder` (custom folder).
- Folder-type: `Inbox`, `Send`, `FileText` (drafts), `Archive`, `ShieldAlert` (spam/junk),
  `Trash2` (trash).
- Reader: `Reply`, `ReplyAll`, `Forward`, `Star`, `MailOpen` (mark read), `Archive`,
  `Clock` (snooze), `Trash2`, `MoreHorizontal`, `Paperclip`, `SendHorizontal`.

## Zakres

### 1. Tokeny motywu (`src/shared/theme/tokens.css`)

Rail theme-aware (light: `--bg-rail:#f8f8fc`, `--rail-border:#ececf4`,
`--rail-item:#55556c`, `--rail-section:#aaaabf`, `--rail-hover:#efeff7`,
`--rail-count:#a0a0b4`, `--rail-search-bg:#f0f0f6`, `--rail-search-border:#e6e6ee`,
`--text-on-rail:#1a1a2e`; dark: ciemne odpowiedniki dobrane do tła). Token
`--shadow-accent:0 6px 14px -6px rgba(79,70,229,.6)`; promienie pozycji 9–10px.

### 2. Rail (`MailboxRail.tsx` → `MailboxRail.css`, inline-style → klasy)

Struktura wg szablonu, **z ikonami wiodącymi**:
- **Header**: logo-badge „A" + „AbeonMail" + avatar konta (inicjały wybranego/
  pierwszego konta, reuse `Avatar`).
- **Search (placeholder)**: stylowany box (ikona `Search` + „Search"),
  `aria-disabled="true"`, `title="Search — coming soon"`, bez `onClick`/inputu.
- **SMART FOLDERS**: All Inboxes / Unread / Flagged (ikony Layers/MailOpen/Flag,
  klikalne) + **Snoozed** (ikona Clock, `aria-disabled`, bez handlera).
- **Accounts**: zachowana funkcjonalność (wybór konta, drag-drop reorder, remove
  confirm, reauth badge); restyling na klasy; avatar konta; **zagnieżdżone drzewo
  folderów** (poniżej).
- **LABELS (placeholder)**: nagłówek + muted „Coming soon", niefunkcjonalny.
- **Stopka**: **Add account** + **⚙ Settings** (zachowane, stylowane).
- **Compose** przeniesiony do nagłówka listy.

Zachować WSZYSTKIE istniejące `aria-label`/role (smart foldery, konta, remove,
reauth, „Open settings", drag handle) — testy i a11y nie mogą się zepsuć.

#### 2a. Zagnieżdżone drzewo folderów (frontend, z istniejących danych)

Czysty moduł `src/features/mailbox/folder-tree.ts`:
- `recoverDelimiter(remotePath, name): string | null` — gdy `remotePath` kończy się
  na `name` i jest dłuższy, delimiter = znak na pozycji `len(remotePath)-len(name)-1`;
  inaczej `null` (folder-korzeń).
- `buildFolderTree(folders: Folder[]): FolderNode[]` — dla każdego folderu wyznacza
  ścieżkę przodków (split `remote_path` po odzyskanym delimiterze), buduje las węzłów.
  Węzeł: `{ segment, fullPath, folder?: Folder, children: FolderNode[] }`. Węzeł z
  `folder` = realny folder (selektowalny, pokazuje `unread_count`); węzeł bez
  `folder` = wirtualny kontener-prefiks (rozwijalny, NIE selektowalny).
- Render rekurencyjny w railu: chevron (jeśli ma dzieci) + ikona folderu
  (folder-type dla realnych, `Folder` dla wirtualnych) + nazwa + licznik; wcięcie
  per poziom. Stan rozwinięcia lokalny w komponencie (`Set<fullPath>`), domyślnie
  korzenie rozwinięte. Klik na realny folder = istniejąca selekcja; klik na chevron
  = toggle; klik na wirtualny węzeł = toggle (bez selekcji).

Testy `folder-tree.ts`: odzyskiwanie delimitera (`.`/`/`/brak), budowa drzewa z
wirtualnymi kontenerami (np. `Klienci_Sm.eGniazdko` bez realnego `Klienci_Sm`),
płaskie foldery jako korzenie.

### 3. Lista wiadomości (`MessageListPane.tsx` + CSS)

- **Nagłówek kolumny**: **Compose** (ikona `PencilLine`, `aria-label="New message"`,
  otwiera composer) + sort „Newest" (placeholder, `aria-disabled`, styl dropdown).
- **Grupowanie dat**: czysta `groupLabel(epochSeconds, nowSeconds) →
  "Today"|"Yesterday"|"Earlier"` (`src/features/message-list/grouping.ts`, testowalna).
  Render jako płaska tablica `{kind:"header",label} | {kind:"item",...}`; wirtualizer
  `estimateSize(index)` = wys. nagłówka (~28px) / `ROW_HEIGHT[density]`. Kolejność
  Today→Yesterday→Earlier. Dotyczy trybu wątkowego i smart.
- **Wiersz**: styl szablonu (zaznaczony `#eef0fe` + lewy pasek akcentu, avatar 34px,
  typografia), zachowane unread dot, badge'e, kropka koloru konta (smart).

### 4. Reader (`ConversationView.tsx` + `reader.css`) — pełny re-layout

- **Action-bar** (sticky) z ikonami:
  - Funkcjonalne: `Reply`/`ReplyAll`/`Forward` (istniejące `startReply`),
    **Star** ↔ flaga (`useSetFlag`/`setMessageFlags`, toggle `flagged`),
    **Mark read/unread** ↔ `markMessageSeen` (istnieje).
  - Placeholdery (`aria-disabled`, bez handlera): `Archive`, `Clock` (snooze),
    `Trash2`, `MoreHorizontal` — zgodne z chrome'em szablonu, niewpięte.
- **Body**: `max-width:840px; margin:0 auto; padding:30px 44px`; subject 24px/800 +
  `Star`; nadawca: avatar 46px (reuse `Avatar`) + nazwa 15px/700 + „to …" + czas;
  treść przez istniejący `MessageBodyView` (sanitizacja bez zmian).
- **Box odpowiedzi** (dół): „Reply to <nadawca>…" jako afordancja otwierająca
  composer w trybie reply (`startReply`→`openComposer`) + przycisk `Send`.

### 5. Placeholdery — zasada

Search, Snoozed, LABELS, sort „Newest", reader: Archive/Clock/Trash/More — wszystkie
**niefunkcjonalne i jawnie oznaczone**: brak `onClick`, `aria-disabled="true"`,
wizualnie wyszarzone. Zero „klikalnych-martwych".

## Architektura / organizacja kodu

- `MailboxRail.tsx`: inline-style → `MailboxRail.css`; logika (store, dnd, mutacje)
  bez zmian; render drzewa przez `buildFolderTree`.
- `src/features/mailbox/folder-tree.ts`: czyste funkcje (delimiter + drzewo) + typy.
- `src/features/message-list/grouping.ts`: czysta `groupLabel` + typ pozycji listy.
- `ConversationView.tsx`: re-layout + `reader.css`.
- Reuse `Avatar` (`src/shared/appearance/`) w railu i readerze.
- Ikony: `lucide-react`, importy per-komponent.

## Obsługa błędów

Brak nowych ścieżek danych. Placeholdery nie wykonują operacji. Drzewo i grupowanie
operują na już pobranych danych; pusty zbiór → istniejące stany puste zachowane.
`recoverDelimiter` zwraca `null` bezpiecznie dla folderów-korzeni.

## Testy

- `folder-tree.ts`: delimiter recovery + budowa drzewa (wirtualne kontenery, płaskie
  korzenie, delimiter `.` i `/`).
- `grouping.ts`: `groupLabel` (dziś/wczoraj/wcześniej, granice dnia, strefa lokalna
  spójna z `formatDate`).
- `MailboxRail.test.tsx`: nowy markup; zachowane role/aria (smart foldery, konta,
  remove, reauth, „Open settings", drag handle); drzewo (rozwijanie, selekcja
  realnego folderu, wirtualny węzeł nieselektowalny); Search/Snoozed/LABELS
  `aria-disabled`.
- `MessageListPane.test.tsx`: nagłówki grup dat; Compose otwiera composer; selekcja/
  unread/badge'e zachowane; sort `aria-disabled`.
- `ConversationView.test.tsx`: Reply/Reply all/Forward zachowane; Star→flaga;
  Mark read→markMessageSeen; placeholdery `aria-disabled`; bottom „Reply to…" reply.
- Pełny `npm test` zielony; `npm run build` (tsc + vite) czysty.

## Świadomie poza zakresem

- Funkcjonalny Search (→ 6c), prawdziwe Labels (→ 6d), działający Snoozed (→ 6e).
- Liczniki przy smart-folderach (brak danych — wymagałyby nowych zapytań).
- Archive/snooze/delete/more w readerze (niewpięte akcje domenowe — atrapy).
- Funkcjonalny sort (kolejność i tak malejąco po dacie).
- Zmiany backendu/schematu (pass jest frontowy).

## Kryteria ukończenia

- Rail jasny w light / ciemny w dark; inline-style → CSS; **ikony wiodące** wg
  szablonu; **zagnieżdżone drzewo folderów** (rozwijanie, wirtualne kontenery);
  zachowana pełna funkcjonalność railu.
- Lista z nagłówkami grup dat, Compose w nagłówku, styl wierszy wg szablonu.
- Reader z action-barem (Reply/Reply all/Forward/Star/Mark-read funkcjonalne;
  Archive/snooze/Trash/More atrapy), body 840px wyśrodkowane, box odpowiedzi.
- Placeholdery `aria-disabled`, niefunkcjonalne.
- `lucide-react` dodany; testy zielone; build czysty; **fidelity check** vs
  `docs/templates/AbeonMail.html` (rail/lista/reader) potwierdzony.
