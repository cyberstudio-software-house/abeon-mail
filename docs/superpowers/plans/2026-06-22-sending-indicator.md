# Sending-in-progress Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pokazać użytkownikowi nieinwazyjny popover „Sending…" na dole ekranu od momentu kliknięcia Send aż do zakończenia wysyłki, z krótkim „Sent" po sukcesie.

**Architecture:** Wysyłka jest „fire-and-forget" (composer enqueuje op `send_message` i zamyka się). Wskaźnik żyje w globalnym store Zustand, sterowany zdarzeniami z backendu — symetrycznie do istniejącego `SendFailed`. Backend zyskuje nowe zdarzenie `SendSucceeded`; front liczy aktywne wysyłki (licznik + watchdog), a komponent `SendingIndicator` renderuje popover.

**Tech Stack:** Rust (am-sync, am-app, tauri-specta), TypeScript/React, Zustand, lucide-react, vitest + @testing-library/react (happy-dom).

## Global Constraints

- Teksty UI po angielsku: `Sending…`, `Sending (N)…`, `Sent`. (`…` to jeden znak U+2026.)
- Żadnych komentarzy w kodzie; wszystkie identyfikatory po angielsku.
- `src/ipc/bindings.ts` jest GENEROWANY przez Tauri Specta — nigdy nie edytować ręcznie; regenerować komendą `cargo run -p abeonmail --bin export_bindings`.
- Watchdog wysyłki: `SEND_WATCHDOG_MS = 300000` (5 min).
- Commity: Conventional Commits, bez współautora.
- Popover pozycjonowany dół-środek; `SendErrorsBanner` zostaje dół-prawo (nie kolidują).

---

### Task 1: Backend — zdarzenie `SendSucceeded` (pełny łańcuch + regeneracja bindings)

**Files:**
- Modify: `crates/am-sync/src/events.rs` (enum `SyncEvent`, +test wariantu)
- Modify: `crates/am-sync/src/send.rs:213-237` (emisja w gałęzi sukcesu `drain_outbox`)
- Modify: `crates/am-app/src/events.rs` (struct `SendSucceeded` + test pól)
- Modify: `crates/am-app/src/sink.rs:13-35,5` (match arm + import)
- Modify: `crates/am-app/src/lib.rs:88-96` (`collect_events!`)
- Modify: `crates/am-sync/tests/send_greenmail.rs:212-216` (lokalny `CollectingSink` + asercja; e2e/Docker)
- Generated: `src/ipc/bindings.ts` (przez export_bindings — nie edytować ręcznie)

**Interfaces:**
- Produces (Rust): wariant `am_sync::events::SyncEvent::SendSucceeded { account_id: i64 }`.
- Produces (TS, po regeneracji): `events.sendSucceeded` oraz `export type SendSucceeded = { account_id: number }` w `src/ipc/bindings.ts`.

- [ ] **Step 1: Write the failing unit test (am-sync enum variant)**

W `crates/am-sync/src/events.rs`, w module `mod tests`, dodaj:

```rust
    #[test]
    fn send_succeeded_variant_stores_fields() {
        let ev = SyncEvent::SendSucceeded { account_id: 9 };
        assert_eq!(ev, SyncEvent::SendSucceeded { account_id: 9 });
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p am-sync --lib events::tests::send_succeeded_variant_stores_fields`
Expected: FAIL — kompilacja, „no variant named `SendSucceeded`".

- [ ] **Step 3: Add the enum variant**

W `crates/am-sync/src/events.rs` dodaj wariant do enuma `SyncEvent` (po `PrefetchProgress`):

```rust
    PrefetchProgress { account_id: i64, done: i64, total: i64 },
    SendSucceeded { account_id: i64 },
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cargo test -p am-sync --lib events::tests::send_succeeded_variant_stores_fields`
Expected: PASS.

- [ ] **Step 5: Emit the event on successful send**

W `crates/am-sync/src/send.rs`, w `drain_outbox`, w gałęzi `Ok(())` zaraz po `queue_repo::mark_done(db, op.id)?;` (obecnie linia ~236), dodaj emisję:

```rust
                drafts_repo::delete_draft(db, draft_id)?;
                queue_repo::mark_done(db, op.id)?;
                sink.emit(SyncEvent::SendSucceeded { account_id });
```

- [ ] **Step 6: Write the failing test for the am-app event struct**

W `crates/am-app/src/sink.rs`, w module `mod tests`, dodaj:

```rust
    #[test]
    fn send_succeeded_event_struct_has_account_id() {
        let ev = crate::events::SendSucceeded { account_id: 42 };
        assert_eq!(ev.account_id, 42);
    }
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cargo test -p am-app --lib sink::tests::send_succeeded_event_struct_has_account_id`
Expected: FAIL (kompilacja) — `no SendSucceeded in events` oraz `non-exhaustive patterns: SendSucceeded not covered` w `sink.rs` (oba braki domknie Step 8–9).

- [ ] **Step 8: Add the specta event struct**

W `crates/am-app/src/events.rs` dodaj na końcu pliku:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, specta::Type, tauri_specta::Event)]
pub struct SendSucceeded {
    pub account_id: i64,
}
```

- [ ] **Step 9: Map the variant in the sink and register it**

W `crates/am-app/src/sink.rs` rozszerz import (linia 5) o `SendSucceeded`:

```rust
use crate::events::{AccountAuthChanged, MailboxChanged, NewMessages, PrefetchProgress, SendFailed, SendSucceeded, SnoozeWoke, SyncProgress};
```

Dodaj nowe ramię `match` (po ramieniu `PrefetchProgress`):

```rust
            SyncEvent::PrefetchProgress { account_id, done, total } => {
                let _ = PrefetchProgress { account_id, done, total }.emit(&self.app);
            }
            SyncEvent::SendSucceeded { account_id } => {
                let _ = SendSucceeded { account_id }.emit(&self.app);
            }
```

W `crates/am-app/src/lib.rs` dodaj do `collect_events!` (po `events::PrefetchProgress,`):

```rust
            events::PrefetchProgress,
            events::SendSucceeded,
        ])
```

- [ ] **Step 10: Run am-app test to verify it passes**

Run: `cargo test -p am-app --lib sink::tests::send_succeeded_event_struct_has_account_id`
Expected: PASS.

- [ ] **Step 11: Strengthen the e2e (GreenMail) send test**

W `crates/am-sync/tests/send_greenmail.rs` zamień `let sink = am_sync::events::NoopSink;` (linia ~212) i dodaj lokalny sink. Tuż przed funkcją testową dodaj:

```rust
#[derive(Default)]
struct CollectingSink {
    events: std::sync::Mutex<Vec<am_sync::events::SyncEvent>>,
}

impl am_sync::events::SyncEventSink for CollectingSink {
    fn emit(&self, event: am_sync::events::SyncEvent) {
        self.events.lock().unwrap().push(event);
    }
}
```

Zamień użycie sinka i dodaj asercję po `drain_outbox`:

```rust
    let creds = am_sync::auth::KeychainCredentialSource::new();
    let sink = CollectingSink::default();
    drain_outbox(&db, account.id, creds.as_ref(), &sink, now_secs())
        .await
        .expect("drain_outbox failed");

    assert!(
        sink.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, am_sync::events::SyncEvent::SendSucceeded { account_id } if *account_id == account.id)),
        "drain_outbox should emit SendSucceeded for the account"
    );
```

- [ ] **Step 12: Regenerate the TypeScript bindings**

Run: `cargo run -p abeonmail --bin export_bindings`
Expected: aktualizacja `src/ipc/bindings.ts`. Zweryfikuj, że pojawiło się:
- w obiekcie `events`: `sendSucceeded: makeEvent<SendSucceeded>("send-succeeded"),`
- typ: `export type SendSucceeded = { account_id: number };`

Run: `git diff --stat src/ipc/bindings.ts` (oczekiwane zmiany właśnie tych linii).

- [ ] **Step 13: Verify the whole backend compiles and unit tests pass**

Run: `cargo test -p am-sync --lib && cargo test -p am-app --lib && cargo build -p abeonmail`
Expected: PASS / brak błędów kompilacji (test e2e GreenMail z kroku 11 wymaga Dockera i uruchamiany jest osobno przez `cargo test -p am-sync --test send_greenmail`).

- [ ] **Step 14: Commit**

```bash
git add crates/am-sync/src/events.rs crates/am-sync/src/send.rs crates/am-app/src/events.rs crates/am-app/src/sink.rs crates/am-app/src/lib.rs crates/am-sync/tests/send_greenmail.rs src/ipc/bindings.ts
git commit -m "feat(send-status): emit SendSucceeded event on successful send"
```

---

### Task 2: Store — licznik wysyłek + watchdog

**Files:**
- Modify: `src/app/store.ts` (typ `UiState`, stała `SEND_WATCHDOG_MS`, init, akcje, `(set, get)`)
- Test: `src/app/store.test.ts` (nowy)

**Interfaces:**
- Consumes: brak (samodzielne).
- Produces: eksport `SEND_WATCHDOG_MS: number`; pola store `sendingCount: number`, `lastSentAt: number | null`; akcje `markSendStarted(): void`, `markSendSucceeded(): void`, `markSendFailed(): void`.

- [ ] **Step 1: Write the failing test**

Utwórz `src/app/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useUiStore, SEND_WATCHDOG_MS } from "./store";

describe("sending counter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    useUiStore.setState({ sendingCount: 0, lastSentAt: null, sendWatchdogs: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments on each started send", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendStarted();
    expect(useUiStore.getState().sendingCount).toBe(2);
  });

  it("decrements and records lastSentAt on success", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
    expect(useUiStore.getState().lastSentAt).toBe(1_000_000);
  });

  it("decrements without lastSentAt on failure", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendFailed();
    expect(useUiStore.getState().sendingCount).toBe(0);
    expect(useUiStore.getState().lastSentAt).toBeNull();
  });

  it("never goes below zero on an extra confirmation", () => {
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
  });

  it("watchdog clears a stuck send after SEND_WATCHDOG_MS", () => {
    useUiStore.getState().markSendStarted();
    expect(useUiStore.getState().sendingCount).toBe(1);
    vi.advanceTimersByTime(SEND_WATCHDOG_MS);
    expect(useUiStore.getState().sendingCount).toBe(0);
  });

  it("a real confirmation cancels the watchdog (no double decrement)", () => {
    useUiStore.getState().markSendStarted();
    useUiStore.getState().markSendSucceeded();
    expect(useUiStore.getState().sendingCount).toBe(0);
    vi.advanceTimersByTime(SEND_WATCHDOG_MS);
    expect(useUiStore.getState().sendingCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/store.test.ts`
Expected: FAIL — `SEND_WATCHDOG_MS` undefined / `markSendStarted is not a function`.

- [ ] **Step 3: Add the type fields**

W `src/app/store.ts`, w typie `UiState`, po `setPrefetchProgress: (...) => void;` (linia ~54) dodaj:

```ts
  sendingCount: number;
  lastSentAt: number | null;
  sendWatchdogs: ReturnType<typeof setTimeout>[];
  markSendStarted: () => void;
  markSendSucceeded: () => void;
  markSendFailed: () => void;
```

- [ ] **Step 4: Export the constant and switch create to (set, get)**

W `src/app/store.ts`, nad `export const useUiStore` (linia ~156) dodaj:

```ts
export const SEND_WATCHDOG_MS = 300000;
```

Zmień sygnaturę create z `create<UiState>((set) => ({` na:

```ts
export const useUiStore = create<UiState>((set, get) => ({
```

- [ ] **Step 5: Add initial state and actions**

W bloku inicjalizacyjnym, po `prefetchProgress: {},` (linia ~173) dodaj:

```ts
  sendingCount: 0,
  lastSentAt: null,
  sendWatchdogs: [],
```

Po akcji `setPrefetchProgress` (linia ~252) dodaj akcje:

```ts
  markSendStarted: () => {
    const handle = setTimeout(() => {
      set((s) =>
        s.sendingCount <= 0
          ? {}
          : {
              sendingCount: s.sendingCount - 1,
              sendWatchdogs: s.sendWatchdogs.filter((h) => h !== handle),
            },
      );
    }, SEND_WATCHDOG_MS);
    set((s) => ({ sendingCount: s.sendingCount + 1, sendWatchdogs: [...s.sendWatchdogs, handle] }));
  },
  markSendSucceeded: () => {
    const first = get().sendWatchdogs[0];
    if (first) clearTimeout(first);
    set((s) => ({
      sendingCount: Math.max(0, s.sendingCount - 1),
      sendWatchdogs: s.sendWatchdogs.slice(1),
      lastSentAt: Date.now(),
    }));
  },
  markSendFailed: () => {
    const first = get().sendWatchdogs[0];
    if (first) clearTimeout(first);
    set((s) => ({
      sendingCount: Math.max(0, s.sendingCount - 1),
      sendWatchdogs: s.sendWatchdogs.slice(1),
    }));
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/app/store.test.ts`
Expected: PASS (6 passed).

- [ ] **Step 7: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat(send-status): track in-flight send count with watchdog in store"
```

---

### Task 3: Wiring zdarzeń → store

**Files:**
- Modify: `src/ipc/events.ts:67-85` (listener `sendSucceeded`, `markSendFailed` w `sendFailed`)
- Modify: `src/ipc/events.test.tsx` (mock `sendSucceeded`, przechwyt cb, asercje)

**Interfaces:**
- Consumes: `events.sendSucceeded` (Task 1), `markSendSucceeded` / `markSendFailed` (Task 2).
- Produces: brak nowych eksportów.

- [ ] **Step 1: Write the failing tests**

W `src/ipc/events.test.tsx`, w obiekcie `vi.hoisted` (linie 8-16) dodaj dwa pola cb:

```ts
const h = vi.hoisted(() => ({
  newMessagesCb: null as ((e: { payload: { account_id: number; folder_id: number; count: number } }) => void) | null,
  prefetchProgressCb: null as ((e: { payload: { account_id: number; done: number; total: number } }) => void) | null,
  sendSucceededCb: null as ((e: { payload: { account_id: number } }) => void) | null,
  sendFailedCb: null as ((e: { payload: { account_id: number; error: string } }) => void) | null,
  sendNotification: vi.fn(),
  isFocused: vi.fn(),
  isPermissionGranted: vi.fn(),
  buildNewMailNotification: vi.fn(),
  refreshUnreadBadge: vi.fn(),
}));
```

W mocku `events` (linie 23-41) zamień wpis `sendFailed` i dodaj `sendSucceeded`:

```ts
    sendFailed: {
      listen: vi.fn((cb) => {
        h.sendFailedCb = cb;
        return Promise.resolve(() => {});
      }),
    },
    sendSucceeded: {
      listen: vi.fn((cb) => {
        h.sendSucceededCb = cb;
        return Promise.resolve(() => {});
      }),
    },
```

W `beforeEach` (po `h.prefetchProgressCb = null;`) dodaj reset:

```ts
    h.sendSucceededCb = null;
    h.sendFailedCb = null;
    useUiStore.setState({ sendingCount: 0, lastSentAt: null, sendWatchdogs: [] });
```

Dodaj dwa testy w bloku `describe`:

```ts
  it("decrements the sending count on send-succeeded", async () => {
    useUiStore.setState({ sendingCount: 2, lastSentAt: null, sendWatchdogs: [] });
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.sendSucceededCb).not.toBeNull());
    h.sendSucceededCb!({ payload: { account_id: 1 } });
    expect(useUiStore.getState().sendingCount).toBe(1);
  });

  it("decrements the sending count on send-failed", async () => {
    useUiStore.setState({ sendingCount: 1, lastSentAt: null, sendWatchdogs: [] });
    h.isPermissionGranted.mockResolvedValue(false);
    renderHook(() => useSyncEvents(), { wrapper });
    await waitFor(() => expect(h.sendFailedCb).not.toBeNull());
    h.sendFailedCb!({ payload: { account_id: 1, error: "boom" } });
    expect(useUiStore.getState().sendingCount).toBe(0);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: FAIL — `sendingCount` pozostaje 2 / 1 (akcje jeszcze nie wołane), oraz brak `sendSucceeded.listen`.

- [ ] **Step 3: Wire the listeners**

W `src/ipc/events.ts`, w bloku `sendFailed.listen` (linie 67-75) dodaj na początku callbacku wywołanie akcji store:

```ts
    const sendFailedPromise = events.sendFailed.listen(async (event) => {
      useUiStore.getState().markSendFailed();
      queryClient.invalidateQueries({ queryKey: ["sendErrors"] });
      if (await isPermissionGranted()) {
        sendNotification({
          title: "Couldn't send message",
          body: event.payload.error,
        });
      }
    });

    const sendSucceededPromise = events.sendSucceeded.listen(() => {
      useUiStore.getState().markSendSucceeded();
    });
```

W bloku cleanup (linie 77-85) dodaj odpięcie nowego listenera:

```ts
      sendFailedPromise.then((unlisten) => unlisten());
      sendSucceededPromise.then((unlisten) => unlisten());
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ipc/events.test.tsx`
Expected: PASS (wszystkie, łącznie z 2 nowymi).

- [ ] **Step 5: Commit**

```bash
git add src/ipc/events.ts src/ipc/events.test.tsx
git commit -m "feat(send-status): drive send counter from send-succeeded/send-failed events"
```

---

### Task 4: Komponent `SendingIndicator` + render w AppShell

**Files:**
- Create: `src/features/send-status/SendingIndicator.tsx`
- Create: `src/features/send-status/SendingIndicator.css`
- Create: `src/features/send-status/SendingIndicator.test.tsx`
- Modify: `src/test/lucide-stub.js` (dodać `Loader2`)
- Modify: `src/app/AppShell.tsx:8,27` (import + render)

**Interfaces:**
- Consumes: store `sendingCount`, `lastSentAt` (Task 2).
- Produces: `export function SendingIndicator(): JSX.Element | null`.

- [ ] **Step 1: Add Loader2 to the lucide test stub**

W `src/test/lucide-stub.js` dodaj na końcu (obok pozostałych eksportów):

```js
exports.Loader2 = Icon;
```

- [ ] **Step 2: Write the failing component test**

Utwórz `src/features/send-status/SendingIndicator.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SendingIndicator } from "./SendingIndicator";
import { useUiStore } from "../../app/store";

describe("SendingIndicator", () => {
  beforeEach(() => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: null, sendWatchdogs: [] });
  });
  afterEach(cleanup);

  it("shows 'Sending…' for a single in-flight send", () => {
    useUiStore.setState({ sendingCount: 1 });
    const { getByText } = render(<SendingIndicator />);
    expect(getByText("Sending…")).toBeTruthy();
  });

  it("shows a count when more than one send is in flight", () => {
    useUiStore.setState({ sendingCount: 3 });
    const { getByText } = render(<SendingIndicator />);
    expect(getByText("Sending (3)…")).toBeTruthy();
  });

  it("shows 'Sent' briefly after the last send completes", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: Date.now() });
    const { getByText, container } = render(<SendingIndicator />);
    expect(getByText("Sent")).toBeTruthy();
    expect(container.querySelector(".sending-indicator--sent")).not.toBeNull();
  });

  it("renders nothing when idle", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: null });
    const { container } = render(<SendingIndicator />);
    expect(container.querySelector(".sending-indicator")).toBeNull();
  });

  it("renders nothing when the 'Sent' window has elapsed", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: Date.now() - 10000 });
    const { container } = render(<SendingIndicator />);
    expect(container.querySelector(".sending-indicator")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/features/send-status/SendingIndicator.test.tsx`
Expected: FAIL — moduł `./SendingIndicator` nie istnieje.

- [ ] **Step 4: Write the component**

Utwórz `src/features/send-status/SendingIndicator.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { useUiStore } from "../../app/store";
import "./SendingIndicator.css";

const SENT_VISIBLE_MS = 2500;

export function SendingIndicator() {
  const sendingCount = useUiStore((s) => s.sendingCount);
  const lastSentAt = useUiStore((s) => s.lastSentAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sendingCount > 0 || lastSentAt == null) return;
    setNow(Date.now());
    const remaining = SENT_VISIBLE_MS - (Date.now() - lastSentAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [sendingCount, lastSentAt]);

  if (sendingCount > 0) {
    const label = sendingCount > 1 ? `Sending (${sendingCount})…` : "Sending…";
    return (
      <div className="sending-indicator" role="status" aria-live="polite">
        <Loader2 className="sending-indicator__spinner" size={16} aria-hidden="true" />
        <span>{label}</span>
      </div>
    );
  }

  const showSent = lastSentAt != null && now - lastSentAt < SENT_VISIBLE_MS;
  if (showSent) {
    return (
      <div className="sending-indicator sending-indicator--sent" role="status" aria-live="polite">
        <Check size={16} aria-hidden="true" />
        <span>Sent</span>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 5: Write the stylesheet**

Utwórz `src/features/send-status/SendingIndicator.css`:

```css
.sending-indicator {
  position: fixed;
  left: 50%;
  bottom: var(--space-4, 16px);
  transform: translateX(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text, #1a1a1a);
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.sending-indicator--sent {
  color: #1a7f4b;
}

.sending-indicator__spinner {
  animation: sending-indicator-spin 0.8s linear infinite;
}

@keyframes sending-indicator-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 6: Run the component tests to verify they pass**

Run: `npx vitest run src/features/send-status/SendingIndicator.test.tsx`
Expected: PASS (5 passed).

- [ ] **Step 7: Render it in AppShell**

W `src/app/AppShell.tsx` dodaj import (po linii 8 z `SendErrorsBanner`):

```tsx
import { SendErrorsBanner } from "../features/send-errors/SendErrorsBanner";
import { SendingIndicator } from "../features/send-status/SendingIndicator";
```

Dodaj render obok `SendErrorsBanner` (linia 27):

```tsx
      <SendErrorsBanner />
      <SendingIndicator />
```

- [ ] **Step 8: Commit**

```bash
git add src/features/send-status/SendingIndicator.tsx src/features/send-status/SendingIndicator.css src/features/send-status/SendingIndicator.test.tsx src/test/lucide-stub.js src/app/AppShell.tsx
git commit -m "feat(send-status): add SendingIndicator popover to AppShell"
```

---

### Task 5: Composer — start licznika przy wysyłce

**Files:**
- Modify: `src/features/composer/Composer.tsx:185-186` (`markSendStarted` po enqueue)

**Interfaces:**
- Consumes: store `markSendStarted` (Task 2) — `useUiStore` jest już importowany w composerze (linia 8).
- Produces: brak.

> Uwaga: `handleSend` jest opakowany w ciężkie zależności (`useEditor`/TipTap, mutacje), więc dedykowanego unit-testu composera nie dodajemy — koszt mockowania edytora przewyższa wartość dla pojedynczego wywołania. Logikę licznika pokrywają testy store (Task 2) i wiringu (Task 3); ten krok domyka integrację i jest weryfikowany ręcznie (Step 3) oraz pełnym `npm test`.

- [ ] **Step 1: Add the markSendStarted call**

W `src/features/composer/Composer.tsx`, w `handleSend`, między `await enqueueSendMutation.mutateAsync(savedId);` a `closeComposer();` (linie 185-186) dodaj:

```tsx
      await enqueueSendMutation.mutateAsync(savedId);
      useUiStore.getState().markSendStarted();
      closeComposer();
```

- [ ] **Step 2: Run the full frontend test suite (regression)**

Run: `npm test`
Expected: PASS dla nowych plików; brak NOWYCH regresji (bazowa linia: 6 znanych, pre-existing fails — ConversationView reply-button ×3, useDebouncedValue ×3 — nie powiększaj tej liczby).

- [ ] **Step 3: Manual verification (real app)**

Run: `npm run tauri dev` (lub istniejący skrypt uruchomieniowy projektu).
Sprawdź: po kliknięciu Send composer zamyka się, a na dole-środku pojawia się „Sending…"; po dostarczeniu znika i błyska „Sent". Przy szybkim wysłaniu dwóch maili pojawia się „Sending (2)…".

- [ ] **Step 4: Commit**

```bash
git add src/features/composer/Composer.tsx
git commit -m "feat(send-status): mark a send as started when the composer enqueues"
```

---

## Notatki dla implementującego

- Kolejność tasków jest obowiązkowa: Task 1 musi zregenerować `bindings.ts` (zawiera `events.sendSucceeded`), zanim Task 3 będzie się kompilował.
- Nie edytuj `src/ipc/bindings.ts` ręcznie — jeśli czegoś brakuje, ponownie uruchom `cargo run -p abeonmail --bin export_bindings`.
- Znak wielokropka w tekstach to U+2026 („…"), nie trzy kropki — testy porównują dokładny tekst.
- Test e2e GreenMail (Task 1, Step 11) wymaga Dockera; w środowiskach bez Dockera weryfikację emisji `SendSucceeded` zapewnia ścieżka manualna (Task 5, Step 3).
