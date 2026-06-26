# Pełny edytor formatowania (WYSIWYG) w composerze

Data: 2026-06-26
Status: zatwierdzony do implementacji

## Cel

Rozbudować edytor TipTap w oknie tworzenia wiadomości (`src/features/composer/Composer.tsx`)
z minimalnego zestawu (bold, italic, lista punktowana, link, obraz) do pełnego zakresu
formatowania: czcionka, rozmiar czcionki, kolory, style tekstu, nagłówki, wyrównanie,
listy (punktowane / numerowane / zadań), tabele z edycją, cytat, blok kodu, linia pozioma,
link, obraz oraz „wyczyść formatowanie".

## Kontekst i ustalenia wstępne

- Edytor: TipTap **v3.27.0** (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-image`).
- Obecna konfiguracja: `useEditor({ extensions: [StarterKit, Image] })` w `Composer.tsx:73`.
- Toolbar jest wklejony inline w `Composer.tsx:336-382` (5 przycisków).
- Serializacja: `editor.getHTML()` → `buildMessage()` (`Composer.tsx:123`) → backend.
- **Backend jest gotowy.** Sanitizer `crates/am-mime/src/sanitize.rs` (ammonia 4.x):
  - przepuszcza tagi tabel (`table/thead/tbody/tr/td/th/caption/col*`) i list (`ul/ol/li`),
  - dopuszcza atrybut `style` z whitelistą **65 właściwości CSS** (m.in. `font-family`,
    `font-size`, `color`, `background-color`, `text-align`, `border*`),
  - dopuszcza atrybuty tabel (`align`, `valign`, `width`, `height`, `border`,
    `cellpadding`, `cellspacing`, `bgcolor`),
  - ta sama sanityzacja działa przy **wysyłce** (`crates/am-mime/src/compose.rs`).
  - **Wniosek: backendu nie zmieniamy.** Całość pracy jest po stronie frontu.

### Ustalenia o TipTap v3 (z dokumentacji)

- `Underline` i `Link` są **już zawarte w StarterKit v3** — dodajemy tylko przyciski.
- `FontSize` jest oficjalnym rozszerzeniem v3 (`editor.commands.setFontSize('14px')`).
- `TextStyle`, `Color`, `FontFamily`, `FontSize` pochodzą z `@tiptap/extension-text-style`.
- Kolor tła tekstu: `Highlight.configure({ multicolor: true })` (`@tiptap/extension-highlight`).
- Tabele: `@tiptap/extension-table` + `-table-row` + `-table-cell` + `-table-header`,
  `Table.configure({ resizable: true })`.
- Wyrównanie: `@tiptap/extension-text-align`, `configure({ types: ['heading','paragraph'] })`.
- Listy zadań: `@tiptap/extension-task-list` + `@tiptap/extension-task-item`
  (`TaskItem.configure({ nested: true })`).
- Wszystkie pakiety w wersji zgodnej z `^3.27.0`.

Dokładne nazwy importów (np. czy `FontSize` jest w `extension-text-style`, a `TaskList`
w `extension-list`) implementujący weryfikuje przy instalacji — backend i tak jest neutralny.

## Decyzje produktowe (zatwierdzone)

- **Zakres:** pełny zestaw „jak Gmail/Word".
- **Układ toolbara:** kompaktowy, jeden rząd z popoverami; zawija się (flex-wrap) przy
  wąskim oknie.
- **Rozmiary czcionki:** nazwane presety mapowane na px:
  Mały = 13px, **Normalny = 14px (domyślny)**, Duży = 18px, Bardzo duży = 26px.
- **Czcionki (email-safe):** Domyślna, Arial, Helvetica, Georgia, Times New Roman,
  Courier New, Verdana, Tahoma, Trebuchet MS, Comic Sans MS.
- **Kolory:** siatka ~35 gotowych swatchy + „Domyślny" (reset). Bez własnego color-pickera (v1).
- **Link:** lekki popover z polami „URL" + „tekst" (zastępuje obecny `window.prompt`).
- **Tabela:** wstaw 3×3 (z nagłówkiem), dodaj/usuń wiersz, dodaj/usuń kolumnę,
  scal/podziel komórki, usuń tabelę. Akcje edycji nieaktywne, gdy kursor poza tabelą.

## Architektura

Nowy katalog `src/features/composer/editor/`:

- `extensions.ts` — funkcja `createEditorExtensions()` zwracająca skonfigurowaną listę
  rozszerzeń (StarterKit + Image + Table x4 + TextStyle/Color/FontFamily/FontSize +
  Highlight + TextAlign + TaskList/TaskItem). Single source of truth dla konfiguracji.
- `fontPresets.ts` — stałe: `FONT_FAMILIES`, `FONT_SIZE_PRESETS`, `COLOR_SWATCHES`.
- `EditorToolbar.tsx` — pasek narzędzi, props `{ editor: Editor | null }`. Składa kontrolki.
- `ToolbarPopover.tsx` — generyczny popover (przycisk-trigger + panel; zamykanie na klik poza).
- `ColorSwatchGrid.tsx` — siatka swatchy + reset; props `{ onPick(color), onReset() }`.
- `TableMenu.tsx` — popover z akcjami tabeli; korzysta z `editor.can()` do wyłączania akcji.
- `LinkPopover.tsx` — pola URL + tekst, zatwierdzenie ustawia/aktualizuje link.

`Composer.tsx` chudnie: zamiast inline toolbara renderuje `<EditorToolbar editor={editor} />`,
a `useEditor` przyjmuje `extensions: createEditorExtensions()`. Logika obrazów
(`handleInsertImage`, `rewriteInlineSrcs`, `inlineSrcMapRef`) zostaje w `Composer.tsx`;
przycisk „obraz" w toolbarze woła callback przekazany z `Composer.tsx` (prop `onInsertImage`),
bo wstawianie obrazu jest spięte z attachmentami i stanem composera.

### Granice / interfejsy

- `EditorToolbar` zależy tylko od instancji `editor` i (dla obrazu) callbacka `onInsertImage`.
  Nie zna stanu wysyłki, kont, draftów.
- `extensions.ts` nie zależy od Reacta — czysta konfiguracja, testowalna jednostkowo.
- Komponenty popoverów są bezstanowe względem treści — operują przez `editor.chain()`.

## Przepływ danych (bez zmian)

`EditorContent` (TipTap) → `editor.getHTML()` → `rewriteInlineSrcs` (cid: dla inline obrazów)
→ `buildMessage()` → (autosave/draft lub wysyłka) → backend `sanitize_html` → MIME → SMTP.

Nowe rozszerzenia produkują HTML mieszczący się w whiteliście sanitizera, więc tabele,
listy i style inline (font, size, color, align) przechodzą bez utraty.

## Obsługa błędów / przypadki brzegowe

- `editor` może być `null` (jeszcze nie zainicjalizowany) — toolbar renderuje kontrolki
  w stanie disabled, każdy handler robi `if (!editor) return`.
- Akcje edycji tabeli aktywne tylko gdy `editor.can().<akcja>()` — inaczej disabled.
- Reset koloru = `unsetColor()` / `unsetHighlight()`; reset rozmiaru = `unsetFontSize()`;
  reset czcionki = `unsetFontFamily()`.
- Popovery zamykają się na klik poza i Esc; tylko jeden otwarty naraz (lokalny stan w toolbarze).
- „Wyczyść formatowanie": `editor.chain().focus().unsetAllMarks().clearNodes().run()`.

## Style (CSS)

Do `src/features/composer/composer.css` dochodzą style ProseMirror (dziś brakujące):
- listy `ul/ol` — wcięcia i znaczniki,
- tabele — `border-collapse`, widoczne obramowania komórek, podświetlenie zaznaczonej
  komórki (`.selectedCell`), uchwyt zmiany szerokości kolumny (`.column-resize-handle`),
- task-list — układ checkbox + treść, `list-style: none`,
- blockquote / `pre code` — wcięcie i tło.
Style toolbara: kontener `flex-wrap`, przyciski, panele popoverów, siatka swatchy.

## Testy (TDD)

- `extensions.test.ts` — `createEditorExtensions()` zawiera oczekiwane rozszerzenia
  (np. obecność Table, TextStyle, TaskList po nazwach).
- `buildMessage` (lub helper serializacji) — HTML z tabelą i inline `style` (font-size,
  color) jest zachowany w `html_body` i nie gubiony.
- `EditorToolbar.test.tsx` — render z atrapą `editor`; klik kontrolek woła właściwe
  metody łańcucha (`toggleBold`, `setFontSize`, `setColor`, `insertTable`, `setTextAlign`…).
- Smoke: render `EditorToolbar` z `editor={null}` nie wyrzuca wyjątku (kontrolki disabled).

## Świadomie poza zakresem (v1)

- Rozbudowa edytora **sygnatur** (`SignaturesSection.tsx`) — zostaje bez zmian.
- Własny color-picker (hex), ustawianie szerokości kolumn liczbowo, indent/outdent akapitu,
- Zapamiętywanie ostatnio użytej czcionki/koloru między sesjami.

## Plan integracji / kolejność

1. Instalacja zależności + `extensions.ts` + `fontPresets.ts`.
2. Komponenty toolbara (`ToolbarPopover`, `ColorSwatchGrid`, `TableMenu`, `LinkPopover`,
   `EditorToolbar`).
3. Integracja w `Composer.tsx` (usunięcie starego toolbara, podpięcie `onInsertImage`).
4. CSS (ProseMirror + toolbar).
5. Testy + `npm test` + `npm run build`, naprawa regresji.
