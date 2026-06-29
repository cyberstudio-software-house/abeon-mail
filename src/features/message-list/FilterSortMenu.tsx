import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useUiStore } from "../../app/store";
import { useGeneral } from "../../shared/general/GeneralProvider";

export function FilterSortMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { listSortDir, setListSortDir } = useGeneral();
  const sender = useUiStore((s) => s.listFilterSender);
  const subject = useUiStore((s) => s.listFilterSubject);
  const attachmentsOnly = useUiStore((s) => s.listFilterAttachmentsOnly);
  const setSender = useUiStore((s) => s.setListFilterSender);
  const setSubject = useUiStore((s) => s.setListFilterSubject);
  const setAttachmentsOnly = useUiStore((s) => s.setListFilterAttachmentsOnly);
  const clearListFilters = useUiStore((s) => s.clearListFilters);

  const filtersActive = sender !== "" || subject !== "" || attachmentsOnly;
  const indicatorActive = filtersActive || listSortDir !== "desc";

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
    <div className="list-filter" ref={containerRef}>
      <button
        type="button"
        className="list-filter__trigger"
        aria-label="Filter and sort"
        aria-haspopup="true"
        aria-expanded={open}
        data-active={indicatorActive}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={15} />
        {indicatorActive && <span className="list-filter__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="list-filter__panel" role="dialog" aria-label="Filter and sort">
          <fieldset className="list-filter__sort">
            <legend>Sort</legend>
            <label>
              <input
                type="radio"
                name="list-sort"
                checked={listSortDir === "desc"}
                onChange={() => setListSortDir("desc")}
              />
              Newest first
            </label>
            <label>
              <input
                type="radio"
                name="list-sort"
                checked={listSortDir === "asc"}
                onChange={() => setListSortDir("asc")}
              />
              Oldest first
            </label>
          </fieldset>

          <div className="list-filter__field">
            <label htmlFor="list-filter-sender">From contains</label>
            <input
              id="list-filter-sender"
              type="text"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </div>

          <div className="list-filter__field">
            <label htmlFor="list-filter-subject">Subject contains</label>
            <input
              id="list-filter-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <label className="list-filter__check">
            <input
              type="checkbox"
              checked={attachmentsOnly}
              onChange={(e) => setAttachmentsOnly(e.target.checked)}
            />
            Only with attachments
          </label>

          <div className="list-filter__footer">
            <button
              type="button"
              className="list-filter__clear"
              disabled={!filtersActive}
              onClick={() => clearListFilters()}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
