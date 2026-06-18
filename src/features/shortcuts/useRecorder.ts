import { useEffect, useRef, useState } from "react";
import { eventToStep } from "./bindings";

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

export function useRecorder(onCommit: (binding: string) => void, timeoutMs = 800) {
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const stepsRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function stop() {
    clearTimer();
    setRecording(false);
    stepsRef.current = [];
    setSteps([]);
  }

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stop();
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      const next = [...stepsRef.current, eventToStep(e)];
      stepsRef.current = next;
      setSteps(next);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        const binding = stepsRef.current.join(" ");
        stop();
        if (binding) commitRef.current(binding);
      }, timeoutMs);
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimer();
    };
  }, [recording, timeoutMs]);

  return {
    recording,
    steps,
    start: () => {
      stepsRef.current = [];
      setSteps([]);
      setRecording(true);
    },
    cancel: stop,
  };
}
