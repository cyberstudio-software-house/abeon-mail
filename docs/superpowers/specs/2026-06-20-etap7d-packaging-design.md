# Etap 7d — Packaging + Updater — Design

**Status:** approved (design), pending plan
**Data:** 2026-06-20
**Poprzednie:** 7a signatures (@ 8ae79b9), 7b notifications (@ fb046e6), 7c general+snooze (@ aaf3253)
**Kontekst:** czwarty pod-etap Etapu 7. Sekwencja: 7a → 7b → 7c (DONE) →
**7d Packaging** → 7e Rules & Filters.

## Cel

Przygotować aplikację do dystrybucji: kompletne metadane bundla, instalatory
oraz pełny auto-updater z udokumentowanym (ręcznym) flow wydań. Lokalnie
weryfikujemy build Linux; konfiguracja Windows/macOS gotowa na przyszłość.

## Zablokowane decyzje zakresowe

1. **Auto-updater:** PEŁNY — plugin + para kluczy podpisu + pubkey w configu +
   endpoint (placeholder wzorca GitHub Releases) + UI „Check for updates" +
   udokumentowany ręczny flow wydań. Bez CI.
2. **Platformy:** kompletne metadane cross-platform; lokalnie budujemy i
   weryfikujemy **Linux** (deb/AppImage/rpm); bloki konfiguracji **Windows**
   (nsis) i **macOS** (dmg) przygotowane, ale nie budowane w tym środowisku.

## Stan wyjścia (z eksploracji kodu)

- `src-tauri/tauri.conf.json`: `productName` „AbeonMail", `version` „0.1.0",
  `identifier` „pl.cyberstudio.abeonmail" (poprawny, reverse-domain),
  `bundle.active=true`, `bundle.targets="all"`, lista ikon kompletna.
- **Ikony są prawdziwe** (pełny zestaw 32/128/256 + .icns + .ico + Square* UWP),
  NIE placeholdery Tauri — nie generujemy ikon.
- Wersja: jedno źródło prawdy = workspace `Cargo.toml` `[workspace.package]
  version = "0.1.0"`; `src-tauri/Cargo.toml` dziedziczy (`version.workspace =
  true`); `tauri.conf.json` i `package.json` trzymane ręcznie w zgodzie.
- Braki: metadane bundla (category/copyright/publisher/opisy/license), bloki
  per-platforma, `authors=[]` puste, brak `license` w Cargo.toml/package.json.
- Updater NIEzainstalowany (brak `tauri-plugin-updater` / `@tauri-apps/plugin-
  updater`), brak pubkey/endpointu/kluczy, brak CI (`.github/workflows`),
  brak pushowanego remote.
- Pluginy obecne: opener, dialog, notification (wszystkie „2"). CLI
  `@tauri-apps/cli ^2.11.2`.

## Architektura

Zmiany w warstwie konfiguracji + metadanych + plugin updatera + minimalne UI +
dokumentacja. Nowe zależności: `tauri-plugin-updater` (Rust) +
`@tauri-apps/plugin-updater` (JS). Nowy plik dokumentacji `docs/release.md`.
Klucz prywatny podpisu — gitignorowany sekret.

## Metadane bundla

`tauri.conf.json` `bundle`:
- `category`: „Email".
- `copyright`: „© 2026 Cyberstudio".
- `publisher`: „Cyberstudio".
- `shortDescription`: krótki opis; `longDescription`: pełny.
- `licenseFile` lub `license`: „MIT".
- **Linux:** kategoria desktop (Email), domyślne cele deb/AppImage/rpm.
- **Windows:** blok `bundle.windows` (nsis — np. `installMode`, język).
- **macOS:** blok `bundle.macOS` (dmg, `minimumSystemVersion`).

`src-tauri/Cargo.toml` `[package]`: `authors = ["Cyberstudio"]`,
`license = "MIT"`, `homepage`/`repository`. `package.json`: `license: "MIT"`,
`author`.

## Auto-updater

- Rust: `tauri-plugin-updater = "2"` + `.plugin(tauri_plugin_updater::Builder::
  new().build())` w `src-tauri/src/lib.rs`.
- JS: `@tauri-apps/plugin-updater`.
- `tauri.conf.json` `plugins.updater`: `pubkey` (wygenerowany klucz publiczny),
  `endpoints: ["https://github.com/<org>/<repo>/releases/latest/download/latest.json"]`
  (placeholder wzorca GitHub Releases, do podmiany na realny host).
- Capability `updater:default` w `src-tauri/capabilities/default.json`.
- **Para kluczy:** wygenerowana (`tauri signer generate`); **klucz publiczny**
  w configu; **klucz prywatny + hasło — SEKRET**: gitignorowany plik (np.
  `src-tauri/.tauri/abeonmail.key`) + zmienna `TAURI_SIGNING_PRIVATE_KEY` do
  buildów. `.gitignore` MUSI wykluczać klucz prywatny (jak `client_secret_*.json`/
  `.env`). Utrata klucza = zerwany łańcuch aktualizacji (ostrzeżenie w docs).

## Frontend — „About & Updates"

Blok dołożony do istniejącej sekcji **Settings → General** (bez nowej pozycji
w nawigacji):
- **Wersja aplikacji** (przez `getVersion()` z `@tauri-apps/api/app`).
- **„Check for updates"** (`check()` z `@tauri-apps/plugin-updater`) ze stanami:
  `idle` → `checking` → `up-to-date` / `available` (przycisk
  „Download & install" → `downloadAndInstall` → `relaunch`) / `error`.
- Logika izolowana w testowalnym module/hooku; UI cienkie.

## Spójność wersji

Mały **test spójności wersji** (vitest lub skrypt node) asertujący, że
`tauri.conf.json` `version` == workspace `Cargo.toml` `[workspace.package]
version` == `package.json` `version`. To realny, automatyczny gate chroniący
przed rozjazdem przy bumpie.

## Docs — `docs/release.md`

Udokumentowany ręczny flow wydania:
1. Bump wersji w trzech miejscach (tauri.conf.json, workspace Cargo.toml,
   package.json) — test spójności pilnuje.
2. `npm run tauri build` (Linux: deb/AppImage/rpm).
3. Podpisanie artefaktów kluczem prywatnym (`TAURI_SIGNING_PRIVATE_KEY`).
4. Format `latest.json` (version, notes, pub_date, platforms{signature,url}).
5. Hosting na GitHub Releases; konfiguracja `endpoints`.
6. **Backup klucza prywatnego** (utrata = brak możliwości wydania aktualizacji).

## Testy / weryfikacja

- **Automatyczne (gate):** test spójności wersji; test komponentu „Updates"
  (mock `@tauri-apps/plugin-updater` `check`/`downloadAndInstall` i
  `@tauri-apps/api/app` `getVersion` — stany checking/up-to-date/available/error).
- **Best-effort (NIE blokuje mergu):** `npm run tauri build` → instalatory Linux
  + uruchomienie aplikacji. Build jest ciężki i wymaga systemowych libów
  (libwebkit2gtk itp.); jeśli środowisko go nie wykona, weryfikujemy walidacją
  configu (tauri waliduje schemat configu przy buildzie) i test spójności.

## Test-infra (utrwalone konwencje)

- Nowe ikony lucide w kodzie aplikacji → `src/test/lucide-stub.js` (jeśli UI
  „Updates" użyje nowej ikony).
- `tsconfig` `include: ["src"]` typechecks testy; `noUnusedLocals`/
  `noUnusedParameters` ON → po każdym zadaniu `npx vitest run` ORAZ
  `npm run build`. Mock `@tauri-apps/plugin-updater` + `@tauri-apps/api/app`
  tam, gdzie ładowany jest komponent Updates.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.
- Po dodaniu pluginu Rust + capability `tauri-build` regeneruje
  `src-tauri/gen/schemas/*.json` (śledzone) — zacommitować jako artefakt buildu.

## Deferred / tech-debt

- CI/GitHub Actions (release workflow) — wymaga pushowanego remote.
- Code signing (Windows Authenticode) + macOS notaryzacja — wymaga certyfikatów.
- Faktyczny build Windows/macOS (wymaga maszyn/runnerów tych platform).
- Auto-check aktualizacji przy starcie (na razie tylko ręczny „Check for
  updates").
- Realny host endpointu (placeholder do podmiany).
