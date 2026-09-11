import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api } from "./lib/api";
import type { EntryListRecord } from "./lib/types";

type BookEntrySortKey = "position" | "term" | "reading" | "meaning" | "attempts";

export function BookInlineEntryManager({ deckId, onAdd, onImport, onEdit, onDelete }: {
  deckId: string;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (entry: EntryListRecord) => void;
  onDelete: (entry: EntryListRecord) => void;
}) {
  const [entries, setEntries] = useState<EntryListRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: BookEntrySortKey; direction: "asc" | "desc" }>({ key: "position", direction: "asc" });
  const requestIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowHeight = 34;
  const tabDirection = useRef(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setViewport((current) => {
      const top = Math.floor(list.scrollTop / rowHeight) * rowHeight;
      const height = list.clientHeight;
      return current.top === top && current.height === height ? current : { top, height };
    });
    const observer = new ResizeObserver(measure);
    const trackTab = (event: globalThis.KeyboardEvent) => { tabDirection.current = event.key === "Tab" ? (event.shiftKey ? -1 : 1) : 0; };
    const clearTab = () => { tabDirection.current = 0; };
    window.addEventListener("keydown", trackTab, true);
    window.addEventListener("pointerdown", clearTab, true);
    observer.observe(list);
    list.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect(); list.removeEventListener("scroll", measure);
      window.removeEventListener("keydown", trackTab, true);
      window.removeEventListener("pointerdown", clearTab, true);
    };
  }, []);

  const updateOverflowTooltip = (element: HTMLElement, text: string) => {
    if (element.scrollWidth > element.clientWidth) element.title = text;
    else element.removeAttribute("title");
  };

  useEffect(() => {
    let disposed = false;
    const loadEntries = async (scrollToBottom = false) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      try {
        const nextEntries = await api.listEntries(deckId);
        if (!disposed && requestId === requestIdRef.current) {
          setEntries(nextEntries);
          if (scrollToBottom) {
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
              const list = listRef.current;
              if (list) list.scrollTop = list.scrollHeight;
            }));
          }
        }
      } finally {
        if (!disposed && requestId === requestIdRef.current) setLoading(false);
      }
    };
    const handleEntriesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ deckId?: string; scrollToBottom?: boolean }>).detail;
      if (detail?.deckId === deckId) void loadEntries(Boolean(detail.scrollToBottom));
    };

    void loadEntries();
    window.addEventListener("tanren:deck-entries-changed", handleEntriesChanged);
    return () => {
      disposed = true;
      window.removeEventListener("tanren:deck-entries-changed", handleEntriesChanged);
    };
  }, [deckId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    let scrollTarget = list.scrollTop;
    let scrollFrame: number | null = null;
    let lastWheelAt = 0;

    const settleAt = (scrollTop: number) => {
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
      }
      list.scrollTop = scrollTop;
      scrollTarget = scrollTop;
    };

    const smoothScrollBy = (deltaY: number) => {
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      const base = scrollFrame === null ? list.scrollTop : scrollTarget;
      let nextTarget = Math.max(0, Math.min(maxScrollTop, base + deltaY));
      const edgeSnapDistance = Math.max(32, Math.abs(deltaY) * 1.25);
      if (deltaY < 0 && nextTarget <= edgeSnapDistance) nextTarget = 0;
      if (deltaY > 0 && maxScrollTop - nextTarget <= edgeSnapDistance) nextTarget = maxScrollTop;
      scrollTarget = nextTarget;

      if (scrollFrame !== null) return;

      const animate = () => {
        const diff = scrollTarget - list.scrollTop;
        if (Math.abs(diff) < 0.5) {
          settleAt(scrollTarget);
          return;
        }
        const previousScrollTop = list.scrollTop;
        list.scrollTop = previousScrollTop + diff * 0.2;
        if (list.scrollTop === previousScrollTop) {
          settleAt(scrollTarget);
          return;
        }
        scrollFrame = requestAnimationFrame(animate);
      };

      scrollFrame = requestAnimationFrame(animate);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const deltaY = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 40
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * list.clientHeight
          : event.deltaY;
      const now = performance.now();
      const wheelGapMs = now - lastWheelAt;
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      const effectiveScrollTop = scrollFrame === null ? list.scrollTop : scrollTarget;
      const canScrollUp = deltaY < 0 && effectiveScrollTop > 2;
      const canScrollDown = deltaY > 0 && maxScrollTop - effectiveScrollTop > 2;
      const settlingAtEdge = scrollFrame !== null
        && ((deltaY < 0 && effectiveScrollTop <= 2) || (deltaY > 0 && maxScrollTop - effectiveScrollTop <= 2));

      if (canScrollUp || canScrollDown || settlingAtEdge) {
        smoothScrollBy(deltaY);
        lastWheelAt = now;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        return;
      }
      const atEdge = (deltaY < 0 && effectiveScrollTop <= 2)
        || (deltaY > 0 && maxScrollTop - effectiveScrollTop <= 2);
      if (atEdge && wheelGapMs < 240) {
        lastWheelAt = now;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        return;
      }
      lastWheelAt = now;
    };

    list.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      list.removeEventListener("wheel", onWheel);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  }, []);

  const query = search.trim().toLocaleLowerCase();
  const filteredEntries = useMemo(() => query
    ? entries.filter((entry) => entry.term.toLocaleLowerCase().includes(query)
      || (entry.reading ?? "").toLocaleLowerCase().includes(query)
      || entry.meanings.some((meaning) => meaning.toLocaleLowerCase().includes(query)))
    : entries, [entries, query]);
  const textCollator = useMemo(() => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }), []);
  const sortedEntries = useMemo(() => {
    if (sort.key === "position" && sort.direction === "asc") return filteredEntries;
    return [...filteredEntries].sort((left, right) => {
    let result = 0;
    if (sort.key === "position") result = left.position - right.position;
    else if (sort.key === "attempts") result = left.attempts - right.attempts;
    else if (sort.key === "term") result = textCollator.compare(left.term, right.term);
    else if (sort.key === "reading") result = textCollator.compare(left.reading ?? "", right.reading ?? "");
    else result = textCollator.compare(left.meanings.join(" / "), right.meanings.join(" / "));
    if (result === 0) result = left.position - right.position;
    return sort.direction === "asc" ? result : -result;
    });
  }, [filteredEntries, sort, textCollator]);
  const start = Math.max(0, Math.min(sortedEntries.length, Math.floor(viewport.top / rowHeight) - 8));
  const end = Math.min(sortedEntries.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + 8);
  const focusedIndex = focusedId === null ? -1 : sortedEntries.findIndex((entry) => entry.id === focusedId);
  const visibleIndices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) {
    visibleIndices.push(focusedIndex);
    visibleIndices.sort((a, b) => a - b);
  }
  const focusEntry = (index: number, action: number) => {
    const list = listRef.current;
    if (!list) return;
    // Bring the next logical row into the DOM before native focus/scroll runs.
    if (index < start || index >= end) {
      list.scrollTop = index * rowHeight;
      flushSync(() => setViewport({ top: list.scrollTop, height: list.clientHeight }));
    }
    list.querySelector<HTMLElement>(`[data-entry-index="${index}"] button:nth-of-type(${action + 1})`)?.focus();
  };
  const toggleSort = (key: BookEntrySortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  const sortMark = (key: BookEntrySortKey) => sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  const sortMarkBefore = (key: BookEntrySortKey) => sort.key === key ? (sort.direction === "asc" ? "↑ " : "↓ ") : "";

  return <section className="book-inline-entries" aria-label="표현 관리">
    <div className="book-inline-entry-toolbar">
      <input
        className="home-create-input"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="표현 검색"
        aria-label="표현 검색"
      />
      <button className="settings-action-button book-inline-entry-add" onClick={onAdd} aria-label="표현 추가">+</button>
      <button type="button" className="settings-action-button book-inline-entry-import" onClick={onImport} aria-label="파일에서 표현 추가" title="파일에서 표현 추가">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 3.5h7l4 4V20.5H7z" />
          <path d="M14 3.5v4h4" />
        </svg>
      </button>
    </div>
    <div className={`book-inline-entry-list ${loading || filteredEntries.length === 0 ? "is-empty" : ""}`} ref={listRef}
      onFocusCapture={(event) => {
        setFocusedId(event.target.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId ?? null);
        if (tabDirection.current === -1 && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)
          && (event.currentTarget.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING)
          && sortedEntries.length) {
          tabDirection.current = 0;
          focusEntry(sortedEntries.length - 1, 1);
        }
      }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const button = event.target as HTMLElement;
        const row = button.closest<HTMLElement>("[data-entry-index]");
        if (!row) {
          if (!event.shiftKey && button.classList.contains("is-numeric") && sortedEntries.length) {
            event.preventDefault(); focusEntry(0, 0);
          }
          return;
        }
        const index = Number(row.dataset.entryIndex);
        const action = button.classList.contains("book-inline-entry-delete") ? 1 : 0;
        const next = index * 2 + action + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < sortedEntries.length * 2) {
          event.preventDefault(); focusEntry(Math.floor(next / 2), next % 2);
        }
      }}>
      <div className="book-inline-entry-row book-inline-entry-header" role="row">
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("position")}>번호{sortMark("position")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("term")}>표현{sortMark("term")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("reading")}>발음{sortMark("reading")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("meaning")}>뜻{sortMark("meaning")}</button>
        <button type="button" className="ghost book-inline-entry-sort is-numeric" onClick={() => toggleSort("attempts")}>{sortMarkBefore("attempts")}누적 시도</button>
        <span className="book-inline-entry-settings-head">편집</span>
        <span className="book-inline-entry-delete-head">삭제</span>
      </div>
      {loading ? <div className="book-inline-entry-empty">불러오는 중</div>
        : filteredEntries.length === 0 ? <div className="book-inline-entry-empty">{entries.length === 0 ? "아직 표현이 없어요" : "검색 결과가 없어요"}</div>
          : <>
          {visibleIndices.map((index, offset) => {
            const entry = sortedEntries[index];
            const gap = index - (offset === 0 ? 0 : visibleIndices[offset - 1] + 1);
            return <Fragment key={entry.id}>
            {gap > 0 && <div aria-hidden="true" style={{ height: gap * rowHeight }} />}
            <div className="book-inline-entry-row" role="row" data-entry-index={index} data-entry-id={entry.id} aria-rowindex={index + 2}>
            <span className="book-inline-entry-number" onMouseEnter={(event) => updateOverflowTooltip(event.currentTarget, (entry.position + 1).toLocaleString("ko-KR"))}>{(entry.position + 1).toLocaleString("ko-KR")}</span>
            <strong onMouseEnter={(event) => updateOverflowTooltip(event.currentTarget, entry.term)}>{entry.term}</strong>
            <span className="book-inline-entry-reading" onMouseEnter={(event) => updateOverflowTooltip(event.currentTarget, entry.reading || "—")}>{entry.reading || "—"}</span>
            <span className="book-inline-entry-meaning" onMouseEnter={(event) => updateOverflowTooltip(event.currentTarget, entry.meanings.join(" / "))}>{entry.meanings.join(" / ")}</span>
            <span className="book-inline-entry-attempts" onMouseEnter={(event) => updateOverflowTooltip(event.currentTarget, `${entry.attempts.toLocaleString("ko-KR")}회`)}>{entry.attempts.toLocaleString("ko-KR")}회</span>
            <button type="button" className="book-inline-entry-settings" onClick={() => onEdit(entry)} aria-label={`${entry.term} 편집`} title="표현 편집">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 20h4.2L19 9.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z" />
                <path d="m13.8 6 4.2 4.2" />
              </svg>
            </button>
            <button type="button" className="book-inline-entry-delete" onClick={() => onDelete(entry)} aria-label={`${entry.term} 삭제`} title="표현 삭제">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.5 6.5h15" />
                <path d="M9 6.5V4.75A1.75 1.75 0 0 1 10.75 3h2.5A1.75 1.75 0 0 1 15 4.75V6.5" />
                <path d="m6.75 6.5.72 12.05A2.25 2.25 0 0 0 9.71 20.5h4.58a2.25 2.25 0 0 0 2.24-1.95l.72-12.05" />
                <path d="M10 10.5v6M14 10.5v6" />
              </svg>
            </button>
          </div></Fragment>;
          })}
          <div aria-hidden="true" style={{ height: (sortedEntries.length - (visibleIndices.at(-1) ?? -1) - 1) * rowHeight }} />
          </>}
    </div>
  </section>;
}

