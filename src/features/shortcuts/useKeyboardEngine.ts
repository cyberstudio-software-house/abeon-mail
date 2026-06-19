import { useEffect, useRef } from "react";
import { ACTIONS, type ActionContext, type ActionId } from "./registry";
import { eventToStep } from "./bindings";

export type EngineOptions = {
  getResolved: () => Record<ActionId, string | null>;
  getHandlers: () => Partial<Record<ActionId, () => void>>;
  getContext: () => ActionContext;
  sequenceTimeoutMs?: number;
};

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function inScope(contexts: ActionContext[], ctx: ActionContext): boolean {
  return contexts.includes(ctx) || contexts.includes("global");
}

function findExact(
  candidate: string,
  ctx: ActionContext,
  resolved: Record<ActionId, string | null>,
  handlers: Partial<Record<ActionId, () => void>>
): ActionId | null {
  let globalMatch: ActionId | null = null;
  for (const a of ACTIONS) {
    if (!a.enabled || !inScope(a.contexts, ctx)) continue;
    if (resolved[a.id] !== candidate || !handlers[a.id]) continue;
    if (a.contexts.includes(ctx) && ctx !== "global") return a.id;
    globalMatch = globalMatch ?? a.id;
  }
  return globalMatch;
}

function isPrefix(
  candidate: string,
  ctx: ActionContext,
  resolved: Record<ActionId, string | null>
): boolean {
  const cand = candidate.split(" ");
  for (const a of ACTIONS) {
    if (!a.enabled || !inScope(a.contexts, ctx)) continue;
    const b = resolved[a.id];
    if (!b) continue;
    const tokens = b.split(" ");
    if (cand.length >= tokens.length) continue;
    if (tokens.slice(0, cand.length).join(" ") === candidate) return true;
  }
  return false;
}

export function useKeyboardEngine(opts: EngineOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    function clearBuffer() {
      bufferRef.current = [];
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function armTimer() {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const ms = optsRef.current.sequenceTimeoutMs ?? 800;
      timerRef.current = window.setTimeout(() => {
        bufferRef.current = [];
        timerRef.current = null;
      }, ms);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (MODIFIER_KEYS.has(e.key)) return;
      const step = eventToStep(e);
      const hasMod = step.startsWith("Mod+");
      if (isEditableTarget(e.target) && !hasMod && e.key !== "Escape") return;

      const ctx = optsRef.current.getContext();
      const resolved = optsRef.current.getResolved();
      const handlers = optsRef.current.getHandlers();

      const candidate = [...bufferRef.current, step].join(" ");
      const exact = findExact(candidate, ctx, resolved, handlers);
      if (exact) {
        e.preventDefault();
        clearBuffer();
        handlers[exact]!();
        return;
      }
      if (isPrefix(candidate, ctx, resolved)) {
        bufferRef.current = [...bufferRef.current, step];
        armTimer();
        e.preventDefault();
        return;
      }
      const fresh = findExact(step, ctx, resolved, handlers);
      if (fresh) {
        e.preventDefault();
        clearBuffer();
        handlers[fresh]!();
        return;
      }
      if (isPrefix(step, ctx, resolved)) {
        bufferRef.current = [step];
        armTimer();
        e.preventDefault();
        return;
      }
      clearBuffer();
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearBuffer();
    };
  }, []);
}
