# Zwijanie cytowanej historii w treści maila

Data: 2026-06-23
Status: zaakceptowany projekt (przed planem implementacji)

## Cel

W treści maili z wielowątkową historią zwijać cytowaną poprzednią korespondencję
pod jeden przycisk „•••" (styl Gmail). Domyślnie pokazujemy tylko bieżącą
odpowiedź; kliknięcie rozwija pełną historię. Dotyczy zarówno treści HTML, jak
i plain-text.

## Decyzje produktowe

- **Jeden toggle od pierwszej granicy** — wykrywamy pierwszy fragment cytowanej
  historii i zwijamy wszystko od tego miejsca w dół pod jeden przycisk.
- **Zakres: HTML i plain-text** — obie ścieżki renderowania w czytniku.
- **Domyślnie zwinięte**, gdy wykryto historię.
- Bez licznika ukrytych wiadomości (zbyt niepewny do wyznaczenia).
- Stan rozwinięcia jest efemeryczny — resetuje się przy nawigacji między mailami.

## Kontekst architektoniczny

- Treść HTML renderowana jest w `SafeHtmlFrame` — sandboxowanym iframe, który
  **nigdy nie dostaje `allow-scripts`** (testowany inwariant). Klasyczny
  przycisk JS wewnątrz treści maila nie zadziała.
- W trybie **Strict** iframe nie ma `allow-same-origin`, więc rodzic nie sięga do
  `contentDocument`. Wybrane rozwiązanie nie może polegać na dostępie do DOM iframe.
- `render_message_html` (backend) zwraca już oczyszczony **fragment HTML**
  (oczyszczony `<body>`, style inline; brak osobnego `<head><style>`).
  Plain-text idzie osobną ścieżką jako `<pre>`.
- Wniosek: detekcja granicy + podział treści po stronie frontu; React steruje
  stringiem `srcDoc` (odpowiedź vs całość). Backend pozostaje nietknięty.

## Architektura

### Nowe pliki

- `src/shared/quotedHistory.ts` — czysty moduł detekcji (bez React/IPC):

  ```ts
  type QuoteSplit = { collapsed: string; full: string; hasHistory: boolean };
  splitHtmlHistory(html: string): QuoteSplit
  splitTextHistory(text: string): QuoteSplit
  ```

  - `collapsed` — treść bez historii.
  - `full` — oryginał (używany po rozwinięciu).
  - `hasHistory` — czy znaleziono granicę. Gdy brak: `collapsed === full`,
    `hasHistory === false`.

- `src/features/reader/QuotedHistoryToggle.tsx` — przycisk-pigułka „•••"
  (wzorowany na `RemoteContentBanner`), z etykietami „Pokaż cytowaną historię" /
  „Ukryj cytowaną historię".

### Modyfikowane pliki

- `src/features/reader/MessageBodyView.tsx`:
  - liczy podział w `useMemo` (osobno dla HTML i dla plain-text),
  - trzyma stan `const [expanded, setExpanded] = useState(false)`,
  - do `SafeHtmlFrame` / `<pre>` przekazuje `expanded ? full : collapsed`,
  - renderuje `QuotedHistoryToggle` tylko gdy `hasHistory`,
  - reset `expanded` przy zmianie `messageId`.

### Przepływ danych

Backend (bez zmian) → `MessageBodyView` dostaje gotowy HTML/text →
`quotedHistory.ts` dzieli treść → React wybiera string do `srcDoc` / `<pre>` →
toggle pod treścią przełącza `expanded`.

## Heurystyki granic

### HTML

Parsujemy `DOMParser('text/html')`, szukamy pierwszego węzła-granicy w kolejności
dokumentu (DFS), a następnie usuwamy ten węzeł i wszystko po nim, aby uzyskać
`collapsed`.

Algorytm cięcia („usuń od węzła w dół"):

```
let node = boundary;
while (node && node !== body) {
  let sib = node.nextSibling;
  while (sib) { const next = sib.nextSibling; sib.remove(); sib = next; }
  node = node.parentNode;
}
boundary.remove();
```

Idzie w górę po przodkach i usuwa następne rodzeństwo na każdym poziomie —
poprawnie modeluje „wszystko wizualnie poniżej granicy", także dla zagnieżdżonych
cytatów. `collapsed` = serializacja przyciętego `body`, `full` = oryginał.

Zestaw granic (pierwsze trafienie wygrywa), wg pewności:

1. Kontenery cytatu (selektory):
   - `.gmail_quote`, `.gmail_quote_container` (Gmail)
   - `#appendonsend`, `#divRplyFwdMsg` (Outlook / OWA)
   - `blockquote[type="cite"]` (Apple Mail, Thunderbird)
   - `.moz-cite-prefix` (Thunderbird — linia atrybucji)
   - `.yahoo_quoted`, `#yahoo_quoted` (Yahoo)
   - `.protonmail_quote` (Proton)
2. Element, którego tekst pasuje do regexu atrybucji (klient nieobjęty wyżej).
3. (Niżej pewności, opcjonalnie) `<hr>` bezpośrednio przed blokiem nagłówków
   `From:/Od:/Von:`.

### Plain-text

Skan linii; granica = pierwszy z:

- linia pasująca do regexu atrybucji,
- początek ciągu linii z prefiksem `>`,
- separator `-----Original Message-----` / `-----Wiadomość oryginalna-----`.

`collapsed` = linie przed granicą, `full` = wszystkie.

### Regex atrybucji (wielojęzyczny)

Kotwiczony na początku tekstu elementu/linii (po przycięciu białych znaków), aby
nie łapać „...wrote:" w środku zdania.

- EN: `On … wrote:`, `-----Original Message-----`, blok `From: … Sent: … To:`
- PL: `W dniu … pisze:` / `… napisał(a):`, `Wiadomość napisana przez … w dniu …`,
  `-----Wiadomość oryginalna-----`, blok `Od: … Wysłano: … Do: … Temat:`
- DE: `Am … schrieb:`, `Von:`

## Przypadki brzegowe

- **Brak granicy** → treść bez zmian, brak przycisku.
- **Guard pustej odpowiedzi** — jeśli po cięciu `collapsed` nie zawiera znaczącej
  treści (cały mail to cytat albo czysty forward), ustawiamy `hasHistory=false`
  i pokazujemy całość; nie zwijamy treści do zera.
- **Wiele poziomów cytatu** → jeden toggle na pierwszej granicy zwija całą resztę.
- **Zniekształcony HTML / wyjątek parsera** → `try/catch`, fallback do pełnej
  treści (`hasHistory=false`).
- **Baner „Remote content"** — zostaje nad ramką, toggle pod treścią; nie kolidują.
- **Tryb Strict** — działa (podmiana `srcDoc`, brak zależności od `contentDocument`).
- Sygnatur nie zwijamy — wykrywamy wyłącznie historię cytatu.

## UX

- Gdy `hasHistory`: treść domyślnie zwinięta; pod nią przycisk-pigułka „•••".
- Etykiety: „Pokaż cytowaną historię" ↔ „Ukryj cytowaną historię".
- Po rozwinięciu HTML: ramka przerenderowuje się z `full`, `autoResize`
  przelicza wysokość (drobne mignięcie — akceptowalne).
- Plain-text: `<pre>` pokazuje `collapsed`; rozwinięcie podmienia na `full`.

## Testy

- `src/shared/quotedHistory.test.ts` — fixtury:
  - per klient: Gmail, Outlook/OWA, Apple Mail, Thunderbird, Yahoo, Proton,
  - PL i EN (atrybucja), DE (podstawowy),
  - plain-text z prefiksem `>`,
  - brak cytatu (`hasHistory=false`, `collapsed === full`),
  - guard „cały mail to cytat",
  - malformed HTML (fallback bez wyjątku).
  - Asercje: `hasHistory`; `collapsed` nie zawiera markerów historii; `full` je
    zawiera.
- `src/features/reader/MessageBodyView.test.tsx` (rozszerzenie):
  - toggle widoczny przy historii, domyślnie zwinięty (ramka dostaje `collapsed`),
  - klik rozwija (ramka dostaje `full`), ponowny klik zwija,
  - brak toggla bez historii,
  - ścieżka plain-text analogicznie.
  - Mocki `useRenderedMessage` / `useMessageBody` muszą zwracać treść z cytatem.

## Poza zakresem (YAGNI)

- Licznik ukrytych wiadomości.
- Zwijanie każdego poziomu cytatu osobno (zagnieżdżone toggle).
- Zapamiętywanie stanu rozwinięcia między otwarciami maila.
- Zmiany w backendzie / typach IPC.
