# Przypięte foldery + sekcja INBOX (sidebar)

Data: 2026-06-21
Status: zatwierdzony do planowania

## Cel

Dodać możliwość przypinania folderów w sidebarze (`MailboxRail`). Przypięte
foldery oraz inboksy wszystkich kont mają trafić nad listę Smart Folders, aby
dać szybki dostęp do najważniejszych skrzynek niezależnie od tego, które konto
jest aktualnie rozwinięte.

## Docelowy układ sidebara

Kolejność sekcji w `rail__scroll` (od góry):

1. **INBOX** — nagłówek `rail__section`; pod nim jeden wiersz na konto
   (nazwa konta + avatar + licznik nieprzeczytanych z inboxa). Klik = otwarcie
   inboxa danego konta. Renderowana zawsze, gdy istnieje co najmniej jedno konto.
2. **Przypięte** — dla każdego konta posiadającego co najmniej jeden przypięty
   folder: bardzo mały nagłówek z nazwą konta (`rail__subsection`), a pod nim
   przypięte foldery posortowane alfabetycznie (kolacja „pl"). Konta bez pinów są
   pomijane; cała sekcja znika, gdy nie ma żadnego przypiętego folderu.
3. **Smart Folders** — bez zmian.
4. **Accounts** — bez zmian (rozwijane drzewa folderów per konto).
5. **Labels** — bez zmian.

## Decyzje projektowe

- **Sekcja INBOX jest automatyczna** — pokazuje inboksy wszystkich kont, nie
  podlega ręcznemu przypinaniu.
- **Inbox nie jest przypinalny** — menu „Przypnij" nie pojawia się dla folderów
  typu `inbox`, aby uniknąć duplikatu z sekcją INBOX.
- **Interakcja przez menu kontekstowe (prawy klik)** — daje miejsce na przyszłe
  akcje na folderach.
- **Trwałość w store `settings`** — bez zmian w warstwie Rust (bez migracji,
  bez regeneracji bindingów specta).
- **Sortowanie przypiętych: alfabetyczne** (kolacja „pl"), spójne z resztą
  drzewa folderów.
- **Nagłówki per konto pokazują się także przy jednym koncie** (spójność).

## Trwałość (settings store)

- Klucz per konto: `folders.pinned.{accountId}`.
- Wartość: JSON z tablicą ID folderów, np. `[3,5,12]`.
- Odczyt wszystkich pinów jednym zapytaniem: `getSettings()` →
  parsowanie kluczy pasujących do `folders.pinned.*` do `Map<accountId, number[]>`.
- Zapis: `setSetting("folders.pinned.{accountId}", JSON.stringify(ids))`.

Wzorzec 1:1 z istniejącym `images.autoload.{accountId}`
(`useImageAutoload` / `useSetImageAutoload` w `src/ipc/queries.ts`).

## Przepływ danych

Obecnie `useFolders(selectedAccountId)` pobiera foldery tylko dla wybranego
konta. Sekcje INBOX i Przypięte potrzebują folderów ze wszystkich kont, więc:

- `useAllAccountFolders(accounts)` — `useQueries` z React Query po wszystkich
  kontach; zwraca `Map<accountId, Folder[]>`. Używa tego samego klucza
  `["folders", accountId]`, dzięki czemu cache jest współdzielony z istniejącym
  `useFolders` (brak podwójnych zapytań).
- `usePinnedMap()` — query `["pinned-folders"]` czytająca `getSettings()` i
  budująca `Map<accountId, number[]>`.
- `useTogglePinnedFolder()` — mutacja: czyta bieżącą listę dla konta,
  dodaje/usuwa ID, zapisuje przez `setSetting`, invaliduje `["pinned-folders"]`.

## Nowe / zmienione pliki

### `src/ipc/queries.ts`
- `usePinnedMap()`
- `useTogglePinnedFolder()`
- `useAllAccountFolders(accounts)`

### `src/features/mailbox/pinned.ts` (nowy — czyste, testowalne funkcje)
- `parsePinnedMap(settings: [string, string][]): Map<number, number[]>`
- `selectInboxes(accounts, foldersByAccount): { account, inbox }[]`
- `selectPinnedByAccount(accounts, foldersByAccount, pinnedMap): { account, folders }[]`
  - foldery posortowane alfabetycznie, inbox wykluczony, puste grupy pominięte.

### `src/features/mailbox/RailContextMenu.tsx` (nowy)
- Mały, generyczny komponent menu kontekstowego: pozycjonowanie przy kursorze,
  zamykanie na klik poza obszarem / `Escape` / scroll, lista akcji.
- Akcja na MVP: „Przypnij" / „Odepnij".

### `src/features/mailbox/MailboxRail.tsx`
- Render sekcji INBOX i Przypięte na górze `nav`.
- `onContextMenu` na wierszach folderów (drzewo Accounts oraz sekcja Przypięte).
- Stan otwartego menu: `{ x, y, folderId, accountId, isPinned }`.

### `src/features/mailbox/MailboxRail.css`
- Styl małego nagłówka konta (`rail__subsection`) i menu kontekstowego.

## Interakcja (menu kontekstowe)

- Prawy klik na folderze innym niż `inbox` → menu z „Przypnij" lub „Odepnij"
  (zależnie od bieżącego stanu); wybór wywołuje `useTogglePinnedFolder`.
- Folder typu `inbox` → menu się nie pokazuje (brak akcji).
- Lewy klik na przypiętym folderze lub na wierszu INBOX → istniejący
  `handleFolderClick(folderId, accountId)`.
- Podświetlenie aktywne: `selectedFolderId === folder.id` (ten sam folder w
  sekcji przypiętych i w drzewie podświetla się spójnie — akceptowane).

## Przypadki brzegowe

- Brak kont → sekcje INBOX/Przypięte nie renderują się; zostaje istniejący
  komunikat „No accounts yet".
- Przypięty folder usunięty zdalnie (znika z `useFolders`) → nie renderuje się;
  „martwe" ID pozostaje w settings i jest czyszczone leniwie przy następnym
  toggle.
- Jedno konto → sekcje nadal pokazują nagłówek z nazwą konta.

## Testy

- Unit (`pinned.test.ts`, vitest jak istniejące): `parsePinnedMap`,
  `selectInboxes`, `selectPinnedByAccount` (sortowanie, wykluczenie inboxa, puste
  grupy).
- Component (rozszerzenie testów railu): render sekcji INBOX dla dwóch kont,
  render grupy przypiętych, działanie menu kontekstowego (przypięcie/odpięcie i
  reakcja sekcji).
