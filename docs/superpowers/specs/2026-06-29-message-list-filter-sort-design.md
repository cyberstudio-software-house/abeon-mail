# Filter & Sort dla listy wiadomości (widok folderu)

**Data:** 2026-06-29
**Status:** Design — zatwierdzony do planowania

## Cel

Zastąpić nieaktywną etykietę sortowania (`Newest ▾`) obok przycisku **Compose**
interaktywną kontrolką „Filtruj i sortuj" dla widoku folderu (wątki). Kontrolka daje:

- sortowanie po dacie rosnąco/malejąco,
- filtr po nadawcy (Od),
- filtr „tylko z załącznikami",
- filtr po temacie.

## Zakres i decyzje projektowe

Ustalone w fazie brainstormingu:

1. **„Adresat" = nadawca (Od).** Lista ma dane nadawcy (`participants` / `from_*`),
   nie ma pola odbiorcy. Filtr działa po nadawcy.
2. **Filtrowanie i sortowanie po stronie backendu (SQL).** Poprawne dla całej
   skrzynki, nie tylko dla pierwszych 100 załadowanych pozycji.
3. **Tylko zwykły widok folderu (wątki).** Tryby smart-folder / etykieta /
   wyszukiwanie / drafts pozostają bez zmian; w nich kontrolka jest ukryta.
4. **Filtr tematu dopasowuje `threads.subject_root`** (kanoniczny temat wątku).
5. **Reset filtrów przy zmianie folderu.** Filtry nadawcy/tematu/załączników to
   stan sesyjny resetowany po przełączeniu folderu. Kierunek sortowania jest
   preferencją trwałą.

Poza zakresem (YAGNI): filtrowanie/sortowanie w trybach flat (smart/label/search),
filtr po odbiorcy (To), zakresy dat, zapisane filtry, paginacja > 100.

## Architektura

Przepływ: kontrolka UI → `useUiStore` (stan filtrów) → `useThreads(folderId, filters)`
→ komenda `list_threads(folder_id, filters, limit, offset)` → `threads_repo::list_for_folder`
buduje dynamiczny SQL → `Vec<ThreadSummary>`. Klucz react-query zawiera filtry, więc
zmiana filtra wyzwala refetch. Wynik nadal przechodzi przez `groupIntoEntries`
(nagłówki dat) bez zmian.

### Komponenty i pliki

| Warstwa | Plik | Zmiana |
|---|---|---|
| UI kontrolka | `src/features/message-list/FilterSortMenu.tsx` (nowy) | Ikona + popover (klik-poza + Escape wg wzorca `ToolbarPopover.tsx`) |
| UI lista | `src/features/message-list/MessageListPane.tsx` | Zastąpić `.message-list__sort` kontrolką; pusty stan dla aktywnych filtrów; reset przy zmianie folderu |
| Style | `src/features/message-list/MessageListPane.css` | Style ikony, popovera, badge aktywności |
| Stan | `src/app/store.ts` | Pola + settery + `clearListFilters`; hydracja `listSortDir` |
| Persystencja | `src/shared/general/general.ts` + `GeneralProvider.tsx` | Klucz `general.listSortDir` w `GENERAL_KEYS`/`DEFAULT_GENERAL` + `parseGeneralSettings` + persist (wzór `threadOrder`) |
| Hook | `src/ipc/queries.ts` | `useThreads(folderId, filters)` — filtry w kluczu i w argumentach komendy |
| Komenda | `crates/am-app/src/commands.rs` | `list_threads` zyskuje parametr `filters: ThreadListFilters` |
| Repo + typ | `crates/am-storage/src/threads_repo.rs` | `ThreadListFilters` + dynamiczny SQL w `list_for_folder` |
| Bindingi | `src/ipc/bindings.ts` (generowany) | `npm run gen:bindings` po zmianie komendy/typu |

## Stan (`useUiStore`)

Nowe pola:

```
listSortDir: "desc" | "asc"          // domyślnie "desc"
listFilterSender: string             // domyślnie ""
listFilterSubject: string            // domyślnie ""
listFilterAttachmentsOnly: boolean   // domyślnie false
```

Akcje: `setListSortDir`, `setListFilterSender`, `setListFilterSubject`,
`setListFilterAttachmentsOnly`, `clearListFilters` (zeruje trzy filtry, NIE rusza
kierunku sortowania).

Selektor pochodny `listFiltersActive` = `sender !== "" || subject !== "" ||
attachmentsOnly || sortDir !== "desc"` — steruje kropką aktywności na ikonie.

**Persystencja:** `listSortDir` należy do **general settings** —
`GeneralFields.listSortDir` + `DEFAULT_GENERAL` + `GENERAL_KEYS.listSortDir`
(`"general.listSortDir"`) w `src/shared/general/general.ts`, parsowany w
`parseGeneralSettings`, hydratowany i zapisywany przez `GeneralProvider.tsx`
(wzór `threadOrder`). Pozostałe trzy pola filtrów są sesyjne.

**Reset przy zmianie folderu:** w `MessageListPane` `useEffect` na `selectedFolderId`
wywołuje `clearListFilters()`. Kierunek sortowania pozostaje.

## Backend (Rust + SQL)

### Typ

```rust
pub enum ThreadSortDir { Asc, Desc }

pub struct ThreadListFilters {
    pub sort_dir: ThreadSortDir,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub attachments_only: bool,
}
```

`#[derive(Serialize, Deserialize, Type)]` (specta) → typ TS w `bindings.ts`.
Puste/`None` pola = brak warunku (zachowanie jak dziś).

### SQL w `list_for_folder`

Modyfikacje względem obecnego zapytania:

- **Sortowanie:** `ORDER BY t.last_date {dir}`, gdzie `{dir}` to literał `ASC`/`DESC`
  zmapowany z enuma. Nigdy interpolacja wartości od użytkownika.
- **Nadawca:** w wewnętrznym podzapytaniu folderu (`WHERE folder_id = ?1 …`)
  dołożyć `AND (from_address LIKE ?n ESCAPE '\' OR from_name LIKE ?n ESCAPE '\')`.
  Wątek przechodzi, jeśli ma w tym folderze wiadomość od pasującego nadawcy;
  `participants` w wyniku nadal pokazuje wszystkich uczestników.
- **Temat:** `AND t.subject_root LIKE ?s ESCAPE '\'`.
- **Załączniki:** `HAVING MAX(m.has_attachments) = 1` (lista to agregat
  `GROUP BY t.id`; `MAX(m.has_attachments)` jest już w SELECT).

**Bezpieczeństwo:** wszystkie wartości tekstowe przekazywane jako parametry bind.
Helper opakowuje wzorzec w `%…%` i escapuje `%`, `_`, `\` (ESCAPE `\`), więc znaki
specjalne LIKE są traktowane dosłownie. Brak konkatenacji stringów użytkownika do SQL.

Budowa dynamicznego SQL: składać `WHERE`/`HAVING` z opcjonalnych fragmentów i
parametrów w `Vec`, zamiast jednego literału. Dla braku filtrów wynik identyczny
jak dziś.

## Wiring React Query

```
useThreads(folderId, filters)
  queryKey: ["threads", folderId, filters]
  queryFn:  commands.listThreads(folderId, filters, 100, 0)
```

Pola tekstowe (`sender`, `subject`) przepuszczone przez `useDebouncedValue` (200 ms)
zanim trafią do `filters` użytych w kluczu — brak refetchu na każdy znak.
Przełącznik sortowania i checkbox aplikują się natychmiast.

## UX kontrolki

Ikona `SlidersHorizontal` (lucide) z `aria-label`, otwiera popover:

```
Sortowanie
 ◉ Najnowsze najpierw        (desc — domyślne)
 ○ Najstarsze najpierw       (asc)
────────────────────────────
Nadawca zawiera…  [__________]
Temat zawiera…    [__________]
☐ Tylko z załącznikami
────────────────────────────
                   [Wyczyść]
```

- Kropka aktywności na ikonie, gdy `listFiltersActive`.
- „Wyczyść" aktywne tylko, gdy są filtry do wyczyszczenia.
- Kontrolka renderowana tylko w zwykłym trybie folderu (nie `isFlatMode`, nie drafts).

## Stany puste / feedback

Gdy filtry aktywne i `rawItems.length === 0`: komunikat „Brak wiadomości pasujących
do filtrów" + przycisk „Wyczyść filtry" (zamiast zwykłego „No messages").

## Testy

- **Store** (`store.test.ts`): settery, `clearListFilters` (nie rusza `listSortDir`),
  reset przy zmianie folderu, hydracja `listSortDir`, selektor `listFiltersActive`.
- **Komponent** (`FilterSortMenu.test.tsx`): render, przełączanie sortowania,
  wpisywanie nadawcy/tematu, checkbox, „Wyczyść", kropka aktywności, ukrycie w
  trybach flat.
- **Backend** (`threads_repo` `mod tests`): `list_for_folder` z filtrami — asc/desc,
  nadawca, temat (po `subject_root`), `attachments_only`, oraz że puste filtry dają
  ten sam wynik co dziś. Test escapowania znaków LIKE (`%`/`_`).
- **Queries** (`queries.pinned.test.tsx` lub nowy): `useThreads` woła `listThreads`
  z poprawnymi argumentami filtrów; zmiana filtra zmienia klucz.

## Globalne ograniczenia (z planów etapów)

- Identyfikatory w kodzie po angielsku; ZERO komentarzy w kodzie (dokumentacja w `docs/`).
- Node 24 (`$HOME/.nvm/versions/node/v24.14.0/bin` na PATH dla `npm`).
- `npm run gen:bindings` po każdej zmianie komendy/typu specta.
- Rust: `cargo test -p am-storage` / `-p am-app`; pełne `cargo test` przed scaleniem.
- Frontend: `npm test` (vitest).
- Conventional Commits 1.0.0; bez dopisywania siebie jako co-autora; push tylko na prośbę.
- Nigdy `git add .` — stage tylko jawnie wymienionych ścieżek.
```
