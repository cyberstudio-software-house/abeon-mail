import { useRef, useEffect, useState, type ReactNode } from "react";

type ToolbarPopoverProps = {
  trigger: ReactNode;
  label: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
};

export function ToolbarPopover({ trigger, label, disabled, children }: ToolbarPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="toolbar-popover" ref={containerRef}>
      <button
        type="button"
        className="toolbar-btn"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && <div className="toolbar-popover__panel" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}
