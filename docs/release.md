# Release & Update Flow

AbeonMail ships signed updates via `tauri-plugin-updater`. This is a manual flow
(no CI yet).

## 1. Bump the version

Update the version in THREE places (they must match — `src/test/version-consistency.test.ts` enforces it):

- `Cargo.toml` → `[workspace.package] version`
- `src-tauri/tauri.conf.json` → `version`
- `package.json` → `version`

Run `npx vitest run src/test/version-consistency.test.ts` to confirm they agree.

## 2. Build the installers

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/.tauri/abeonmail.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # the password chosen at key generation
npm run tauri build
```

On Linux this produces `.deb`, `.AppImage` and `.rpm` plus, because
`bundle.createUpdaterArtifacts` is `true`, an updater archive and its `.sig`
signature file per target under `src-tauri/target/release/bundle/`.

## 3. Publish `latest.json`

Create a `latest.json` manifest:

```json
{
  "version": "0.2.0",
  "notes": "What changed in this release.",
  "pub_date": "2026-06-20T00:00:00Z",
  "platforms": {
    "linux-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/cyberstudio/abeonmail/releases/download/v0.2.0/AbeonMail_0.2.0_amd64.AppImage.tar.gz"
    }
  }
}
```

Add one entry per platform/arch you ship (`windows-x86_64`, `darwin-aarch64`, …).

## 4. Host the release

Upload the installers, the updater archives, the `.sig` files and `latest.json`
to a GitHub Release. The updater `endpoints` in `tauri.conf.json` points at
`releases/latest/download/latest.json`; adjust it if you host elsewhere.

## 5. The signing key is a secret

`src-tauri/.tauri/abeonmail.key` is the PRIVATE signing key. It is gitignored
and MUST be backed up securely. **If you lose it, you cannot sign updates that
existing installs will accept** — the update chain breaks and users must
reinstall manually. Use a real password for production keys.

The current dev key was generated with an empty password (`--ci`); regenerate it
with a real password before any public release and update `plugins.updater.pubkey`
in `tauri.conf.json` accordingly.
