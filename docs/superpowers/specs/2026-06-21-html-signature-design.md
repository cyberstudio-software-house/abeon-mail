# HTML-owy podpis (surowy HTML) — projekt

Data: 2026-06-21
Status: zaakceptowany (gotowy do planu wdrożenia)

## Cel

Umożliwić użytkownikowi podanie **surowego kodu HTML** podpisu (gotowe, profesjonalnie
zaprojektowane podpisy: tabele, inline CSS, logo), zamiast budowania ich wyłącznie w
ograniczonym edytorze WYSIWYG (TipTap StarterKit: bold/italic/listy).

## Stan wyjściowy (ustalenia z analizy kodu)

- Podpisy są już przechowywane i wysyłane jako HTML: tabela `signatures(id, account_id, name, html, is_default)`,
  mail wysyłany jako `multipart/alternative` (`text/plain` + `text/html`).
- Edycja podpisów oraz edytor maila (composer) używają **TipTap `StarterKit`**. Każde
  `editor.commands.setContent(html)` przepuszcza HTML przez schemę TipTap i **usuwa**
  elementy, których StarterKit nie zna (tabele, `div`/`span` ze stylami itd.).
- Sanitizer wysyłki (`crates/am-mime/src/sanitize.rs`, `sanitize_html`) jest **hojny dla maili**:
  przepuszcza inline `style` z dużą whitelistą właściwości CSS, tabele z atrybutami
  prezentacyjnymi (`bgcolor`, `width`, `cellpadding`, `cellspacing`, `align`, `valign`, `border`),
  obrazki `data:` oraz `cid:`. Wycina realne zagrożenia: `script`, `iframe`, `object`, `embed`,
  `form`, atrybuty `on*`, schematy `javascript:`/`vbscript:`/`data:text/html`.
  => Profesjonalny HTML-owy podpis **przetrwa wysyłkę**. Backend jest gotowy.
- Wysyłka jest dwustopniowa: `handleSend()` najpierw `saveDraft(message)` → `savedId`,
  potem `enqueueSend(savedId)`. **Wysyłany jest zapisany draft**, nie bezpośrednia zawartość edytora.
- `buildMessage()` jest współdzielony przez autosave, „zapisz szkic" i wysyłkę.
- Istnieje gotowy komponent `src/features/reader/SafeHtmlFrame.tsx` — sandboxowany iframe
  (`sandbox=""`, bez `allow-scripts` i `allow-same-origin`, `srcdoc`), używany przez Reader.

## Dwa miejsca, gdzie TipTap niszczy surowy HTML

1. **Edytor podpisów (ustawienia)** — rozwiązanie: tryb edycji surowego HTML (textarea omijająca TipTap).
2. **Composer przy tworzeniu maila** — `setContent(\`<p></p>${sig.html}${quote}\`)` przepuszcza
   podpis przez TipTap. Rozwiązanie: podpisu HTML nie wstawiamy do edytora; pokazujemy podgląd
   w izolowanym iframe, a surowy HTML doklejamy do `html_body` przy wysyłce.

## Model danych

Dodajemy flagę odróżniającą podpis HTML od zwykłego. Dzięki temu funkcja jest **dodatkiem** —
istniejące proste podpisy działają bez zmian, a nową ścieżkę (podgląd-iframe + doklejanie przy
wysyłce) dostają tylko podpisy HTML.

- Migracja `V14__signature_is_html.sql`: `ALTER TABLE signatures ADD COLUMN is_html INTEGER NOT NULL DEFAULT 0;`
- `Signature` (Rust `am-core/src/signature.rs` + binding `src/ipc/bindings.ts`) zyskuje `is_html: bool`.

Decyzja: flaga `is_html`, a nie ujednolicenie wszystkich podpisów do nowej ścieżki — proste
podpisy są dziś edytowalne inline w composerze (nad cytatem); ujednolicenie zabrałoby tę
możliwość wszystkim i wprowadziło regresję. Flaga = zero regresji.

## Ustawienia — `src/features/settings/SignaturesSection.tsx`

- Toggle trybu edycji: **„Wizualnie / HTML"**.
- Tryb HTML: `<textarea>` na surowy kod + podgląd przez `SafeHtmlFrame` obok.
- Zapis:
  - tryb HTML → `is_html: true`, `html` = treść textarea 1:1 (bez przejścia przez TipTap),
  - tryb wizualny → `is_html: false` (jak dziś, `editor.getHTML()`).
- Otwarcie istniejącego podpisu otwiera go w jego trybie (`is_html ? HTML : wizualny`).
- Przełączenie Wizualnie → HTML pre-wypełnia textarea bieżącym `editor.getHTML()`. Przełączenie
  HTML → Wizualnie ładuje treść do TipTap (świadoma normalizacja; użytkownik wybrał ten kierunek).

## Composer — `src/features/composer/Composer.tsx`

- Wyliczamy `activeHtmlSignature` = domyślny (lub wybrany z dropdownu) podpis, o ile `is_html`.
- Podpis HTML **nie** trafia do `setContent` TipTap. Proste podpisy → bez zmian (inline nad cytatem).
- Pod edytorem **blok podglądu** `SafeHtmlFrame` z `activeHtmlSignature.html` (gdy obecny).
- `buildMessage(forSend: boolean)`:
  - `forSend = false` (autosave / „zapisz szkic") → **bez** podpisu HTML (draft pozostaje czysty),
  - `forSend = true` (`handleSend`) → doklejamy `activeHtmlSignature.html` na koniec `html_body`
    oraz jego wersję tekstową (przez `element.textContent`) na koniec `text_body`.
- Dropdown wyboru podpisu rozgałęzia się: `is_html` → ustaw `activeHtmlSignature` (podmiana podglądu);
  zwykły → dotychczasowy `insertSignature` (inline).

## Decyzje przyjęte (zaakceptowane)

- **Miejsce doklejenia w odpowiedziach (v1):** podpis HTML ląduje na końcu `html_body`, czyli pod
  cytatem w reply. Wstawianie przed cytat wymagałoby parsowania HTML cytatu — kruche. Dla nowych
  maili pozycja jest idealna (zaraz pod treścią). Ograniczenie udokumentowane poniżej.
- **Drafty a podpis HTML:** podpis HTML nigdy nie jest w treści draftu. Przy ponownym otwarciu
  draftu podgląd odtwarzamy z domyślnego podpisu konta.

## Pliki do zmiany

Backend:
- `crates/am-storage/src/migrations/V14__signature_is_html.sql` (nowa migracja)
- `crates/am-core/src/signature.rs` (pole `is_html`)
- `crates/am-storage/src/signatures_repo.rs` (SELECT/INSERT/UPDATE z `is_html`; sygnatury
  `create_signature`/`update_signature`)
- `crates/am-app/src/commands.rs` (komendy `create_signature`/`update_signature` z `is_html`)
- `src/ipc/bindings.ts` (regeneracja specta)

Frontend:
- `src/ipc/queries.ts` (przekazanie `is_html` w `useCreateSignature`/`useUpdateSignature`)
- `src/features/settings/SignaturesSection.tsx` (toggle + textarea + podgląd)
- `src/features/composer/Composer.tsx` (active signature, podgląd, `buildMessage(forSend)`, dropdown)
- `src/features/composer/composer.css` (styl bloku podglądu — w razie potrzeby)

## Testy

Rust:
- `signatures_repo` — round-trip `is_html` (create/update/list zachowują flagę), domyślne `false`.
- migracja V14 stosuje się na istniejącej bazie (kolumna dodana z domyślnym 0).

Frontend:
- `SignaturesSection` — toggle przełącza tryb; zapis w trybie HTML wysyła `is_html: true` i `html` 1:1.
- `Composer` — podpis HTML **nie** trafia do edytora TipTap; podgląd-iframe obecny;
  `buildMessage(forSend=true)` zawiera podpis w `html_body`; autosave/„zapisz szkic" go **nie** zawierają.

## Znane ograniczenia / follow-up

- FU1: w odpowiedziach podpis HTML jest pod cytatem (nie między treścią a cytatem).
- FU2: round-trip „dokładnie tego podpisu, który był wybrany" przez draft — obecnie po ponownym
  otwarciu draftu wraca domyślny podpis HTML konta. Pełny round-trip wymagałby przechowania
  referencji/snapshotu podpisu na drafcie.
- FU3: `text_body` zawiera uproszczoną (tekstową) wersję podpisu HTML; bez odwzorowania układu.
