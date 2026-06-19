# Etap 7d — Packaging + Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AbeonMail distributable — complete bundle metadata, MIT license, a full Tauri 2 auto-updater (signed artifacts + "Check for updates" UI), and a documented manual release flow.

**Architecture:** Configuration + metadata + the `tauri-plugin-updater`/`tauri-plugin-process` plugins + a small frontend "About & Updates" panel inside Settings → General + `docs/release.md`. The signing private key is a gitignored secret. A vitest version-consistency test guards the three version sources against drift.

**Tech Stack:** Tauri 2 bundler, `tauri-plugin-updater` "2", `tauri-plugin-process` "2", `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, `@tauri-apps/api/app` `getVersion`, React 19 + vitest.

## Global Constraints

- All code identifiers in English. NO comments in source files. (CLAUDE.md)
- Conventional Commits 1.0.0. Do NOT add a co-author. Do NOT push. (CLAUDE.md)
- Never `git add .` — stage explicit paths only. The signing **private key** (`src-tauri/.tauri/*.key`) and `.env`/`client_secret_*.json` must NEVER be committed.
- `pubkey` in `tauri.conf.json` is the CONTENT of the generated `.pub` file, not a path. The private key is a secret.
- Version single source today = workspace `Cargo.toml` `[workspace.package] version`; `tauri.conf.json` + `package.json` mirror it. All three MUST stay equal (enforced by a test).
- Linux build is verified best-effort only; Windows/macOS config blocks are prepared but not built here.
- `npm run build` is `tsc && vite build` and typechecks test files (`tsconfig` `include: ["src"]`); `noUnusedLocals`/`noUnusedParameters` ON → run BOTH `npx vitest run` AND `npm run build` after every frontend task. New lucide icons used in app code MUST be added to `src/test/lucide-stub.js`.
- Node 24 PATH for every command: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`.

---

### Task 1: Bundle metadata + MIT license + version-consistency test

**Files:**
- Modify: `src-tauri/tauri.conf.json` (expand `bundle`)
- Modify: `src-tauri/Cargo.toml` (`authors`, `license`, `homepage`, `repository`)
- Modify: `package.json` (`license`, `author`)
- Create: `LICENSE` (MIT)
- Create: `src/test/version-consistency.test.ts`

**Interfaces:**
- Produces: complete bundle metadata; a test asserting the three version strings are equal.

- [ ] **Step 1: Write the failing test**

Create `src/test/version-consistency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

function tauriVersion(): string {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  return conf.version;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return pkg.version;
}

function workspaceCargoVersion(): string {
  const toml = readFileSync(resolve(root, "Cargo.toml"), "utf8");
  const block = toml.slice(toml.indexOf("[workspace.package]"));
  const match = block.match(/version\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("workspace version not found");
  return match[1];
}

describe("version consistency", () => {
  it("tauri.conf.json, package.json and workspace Cargo.toml share one version", () => {
    const tauri = tauriVersion();
    const pkg = packageVersion();
    const cargo = workspaceCargoVersion();
    expect(pkg).toBe(tauri);
    expect(cargo).toBe(tauri);
  });
});
```

- [ ] **Step 2: Run it (it should already PASS — versions are currently 0.1.0 everywhere)**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/test/version-consistency.test.ts`
Expected: PASS. (This test is a permanent regression guard; it passes now and must keep passing.) If it FAILS, the version sources are already out of sync — stop and report.

- [ ] **Step 3: Create the LICENSE file**

Create `LICENSE` (standard MIT text):

```text
MIT License

Copyright (c) 2026 Cyberstudio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Expand the bundle section in tauri.conf.json**

In `src-tauri/tauri.conf.json`, replace the entire `"bundle"` object with:

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "category": "Email",
    "copyright": "© 2026 Cyberstudio",
    "publisher": "Cyberstudio",
    "shortDescription": "Fast, private desktop email client",
    "longDescription": "AbeonMail is an offline-first desktop email client for Linux, Windows and macOS. It keeps your mail local, syncs in the background, and stays out of your way.",
    "licenseFile": "../LICENSE",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "linux": {
      "deb": {
        "depends": []
      }
    },
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    },
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
  }
```

- [ ] **Step 5: Add author/license metadata to Cargo.toml and package.json**

In `src-tauri/Cargo.toml`, replace the `[package]` block's `authors = []` line and add license/homepage/repository so the block reads:

```toml
[package]
name = "abeonmail"
version.workspace = true
edition.workspace = true
description = "AbeonMail desktop email client"
authors = ["Cyberstudio"]
license = "MIT"
homepage = "https://cyberstudio.pl"
repository = "https://github.com/cyberstudio/abeonmail"
default-run = "abeonmail"
```

In `package.json`, add two top-level fields after `"version": "0.1.0",`:

```json
  "license": "MIT",
  "author": "Cyberstudio",
```

- [ ] **Step 6: Verify suite + build + cargo check**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/test/version-consistency.test.ts && npm run build && cargo check -p abeonmail`
Expected: test PASS; frontend build clean; `cargo check` clean (the metadata keys are valid).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json LICENSE src/test/version-consistency.test.ts
git commit -m "chore(packaging): bundle metadata, MIT license, version-consistency test"
```

---

### Task 2: Updater + process plugins, signing keypair, updater config

**Files:**
- Modify: `src-tauri/Cargo.toml` (add two plugin deps)
- Modify: `src-tauri/src/lib.rs` (register two plugins)
- Modify: `src-tauri/tauri.conf.json` (`bundle.createUpdaterArtifacts` + `plugins.updater`)
- Modify: `src-tauri/capabilities/default.json` (add `updater:default`, `process:default`)
- Modify: `package.json` (add two JS deps)
- Modify: `.gitignore` (ignore the private signing key)
- Create: `src-tauri/.tauri/abeonmail.key` + `.pub` (generated; the `.key` is gitignored)
- (Regenerated) `src-tauri/gen/schemas/*.json`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a working updater plugin wired into the app with a real public key; `check`/`downloadAndInstall`/`relaunch` available to the frontend (Task 3).

- [ ] **Step 1: Add gitignore rule for the private key FIRST**

In `.gitignore`, add a line (so the key can never be accidentally staged):

```
src-tauri/.tauri/
```

- [ ] **Step 2: Generate the signing keypair**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
mkdir -p src-tauri/.tauri
npm run tauri signer generate -- --password "" -w src-tauri/.tauri/abeonmail.key
```
This writes `src-tauri/.tauri/abeonmail.key` (PRIVATE — gitignored) and `src-tauri/.tauri/abeonmail.key.pub` (PUBLIC). Then read the public key content:
```bash
cat src-tauri/.tauri/abeonmail.key.pub
```
Copy that exact one-line base64 string — it is the `pubkey` value for Step 4. (Empty password is acceptable for this local dev key; `docs/release.md` in Task 4 documents using a real password + secure backup for production.)

- [ ] **Step 3: Add the plugin dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, after the `tauri-plugin-notification = "2"` line add:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

In `package.json` `dependencies`, after `"@tauri-apps/plugin-opener": "^2",` add:

```json
    "@tauri-apps/plugin-process": "^2",
    "@tauri-apps/plugin-updater": "^2",
```

Then install JS deps:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npm install
```

- [ ] **Step 4: Register the plugins and add updater config**

In `src-tauri/src/lib.rs`, after the `.plugin(tauri_plugin_notification::init())` line add:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

In `src-tauri/tauri.conf.json`, add `"createUpdaterArtifacts": true` as the first key inside `"bundle"` (so it reads `"bundle": { "active": true, "createUpdaterArtifacts": true, ...`), and add a top-level `"plugins"` object (sibling of `"bundle"`) — replace `<PUBKEY>` with the exact string from Step 2:

```json
  "plugins": {
    "updater": {
      "pubkey": "<PUBKEY>",
      "endpoints": [
        "https://github.com/cyberstudio/abeonmail/releases/latest/download/latest.json"
      ]
    }
  }
```

- [ ] **Step 5: Add capabilities**

In `src-tauri/capabilities/default.json`, add two permissions to the `"permissions"` array (after `"notification:default"`):

```json
    "updater:default",
    "process:default"
```

- [ ] **Step 6: Build (registers plugins, regenerates schemas)**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && cargo build -p abeonmail`
Expected: compiles. Adding the plugins + capabilities regenerates `src-tauri/gen/schemas/*.json` (tracked build artifacts). Confirm the working tree shows the two new keys (`updater`, `process`) appeared in the regenerated schema/acl files and the private key is NOT staged:
```bash
git status --porcelain
```
`src-tauri/.tauri/` must NOT appear (it is gitignored).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json package.json package-lock.json .gitignore src-tauri/gen/schemas
git commit -m "feat(updater): wire tauri updater + process plugins and signing key"
```

(Do NOT `git add src-tauri/.tauri` — it is the private key, gitignored. Confirm `git status` shows it untracked-and-ignored before committing.)

---

### Task 3: "About & Updates" panel in Settings → General

**Files:**
- Create: `src/features/updates/useAppUpdate.ts`
- Create: `src/features/updates/UpdatesPanel.tsx`
- Create: `src/features/updates/UpdatesPanel.test.tsx`
- Modify: `src/features/settings/GeneralSection.tsx` (render the panel)
- Modify: `src/features/settings/GeneralSection.test.tsx` (mock the panel)
- Modify: `src/test/lucide-stub.js` (add `RefreshCw`, `Download` if used)

**Interfaces:**
- Consumes: `@tauri-apps/plugin-updater` (`check`), `@tauri-apps/plugin-process` (`relaunch`), `@tauri-apps/api/app` (`getVersion`).
- Produces: `useAppUpdate()` returning `{ version, status, newVersion, error, checkForUpdate, installUpdate }` where `status: "idle" | "checking" | "uptodate" | "available" | "downloading" | "error"`; `UpdatesPanel` component.

- [ ] **Step 1: Write the failing component test**

Create `src/features/updates/UpdatesPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { check, relaunch, getVersion, downloadAndInstall } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  downloadAndInstall: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => getVersion() }));

import { UpdatesPanel } from "./UpdatesPanel";

beforeEach(() => {
  vi.clearAllMocks();
  getVersion.mockResolvedValue("0.1.0");
});
afterEach(() => cleanup());

describe("UpdatesPanel", () => {
  it("shows the app version", async () => {
    const { getByText } = render(<UpdatesPanel />);
    await waitFor(() => expect(getByText(/0\.1\.0/)).toBeTruthy());
  });

  it("reports up to date when no update is available", async () => {
    check.mockResolvedValue(null);
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/up to date/i)).toBeTruthy());
  });

  it("offers install when an update is available", async () => {
    check.mockResolvedValue({ available: true, version: "0.2.0", downloadAndInstall });
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/0\.2\.0/)).toBeTruthy());
    expect(getByText("Download & install")).toBeTruthy();
  });

  it("surfaces an error when the check fails", async () => {
    check.mockRejectedValue(new Error("network"));
    const { getByText } = render(<UpdatesPanel />);
    fireEvent.click(getByText("Check for updates"));
    await waitFor(() => expect(getByText(/couldn't check/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/updates/UpdatesPanel.test.tsx`
Expected: FAIL — cannot resolve `./UpdatesPanel`.

- [ ] **Step 3: Create the update hook**

Create `src/features/updates/useAppUpdate.ts`:

```ts
import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

type UpdateStatus = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

type AvailableUpdate = { version: string; downloadAndInstall: () => Promise<void> };

export function useAppUpdate() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [newVersion, setNewVersion] = useState("");
  const [pending, setPending] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    let active = true;
    getVersion()
      .then((v) => active && setVersion(v))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function checkForUpdate() {
    setStatus("checking");
    try {
      const update = await check();
      if (update && update.available) {
        setPending(update as AvailableUpdate);
        setNewVersion(update.version);
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch {
      setStatus("error");
    }
  }

  async function installUpdate() {
    if (!pending) return;
    setStatus("downloading");
    try {
      await pending.downloadAndInstall();
      await relaunch();
    } catch {
      setStatus("error");
    }
  }

  return { version, status, newVersion, checkForUpdate, installUpdate };
}
```

- [ ] **Step 4: Create the panel**

Create `src/features/updates/UpdatesPanel.tsx`:

```tsx
import { useAppUpdate } from "./useAppUpdate";

export function UpdatesPanel() {
  const u = useAppUpdate();

  return (
    <div className="updates-panel">
      <div className="updates-panel__version">AbeonMail {u.version}</div>
      <button
        type="button"
        className="updates-panel__check"
        onClick={u.checkForUpdate}
        disabled={u.status === "checking" || u.status === "downloading"}
      >
        Check for updates
      </button>
      {u.status === "checking" && <span className="updates-panel__status">Checking…</span>}
      {u.status === "uptodate" && <span className="updates-panel__status">You're up to date.</span>}
      {u.status === "error" && (
        <span className="updates-panel__status">Couldn't check for updates.</span>
      )}
      {u.status === "available" && (
        <div className="updates-panel__available">
          <span className="updates-panel__status">Version {u.newVersion} is available.</span>
          <button type="button" onClick={u.installUpdate}>Download &amp; install</button>
        </div>
      )}
      {u.status === "downloading" && <span className="updates-panel__status">Downloading…</span>}
    </div>
  );
}
```

- [ ] **Step 5: Run the panel test to verify it passes**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run src/features/updates/UpdatesPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Mount the panel in GeneralSection**

In `src/features/settings/GeneralSection.tsx`, add an import at the top:

```ts
import { UpdatesPanel } from "../updates/UpdatesPanel";
```

and append this block right before the closing `</div>` of the `appearance-section` wrapper (after the Time format `theme-cards` block):

```tsx
      <div className="appearance-field__label">About</div>
      <UpdatesPanel />
```

- [ ] **Step 7: Keep GeneralSection.test isolated from the updater**

In `src/features/settings/GeneralSection.test.tsx`, add (alongside the existing `vi.mock` calls, before the `GeneralSection` import):

```ts
vi.mock("../updates/UpdatesPanel", () => ({ UpdatesPanel: () => null }));
```

- [ ] **Step 8: Verify suite + build**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH" && npx vitest run && npm run build`
Expected: all PASS; build clean. (No new lucide icon is used by this panel, so `lucide-stub.js` needs no change. If you choose to add an icon, add it to `src/test/lucide-stub.js`.)

- [ ] **Step 9: Commit**

```bash
git add src/features/updates/useAppUpdate.ts src/features/updates/UpdatesPanel.tsx src/features/updates/UpdatesPanel.test.tsx src/features/settings/GeneralSection.tsx src/features/settings/GeneralSection.test.tsx
git commit -m "feat(updater): about & updates panel in general settings"
```

---

### Task 4: Release documentation

**Files:**
- Create: `docs/release.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the release guide**

Create `docs/release.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/release.md
git commit -m "docs(packaging): manual release and update flow"
```

---

## Final verification (after all tasks)

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npx vitest run
npm run build
cargo build -p abeonmail
```

Expected: all frontend tests green; build clean; Rust builds with the new plugins. The full `npm run tauri build` (producing Linux installers) is a best-effort manual check — it requires system libraries (libwebkit2gtk etc.) and large disk/time; if the environment cannot run it, the config is validated by `cargo build` + the version-consistency test, and the installer build is left for a machine that can run it.
