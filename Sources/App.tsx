import { FormEvent, forwardRef, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import HTMLFlipBook from "react-pageflip";
import { Canvas } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "./lib/api";
import { prepareBookClosing } from "./lib/bookClosing";
import { parseEntryText } from "./lib/importParser";
import { BookStudy } from "./BookStudy";
import { loadJapaneseImeRuntime } from "./lib/japaneseIme";
import type { SubmitResult } from "./lib/types";
import type { AudioSettings, DeckSummary, EntryListRecord, EntryRecord, LibraryStats, SemanticRuntimeStatus, StageScheduleSummary, StorageSettings, StudyMode, VoicevoxRuntimeStatus } from "./lib/types";

type View = "decks" | "editor" | "settings";

const BOOK_FLUTTER_LEAF_COUNT = 8;
const BOOK_CONTENT_PAGE = BOOK_FLUTTER_LEAF_COUNT + 1;
const BOOK_STUDY_FLUTTER_LEAF_COUNT = 8;
const BOOK_STUDY_PAGE = BOOK_CONTENT_PAGE + 2 + BOOK_STUDY_FLUTTER_LEAF_COUNT;
const BOOK_COVER_HOLD_MS = 380;
const OPEN_BOOK_BASE_WIDTH = 1240;
const OPEN_BOOK_TARGET_WIDTH = 1400;
const OPEN_BOOK_SCALE = OPEN_BOOK_TARGET_WIDTH / OPEN_BOOK_BASE_WIDTH;
const OPEN_BOOK_PAGE_MAX_WIDTH = OPEN_BOOK_TARGET_WIDTH / 2;
const OPEN_BOOK_PAGE_MAX_HEIGHT = Math.ceil(OPEN_BOOK_PAGE_MAX_WIDTH * (690 / 590));
const MAX_DECK_NAME_LENGTH = 20;
const IMPORT_PREVIEW_LIMIT = 100;
const STUDY_MODE_LABELS: Record<StudyMode, string> = {
  reading: "Reading",
  listening: "Listening",
  writing: "Writing",
};
const BOOK_STUDY_NAVIGATION_LOCK_CLASS = "tanren-book-study-navigation-lock";

function setBookStudyNavigationLocked(locked: boolean) {
  document.documentElement.classList.toggle(BOOK_STUDY_NAVIGATION_LOCK_CLASS, locked);
}

const VIEW_LABELS: Record<Exclude<View, "decks">, string> = {
  editor: "책 편집",
  settings: "설정",
};

function runtimePhaseLabel(phase: string, downloadProgress?: number | null) {
  switch (phase) {
    case "starting": return "준비 중이에요";
    case "downloading": return downloadProgress == null ? "필요한 파일을 받고 있어요" : `${downloadProgress}%  ·  필요한 파일을 받고 있어요`;
    case "loading": return "불러오고 있어요";
    case "ready": return "사용할 수 있어요";
    default: return "지금은 사용할 수 없어요";
  }
}

function runtimePhaseIsLoading(phase?: string) {
  return !phase || phase === "starting" || phase === "downloading" || phase === "loading";
}

function formatStudyRangeLabel(label?: string | null, separator = " - ") {
  if (!label) return "—";
  const core = label.replace(" · cumulative", "");
  const match = /^(\d+)~(\d+)$/.exec(core);
  if (!match) return core;
  const start = Number(match[1]) + 1;
  const end = Number(match[2]) + 1;
  return `${start.toLocaleString("ko-KR")}${separator}${end.toLocaleString("ko-KR")}`;
}

function OpenBook3D({ openingStarted, onReady }: { openingStarted: boolean; onReady: () => void }) {
  return <div className="book-3d book-3d-open" aria-hidden="true">
    <Canvas
      orthographic
      camera={{ position: [0, 0.1, 10], zoom: 156 * OPEN_BOOK_SCALE }}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true }}
      resize={{ scroll: false }}
      onCreated={() => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(onReady);
        });
      }}
    >
      <ambientLight intensity={0.92} />
      <directionalLight position={[2.4, 5.8, 7.5]} intensity={1.55} />
      <directionalLight position={[-4, -1, 4]} intensity={0.38} />
      <group rotation={[-0.065, 0, 0]} position={[0, 0.01432, -0.12]} scale={[1.14836, 1.05, 1]}>
        {openingStarted && <group position={[-1.76, 0, 0]} rotation={[0, -0.085, -0.008]}>
          <RoundedBox args={[3.36, 4.46, 0.27]} radius={0.04} smoothness={4} position={[-0.01, -0.005, -0.09]}><meshStandardMaterial color="#b1a68f" roughness={0.94} /></RoundedBox>
          <RoundedBox args={[0.075, 4.18, 0.20]} radius={0.018} smoothness={3} position={[-1.64, 0.01, 0.015]}><meshStandardMaterial color="#d0c4aa" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.10, 0.075, 0.20]} radius={0.018} smoothness={3} position={[-0.03, -2.16, 0.015]}><meshStandardMaterial color="#c7baa0" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.24, 4.31, 0.06]} radius={0.025} smoothness={3} position={[0.05, 0, 0.105]}><meshStandardMaterial color="#151719" roughness={0.88} /></RoundedBox>
        </group>}
        <group position={[1.76, 0, 0]} rotation={[0, 0.085, 0.008]}>
          <RoundedBox args={[3.36, 4.46, 0.27]} radius={0.04} smoothness={4} position={[0.01, -0.005, -0.09]}><meshStandardMaterial color="#b1a68f" roughness={0.94} /></RoundedBox>
          <RoundedBox args={[0.075, 4.18, 0.20]} radius={0.018} smoothness={3} position={[1.64, 0.01, 0.015]}><meshStandardMaterial color="#d0c4aa" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.10, 0.075, 0.20]} radius={0.018} smoothness={3} position={[0.03, -2.16, 0.015]}><meshStandardMaterial color="#c7baa0" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.24, 4.31, 0.06]} radius={0.025} smoothness={3} position={[-0.05, 0, 0.105]}><meshStandardMaterial color="#131517" roughness={0.88} /></RoundedBox>
        </group>
        {openingStarted && <>
          <RoundedBox args={[0.24, 4.36, 0.30]} radius={0.07} smoothness={4} position={[0, -0.01, -0.15]}><meshStandardMaterial color="#06080a" roughness={0.8} /></RoundedBox>
          <RoundedBox args={[0.07, 4.16, 0.13]} radius={0.02} smoothness={3} position={[-0.10, 0, 0.045]} rotation={[0, -0.17, 0]}><meshStandardMaterial color="#9f947f" roughness={0.95} /></RoundedBox>
          <RoundedBox args={[0.07, 4.16, 0.13]} radius={0.02} smoothness={3} position={[0.10, 0, 0.045]} rotation={[0, 0.17, 0]}><meshStandardMaterial color="#9f947f" roughness={0.95} /></RoundedBox>
        </>}
      </group>
    </Canvas>
  </div>;
}

const FlipPage = forwardRef<HTMLDivElement, { className?: string; children: React.ReactNode; hard?: boolean }>(({ className = "", children, hard = false }, ref) => (
  <div ref={ref} className={`book-flip-page ${className}`} data-density={hard ? "hard" : "soft"}>
    {children}
  </div>
));
FlipPage.displayName = "FlipPage";

function parseMeaningInput(value: string) {
  return value.split(/[\/／,，;；]/).map((meaning) => meaning.trim()).filter(Boolean);
}

function DeckEntryInput({ value, onChange, compact = false }: { value: string; onChange: (value: string) => void; compact?: boolean }) {
  return <textarea
    className={`bulk-input deck-entry-input ${compact ? "is-compact" : ""}`}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    placeholder={"見据える\t내다보다 / 전망하다\n躊躇う\t망설이다"}
    spellCheck={false}
  />;
}

function App() {
  const [view, setView] = useState<View>("decks");
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [selected, setSelected] = useState<DeckSummary | null>(null);
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);
  const [statsDeckId, setStatsDeckId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticRuntimeStatus | null>(null);
  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxRuntimeStatus | null>(null);
  const [initialRuntimeReady, setInitialRuntimeReady] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ volume: 1, playback_rate: 1 });
  const homeScrollRef = useRef<HTMLDivElement>(null);
  const homeWheelLockRef = useRef(false);
  const homeShelfWheelAtRef = useRef(0);
  const homeShelfScrollTargetRef = useRef<number | null>(null);
  const homeShelfScrollFrameRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      setDecks(await api.listDecks());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => void refresh(), []);
  useEffect(() => { void loadJapaneseImeRuntime().catch(() => undefined); }, []);
  useEffect(() => { void api.audioSettings().then(setAudioSettings); }, []);
  useEffect(() => {
    if (view !== "decks") return;
    let active = true;
    setLibraryStats(null);
    void api.libraryStats(statsDeckId ?? undefined)
      .then((nextStats) => { if (active) setLibraryStats(nextStats); })
      .catch(() => { if (active) setLibraryStats(null); });
    return () => { active = false; };
  }, [view, decks, statsDeckId]);
  useEffect(() => {
    if (view !== "decks") return;
    const scroller = homeScrollRef.current;
    if (!scroller) return;

    let unlockTimer: number | null = null;
    let bookRangeScrollTarget: number | null = null;
    let bookRangeScrollFrame: number | null = null;
    let bookRangeScrollElement: HTMLElement | null = null;
    let bookRangeWheelAt = 0;
    const normalizeWheelDelta = (event: WheelEvent, viewportHeight: number) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * viewportHeight;
      return event.deltaY;
    };

    const settleShelfAt = (shelf: HTMLElement, scrollTop: number) => {
      if (homeShelfScrollFrameRef.current !== null) {
        cancelAnimationFrame(homeShelfScrollFrameRef.current);
        homeShelfScrollFrameRef.current = null;
      }
      shelf.scrollTop = scrollTop;
      homeShelfScrollTargetRef.current = scrollTop;
    };

    const smoothShelfScrollBy = (shelf: HTMLElement, deltaY: number) => {
      const maxScrollTop = Math.max(0, shelf.scrollHeight - shelf.clientHeight);
      const base = homeShelfScrollFrameRef.current === null || homeShelfScrollTargetRef.current === null
        ? shelf.scrollTop
        : homeShelfScrollTargetRef.current;
      let nextTarget = Math.max(0, Math.min(maxScrollTop, base + deltaY));
      const edgeSnapDistance = Math.max(32, Math.abs(deltaY) * 1.25);
      if (deltaY < 0 && nextTarget <= edgeSnapDistance) nextTarget = 0;
      if (deltaY > 0 && maxScrollTop - nextTarget <= edgeSnapDistance) nextTarget = maxScrollTop;
      homeShelfScrollTargetRef.current = nextTarget;

      if (homeShelfScrollFrameRef.current !== null) return;

      const animate = () => {
        const target = homeShelfScrollTargetRef.current ?? shelf.scrollTop;
        const diff = target - shelf.scrollTop;
        if (Math.abs(diff) < 0.5) {
          settleShelfAt(shelf, target);
          return;
        }
        const previousScrollTop = shelf.scrollTop;
        shelf.scrollTop = previousScrollTop + diff * 0.2;
        if (shelf.scrollTop === previousScrollTop) {
          settleShelfAt(shelf, target);
          return;
        }
        homeShelfScrollFrameRef.current = requestAnimationFrame(animate);
      };

      homeShelfScrollFrameRef.current = requestAnimationFrame(animate);
    };

    const settleBookRangeAt = (rangeScroller: HTMLElement, scrollTop: number) => {
      if (bookRangeScrollFrame !== null) {
        cancelAnimationFrame(bookRangeScrollFrame);
        bookRangeScrollFrame = null;
      }
      rangeScroller.scrollTop = scrollTop;
      bookRangeScrollTarget = scrollTop;
      bookRangeScrollElement = rangeScroller;
    };

    const smoothBookRangeScrollBy = (rangeScroller: HTMLElement, deltaY: number) => {
      if (bookRangeScrollElement !== rangeScroller) {
        if (bookRangeScrollFrame !== null) cancelAnimationFrame(bookRangeScrollFrame);
        bookRangeScrollFrame = null;
        bookRangeScrollTarget = rangeScroller.scrollTop;
        bookRangeScrollElement = rangeScroller;
      }

      const maxScrollTop = Math.max(0, rangeScroller.scrollHeight - rangeScroller.clientHeight);
      const base = bookRangeScrollFrame === null || bookRangeScrollTarget === null
        ? rangeScroller.scrollTop
        : bookRangeScrollTarget;
      let nextTarget = Math.max(0, Math.min(maxScrollTop, base + deltaY));
      const edgeSnapDistance = Math.max(32, Math.abs(deltaY) * 1.25);
      if (deltaY < 0 && nextTarget <= edgeSnapDistance) nextTarget = 0;
      if (deltaY > 0 && maxScrollTop - nextTarget <= edgeSnapDistance) nextTarget = maxScrollTop;
      bookRangeScrollTarget = nextTarget;

      if (bookRangeScrollFrame !== null) return;

      const animate = () => {
        const target = bookRangeScrollTarget ?? rangeScroller.scrollTop;
        const diff = target - rangeScroller.scrollTop;
        if (Math.abs(diff) < 0.5) {
          settleBookRangeAt(rangeScroller, target);
          return;
        }
        const previousScrollTop = rangeScroller.scrollTop;
        rangeScroller.scrollTop = previousScrollTop + diff * 0.2;
        if (rangeScroller.scrollTop === previousScrollTop) {
          settleBookRangeAt(rangeScroller, target);
          return;
        }
        bookRangeScrollFrame = requestAnimationFrame(animate);
      };

      bookRangeScrollFrame = requestAnimationFrame(animate);
    };

    const shelfForSync = scroller.querySelector<HTMLElement>(".book-shelf");
    const syncShelfScrollTarget = () => {
      if (!shelfForSync || homeShelfScrollFrameRef.current !== null) return;
      homeShelfScrollTargetRef.current = shelfForSync.scrollTop;
    };
    shelfForSync?.addEventListener("scroll", syncShelfScrollTarget, { passive: true });

    const unlock = () => {
      homeWheelLockRef.current = false;
      if (unlockTimer !== null) window.clearTimeout(unlockTimer);
      unlockTimer = null;
    };

    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;

      // Keep the library pinned while the blank study pages are active so a
      // wheel gesture cannot hand off to stats/settings snap navigation.
      if (
        document.documentElement.classList.contains(BOOK_STUDY_NAVIGATION_LOCK_CLASS)
        || scroller.querySelector(".open-book-stage.is-study-transitioning, .open-book-stage.is-book-study")
      ) {
        if (target?.closest(".learning-body")) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const librarySection = scroller.querySelector<HTMLElement>(".home-library-section");
        if (librarySection && Math.abs(scroller.scrollTop - librarySection.offsetTop) > 1) {
          scroller.scrollTop = librarySection.offsetTop;
        }
        return;
      }

      const importPreviewScroller = target?.closest<HTMLElement>(".book-entry-import-body");

      const nestedEntryScroller = target?.closest<HTMLElement>(".book-inline-entry-list, .book-entry-list");
      const nestedEntryDelta = nestedEntryScroller
        ? normalizeWheelDelta(event, nestedEntryScroller.clientHeight)
        : 0;
      const nestedEntryCanScroll = Boolean(nestedEntryScroller) && (
        (nestedEntryDelta < 0 && nestedEntryScroller!.scrollTop > 2)
        || (nestedEntryDelta > 0 && nestedEntryScroller!.scrollHeight - nestedEntryScroller!.clientHeight - nestedEntryScroller!.scrollTop > 2)
      );
      if (nestedEntryCanScroll) return;
      const leavingInlineEntryList = Boolean(nestedEntryScroller?.matches(".book-inline-entry-list")) || Boolean(importPreviewScroller);

      // Ctrl + wheel is reserved for growth-plot zoom. Plain wheel input
      // should keep navigating between the home sections even over the plot.
      if (event.ctrlKey && target?.closest(".stats-growth-chart")) {
        event.preventDefault();
        return;
      }

      if (homeWheelLockRef.current) {
        event.preventDefault();
        return;
      }

      if (target?.closest(".deck-create-backdrop")) return;

      const bookRangeScroller = target?.closest<HTMLElement>(".book-range-scroll");
      if (bookRangeScroller && bookRangeScroller.scrollHeight > bookRangeScroller.clientHeight) {
        const deltaY = normalizeWheelDelta(event, bookRangeScroller.clientHeight);
        const now = performance.now();
        const wheelGapMs = now - bookRangeWheelAt;
        const maxScrollTop = Math.max(0, bookRangeScroller.scrollHeight - bookRangeScroller.clientHeight);
        const effectiveScrollTop = bookRangeScrollElement === bookRangeScroller && bookRangeScrollTarget !== null
          ? bookRangeScrollTarget
          : bookRangeScroller.scrollTop;
        const canScrollUp = deltaY < 0 && effectiveScrollTop > 2;
        const canScrollDown = deltaY > 0 && maxScrollTop - effectiveScrollTop > 2;
        const settlingAtEdge = bookRangeScrollElement === bookRangeScroller
          && bookRangeScrollFrame !== null
          && ((deltaY < 0 && effectiveScrollTop <= 2) || (deltaY > 0 && maxScrollTop - effectiveScrollTop <= 2));
        if (canScrollUp || canScrollDown || settlingAtEdge) {
          event.preventDefault();
          smoothBookRangeScrollBy(bookRangeScroller, deltaY);
          bookRangeWheelAt = now;
          return;
        }
        const atEdge = (deltaY < 0 && effectiveScrollTop <= 2)
          || (deltaY > 0 && maxScrollTop - effectiveScrollTop <= 2);
        if (atEdge && wheelGapMs < 240) {
          event.preventDefault();
          bookRangeWheelAt = now;
          return;
        }
        bookRangeWheelAt = now;
      }

      const statsScroller = target?.closest<HTMLElement>(".home-stats-section > .stats-dashboard");
      if (statsScroller && statsScroller.scrollHeight > statsScroller.clientHeight) {
        const deltaY = normalizeWheelDelta(event, statsScroller.clientHeight);
        const canScrollUp = deltaY < 0 && statsScroller.scrollTop > 2;
        const canScrollDown = deltaY > 0 && statsScroller.scrollHeight - statsScroller.clientHeight - statsScroller.scrollTop > 2;
        if (canScrollUp || canScrollDown) return;
      }

      const sections = Array.from(scroller.querySelectorAll<HTMLElement>(".home-snap-section"));
      if (sections.length === 0) return;

      let currentIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      sections.forEach((section, index) => {
        const distance = Math.abs(section.offsetTop - scroller.scrollTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          currentIndex = index;
        }
      });

      if (currentIndex === 0 && !leavingInlineEntryList) {
        const shelf = scroller.querySelector<HTMLElement>(".book-shelf");
        if (shelf) {
          const deltaY = normalizeWheelDelta(event, shelf.clientHeight);
          if (Math.abs(deltaY) < 0.5) return;
          const now = performance.now();
          const wheelGapMs = now - homeShelfWheelAtRef.current;
          const maxScrollTop = Math.max(0, shelf.scrollHeight - shelf.clientHeight);
          const atBottom = maxScrollTop - shelf.scrollTop <= 2;
          const atTop = shelf.scrollTop <= 2;

          if (deltaY < 0 && atTop) {
            event.preventDefault();
            settleShelfAt(shelf, 0);
            if (scroller.scrollTop > 0) scroller.scrollTop = sections[0].offsetTop;
            homeShelfWheelAtRef.current = now;
            return;
          }

          if (deltaY > 0 && !atBottom) {
            event.preventDefault();
            smoothShelfScrollBy(shelf, deltaY);
            homeShelfWheelAtRef.current = now;
            return;
          }
          if (deltaY < 0 && !atTop) {
            event.preventDefault();
            smoothShelfScrollBy(shelf, deltaY);
            homeShelfWheelAtRef.current = now;
            return;
          }

          // Reaching the shelf edge must not immediately chain into another
          // section while the same wheel/trackpad gesture is still coasting.
          // Only a fresh wheel gesture after the shelf has settled may leave it.
          if (((deltaY > 0 && atBottom) || (deltaY < 0 && atTop)) && wheelGapMs < 240) {
            event.preventDefault();
            homeShelfWheelAtRef.current = now;
            return;
          }

          homeShelfWheelAtRef.current = now;
        }
      }

      const deltaY = normalizeWheelDelta(event, scroller.clientHeight);
      if (Math.abs(deltaY) < 0.5) return;
      const direction = deltaY > 0 ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(sections.length - 1, currentIndex + direction));
      event.preventDefault();
      if (nextIndex === currentIndex) return;

      homeWheelLockRef.current = true;
      scroller.scrollTo({ top: sections[nextIndex].offsetTop, behavior: "smooth" });
      unlockTimer = window.setTimeout(unlock, 420);
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.repeat) return;
      if (
        document.documentElement.classList.contains(BOOK_STUDY_NAVIGATION_LOCK_CLASS)
        || scroller.querySelector(".open-book-stage.is-study-transitioning, .open-book-stage.is-book-study")
      ) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (target?.closest(".deck-create-backdrop, .open-book-stage")) return;

      const sections = Array.from(scroller.querySelectorAll<HTMLElement>(".home-snap-section"));
      if (sections.length === 0) return;

      let currentIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      sections.forEach((section, index) => {
        const distance = Math.abs(section.offsetTop - scroller.scrollTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          currentIndex = index;
        }
      });

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(sections.length - 1, currentIndex + direction));
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      scroller.scrollTo({ top: sections[nextIndex].offsetTop, behavior: "smooth" });
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      shelfForSync?.removeEventListener("scroll", syncShelfScrollTarget);
      if (homeShelfScrollFrameRef.current !== null) {
        cancelAnimationFrame(homeShelfScrollFrameRef.current);
        homeShelfScrollFrameRef.current = null;
      }
      if (bookRangeScrollFrame !== null) cancelAnimationFrame(bookRangeScrollFrame);
      bookRangeScrollFrame = null;
      bookRangeScrollTarget = null;
      bookRangeScrollElement = null;
      homeShelfScrollTargetRef.current = null;
      unlock();
    };
  }, [view]);
  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    window.addEventListener("contextmenu", blockContextMenu, true);
    return () => {
      window.removeEventListener("contextmenu", blockContextMenu, true);
    };
  }, []);
  useEffect(() => {
    const update = () => {
      void api.semanticStatus().then(setSemanticStatus).catch(() => undefined);
      void api.voicevoxStatus().then(setVoicevoxStatus).catch(() => undefined);
    };
    update();
    const interval = window.setInterval(update, 2000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (initialRuntimeReady || !semanticStatus || !voicevoxStatus) return;
    if (!runtimePhaseIsLoading(semanticStatus.phase) && !runtimePhaseIsLoading(voicevoxStatus.phase)) {
      setInitialRuntimeReady(true);
    }
  }, [initialRuntimeReady, semanticStatus, voicevoxStatus]);
  useEffect(() => {
    if (initialRuntimeReady) return;
    const blockKeyboard = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", blockKeyboard, true);
    window.addEventListener("keyup", blockKeyboard, true);
    return () => {
      window.removeEventListener("keydown", blockKeyboard, true);
      window.removeEventListener("keyup", blockKeyboard, true);
    };
  }, [initialRuntimeReady]);

  const scrollHomeSection = (index: number) => {
    const scroller = homeScrollRef.current;
    if (!scroller) return;
    const sections = Array.from(scroller.querySelectorAll<HTMLElement>(".home-snap-section"));
    const target = sections[index];
    if (!target) return;
    scroller.scrollTo({ top: target.offsetTop, behavior: "smooth" });
  };

  const openDecks = async () => {
    try {
      setStatsDeckId(null);
      await refresh();
      setView("decks");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <main className={`app-shell ${view === "decks" ? "home-shell" : ""}`}>
      {view !== "decks" && <header className="topbar">
        <button className="brand" onClick={() => void openDecks()}>
          <span className="brand-mark">鍛</span>
          <strong>TANREN</strong>
        </button>
        <div className="topbar-context">{view === "editor" || view === "settings" ? VIEW_LABELS[view] : ""}</div>
        <div className="topbar-actions">
          <button className="ghost" onClick={() => void openDecks()}>← 책장</button>
        </div>
      </header>}

      {error && <div className="error">{error}</div>}

      {view === "decks" && (
        <div ref={homeScrollRef} className="library-frame home-scroll">
          <section className="home-snap-section home-library-section">
            <button
              type="button"
              className="home-guide-arrow home-guide-arrow--down"
              aria-label="통계로 이동"
              onClick={() => scrollHomeSection(1)}
            />
            <MemoDeckList
              decks={decks}
              onRefresh={refresh}
              onEdit={(d) => { setSelected(d); setView("editor"); }}
              onOpenedDeckChange={setStatsDeckId}
              onRequestHomeSection={scrollHomeSection}
              audioSettings={audioSettings}
            />
          </section>
          <section className="home-snap-section home-stats-section">
            <button
              type="button"
              className="home-guide-arrow home-guide-arrow--up"
              aria-label="책장으로 이동"
              onClick={() => scrollHomeSection(0)}
            />
            <LibraryStatsView
              stats={libraryStats}
              deck={statsDeckId ? decks.find((deck) => deck.id === statsDeckId) ?? null : null}
            />
            <button
              type="button"
              className="home-guide-arrow home-guide-arrow--down"
              aria-label="설정으로 이동"
              onClick={() => scrollHomeSection(2)}
            />
          </section>
          <section className="home-snap-section home-settings-section">
            <button
              type="button"
              className="home-guide-arrow home-guide-arrow--up"
              aria-label="통계로 이동"
              onClick={() => scrollHomeSection(1)}
            />
            <SettingsView
              voicevoxStatus={voicevoxStatus}
              audioSettings={audioSettings}
              onAudioSettingsChange={setAudioSettings}
              onDataRestored={async () => {
                await refresh();
                setAudioSettings(await api.audioSettings());
              }}
            />
          </section>
        </div>
      )}
      {view === "editor" && selected && <DeckEditor deck={selected} onDone={refresh} />}
      {view === "settings" && <SettingsView
        voicevoxStatus={voicevoxStatus}
        audioSettings={audioSettings}
        onAudioSettingsChange={setAudioSettings}
        onDataRestored={async () => {
          await refresh();
          setAudioSettings(await api.audioSettings());
        }}
      />}
      {!initialRuntimeReady && <div className="initial-loading-overlay" role="dialog" aria-modal="true" aria-labelledby="initial-loading-title">
        <div className="initial-loading-content">
          <span className="initial-loading-spinner" aria-hidden="true" />
          <h2 id="initial-loading-title">TANREN을 준비하고 있어요</h2>
          <div className="initial-loading-status" aria-live="polite">
            <p><span>의미 모델</span><strong>{runtimePhaseLabel(semanticStatus?.phase ?? "starting", semanticStatus?.download_progress)}</strong></p>
            <p><span>음성 모델</span><strong>{runtimePhaseLabel(voicevoxStatus?.phase ?? "starting", voicevoxStatus?.download_progress)}</strong></p>
          </div>
        </div>
      </div>}
    </main>
  );
}

function SettingsView({ voicevoxStatus, audioSettings, onAudioSettingsChange, onDataRestored }: {
  voicevoxStatus: VoicevoxRuntimeStatus | null;
  audioSettings: AudioSettings;
  onAudioSettingsChange: (settings: AudioSettings) => void;
  onDataRestored: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const audioWriteTail = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void api.storageSettings().then((value) => {
      setSettings(value);
      setPath(value.selected_path ?? value.active_path);
    });
  }, []);

  const browse = async () => {
    const selected = await api.pickStorageDirectory();
    if (selected) setPath(selected);
  };

  const save = async () => {
    const value = await api.setStorageDirectory(path.trim() || null);
    setSettings(value);
    setPath(value.selected_path ?? value.default_path);
    setMessage("");
  };

  const reset = async () => {
    const value = await api.setStorageDirectory(null);
    setSettings(value);
    setPath(value.default_path);
    setMessage("");
  };

  const updateAudio = (next: AudioSettings) => {
    onAudioSettingsChange(next);
    audioWriteTail.current = audioWriteTail.current
      .then(async () => { await api.setAudioSettings(next); })
      .catch(() => { });
  };

  const exportBackup = async () => {
    const exported = await api.exportBackup();
    if (exported) setBackupMessage("백업 파일을 내보냈어요.");
  };

  const importBackup = async () => {
    if (!window.confirm("현재 데이터를 백업 파일의 내용으로 바꿀까요?")) return;
    const imported = await api.importBackup();
    if (!imported) return;
    const restoredStorage = await api.storageSettings();
    setSettings(restoredStorage);
    setPath(restoredStorage.selected_path ?? restoredStorage.active_path);
    await onDataRestored();
    setBackupMessage("백업 파일을 가져왔어요.");
  };

  return <section className="content settings-dashboard">
    <div className="settings-grid">
      <article className="settings-panel">
        <header><span>01</span><h2>데이터</h2></header>
        <p className="settings-panel-help">저장 위치와 백업을 관리해요.</p>
        <div className="settings-data-body">
          <label htmlFor="semantic-storage">저장 위치</label>
          <div className="settings-path-row">
            <input
              id="semantic-storage"
              className="home-create-input settings-storage-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={settings?.default_path ?? ""}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button className="settings-action-button" onClick={() => void browse()}>선택</button>
          </div>
          <div className="settings-card-actions">
            <button className="settings-action-button" onClick={() => void save()}>저장</button>
            <button className="settings-action-button" onClick={() => void reset()}>기본값</button>
          </div>
          {message && <p className="success">{message}</p>}
          {settings?.restart_required && <p className="setting-warning">재시작하면 새 위치가 적용돼요.</p>}

          <div className="settings-backup-section">
            <strong>백업</strong>
            <p>책, 학습 표현, 학습 기록, 통계와 설정을 하나의 <code>.tanren</code> 파일로 저장해요.</p>
            <div className="settings-backup-actions">
              <button className="settings-action-button" onClick={() => void exportBackup()}>내보내기</button>
              <button className="settings-action-button" onClick={() => void importBackup()}>가져오기</button>
            </div>
            {backupMessage && <p className="setting-warning">{backupMessage}</p>}
          </div>
        </div>
      </article>

      <article className="settings-panel">
        <header><span>02</span><h2>음성</h2></header>
        <p className="settings-panel-help">학습 중 재생되는 음성을 조절해요.</p>
        <div className="settings-control-list">
          <label className="settings-range-row">
            <div><strong>음량</strong><span>{Math.round(audioSettings.volume * 100)}%</span></div>
            <input type="range" min="0" max="1" step="0.05" value={audioSettings.volume} onChange={(event) => updateAudio({ ...audioSettings, volume: Number(event.target.value) })} />
          </label>
          <label className="settings-range-row">
            <div><strong>재생 속도</strong><span>{audioSettings.playback_rate.toFixed(1)}×</span></div>
            <input type="range" min="0.5" max="2" step="0.1" value={audioSettings.playback_rate} onChange={(event) => updateAudio({ ...audioSettings, playback_rate: Number(event.target.value) })} />
          </label>
        </div>
        {voicevoxStatus?.phase !== "ready" && voicevoxStatus && <p className="settings-runtime">음성 모델 · {runtimePhaseLabel(voicevoxStatus.phase, voicevoxStatus.download_progress)}{voicevoxStatus.error ? ` · ${voicevoxStatus.error}` : ""}</p>}
      </article>
    </div>
  </section>;
}

type BookEntrySortKey = "position" | "term" | "reading" | "meaning" | "attempts";

function BookInlineEntryManager({ deckId, onAdd, onImport, onEdit, onDelete }: {
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
  const filteredEntries = query
    ? entries.filter((entry) => entry.term.toLocaleLowerCase().includes(query)
      || (entry.reading ?? "").toLocaleLowerCase().includes(query)
      || entry.meanings.some((meaning) => meaning.toLocaleLowerCase().includes(query)))
    : entries;
  const entryNumbers = new Map(entries.map((entry) => [entry.id, entry.position + 1]));
  const sortedEntries = [...filteredEntries].sort((left, right) => {
    let result = 0;
    if (sort.key === "position") result = left.position - right.position;
    else if (sort.key === "attempts") result = left.attempts - right.attempts;
    else if (sort.key === "term") result = left.term.localeCompare(right.term, undefined, { numeric: true, sensitivity: "base" });
    else if (sort.key === "reading") result = (left.reading ?? "").localeCompare(right.reading ?? "", undefined, { numeric: true, sensitivity: "base" });
    else result = left.meanings.join(" / ").localeCompare(right.meanings.join(" / "), undefined, { numeric: true, sensitivity: "base" });
    if (result === 0) result = left.position - right.position;
    return sort.direction === "asc" ? result : -result;
  });
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
    <div className={`book-inline-entry-list ${loading || filteredEntries.length === 0 ? "is-empty" : ""}`} ref={listRef}>
      <div className="book-inline-entry-row book-inline-entry-header" role="row">
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("position")}>번호{sortMark("position")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("term")}>표현{sortMark("term")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("reading")}>발음{sortMark("reading")}</button>
        <button type="button" className="ghost book-inline-entry-sort" onClick={() => toggleSort("meaning")}>뜻{sortMark("meaning")}</button>
        <button type="button" className="ghost book-inline-entry-sort is-numeric" onClick={() => toggleSort("attempts")}>{sortMarkBefore("attempts")}시도</button>
        <span className="book-inline-entry-settings-head">편집</span>
        <span className="book-inline-entry-delete-head">삭제</span>
      </div>
      {loading ? <div className="book-inline-entry-empty">불러오는 중</div>
        : filteredEntries.length === 0 ? <div className="book-inline-entry-empty">{entries.length === 0 ? "아직 표현이 없어요." : "검색 결과가 없어요."}</div>
          : sortedEntries.map((entry) => <div className="book-inline-entry-row" key={entry.id} role="row">
            <span className="book-inline-entry-number">{(entryNumbers.get(entry.id) ?? 0).toLocaleString("ko-KR")}</span>
            <strong>{entry.term}</strong>
            <span className="book-inline-entry-reading">{entry.reading || "—"}</span>
            <span className="book-inline-entry-meaning">{entry.meanings.join(" / ")}</span>
            <span className="book-inline-entry-attempts">{entry.attempts.toLocaleString("ko-KR")}회</span>
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
          </div>)}
    </div>
  </section>;
}

const BookTitleEditor = memo(function BookTitleEditor({ deck, onRefresh }: {
  deck: DeckSummary;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(deck.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const beginRename = () => {
    setValue(deck.name);
    setEditing(true);
  };

  useLayoutEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setValue(deck.name);
  }, [deck.name, editing]);

  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setValue(deck.name);
  };

  const save = async () => {
    if (saving) return;
    const nextName = value.trim();
    if (!nextName || nextName === deck.name) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await api.updateDeck(deck.id, nextName, deck.enabled_modes);
      setEditing(false);
      await onRefresh();
    } finally {
      setSaving(false);
    }
  };

  return editing ? <input
    ref={inputRef}
    className="book-title-rename-input"
    value={value}
    maxLength={MAX_DECK_NAME_LENGTH}
    aria-label="책 이름 변경"
    title="Enter 저장 · Esc 취소"
    autoComplete="off"
    onChange={(event) => setValue(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    }}
    onBlur={cancel}
    disabled={saving}
  /> : <h2
    className="book-title-editable"
    role="button"
    tabIndex={0}
    title="클릭해서 책 이름 변경"
    aria-label={`${deck.name} 책 이름 변경`}
    onClick={beginRename}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        beginRename();
      }
    }}
  >{deck.name}</h2>;
}, (previous, next) => (
  previous.deck.id === next.deck.id
  && previous.deck.name === next.deck.name
  && previous.deck.enabled_modes === next.deck.enabled_modes
));
BookTitleEditor.displayName = "BookTitleEditor";

const BookDeleteButton = memo(function BookDeleteButton({ deck, onDeleted }: {
  deck: DeckSummary;
  onDeleted: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (deleting) return;
    if (!window.confirm(`'${deck.name}' 책을 삭제할까요?\n책장에서 바로 사라져요.`)) return;
    setDeleting(true);
    try {
      await api.deleteDeck(deck.id);
      await onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  return <button
    type="button"
    className="book-delete-button ghost"
    aria-label="책 삭제"
    title="책 삭제"
    disabled={deleting}
    onClick={() => void remove()}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.75A1.75 1.75 0 0 1 10.75 3h2.5A1.75 1.75 0 0 1 15 4.75V6.5" />
      <path d="m6.75 6.5.72 12.05A2.25 2.25 0 0 0 9.71 20.5h4.58a2.25 2.25 0 0 0 2.24-1.95l.72-12.05" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  </button>;
}, (previous, next) => previous.deck.id === next.deck.id && previous.deck.name === next.deck.name);

function DeckList({ decks, onRefresh, onEdit, onOpenedDeckChange, onRequestHomeSection, audioSettings }: {
  decks: DeckSummary[];
  onRefresh: () => Promise<void>;
  onEdit: (d: DeckSummary) => void;
  onOpenedDeckChange: (deckId: string | null) => void;
  onRequestHomeSection: (index: number) => void;
  audioSettings: AudioSettings;
}) {
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [openedDeckId, setOpenedDeckId] = useState<string | null>(null);
  const [bookLayoutOpen, setBookLayoutOpen] = useState(false);
  const [bookOpenCycle, setBookOpenCycle] = useState(0);
  const [bookSettled, setBookSettled] = useState(false);
  const [bookOpeningStarted, setBookOpeningStarted] = useState(false);
  const [book3DReady, setBook3DReady] = useState(false);
  const [bookFlipReady, setBookFlipReady] = useState(false);
  const [bookClosing, setBookClosing] = useState(false);
  const [bookPanel, setBookPanel] = useState<"study" | "entries">("study");
  const [bookEntries, setBookEntries] = useState<EntryRecord[]>([]);
  const [bookPanelLoading, setBookPanelLoading] = useState(false);
  const [stageSchedules, setStageSchedules] = useState<Record<number, StageScheduleSummary>>({});
  const [bookStudyActive, setBookStudyActive] = useState(false);
  const [bookStudyExiting, setBookStudyExiting] = useState(false);
  const [studyResult, setStudyResult] = useState<SubmitResult | null>(null);
  const [bookStudyTransitioning, setBookStudyTransitioning] = useState(false);
  const [entrySearch, setEntrySearch] = useState("");
  const [entryDialog, setEntryDialog] = useState<"single" | "bulk" | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<EntryListRecord | null>(null);
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false);
  const [singleTerm, setSingleTerm] = useState("");
  const [singleMeaning, setSingleMeaning] = useState("");
  const [singleReading, setSingleReading] = useState("");
  const [originalEntry, setOriginalEntry] = useState<EntryRecord | null>(null);
  const [bulkText, setBulkText] = useState("");
  const [bulkFileName, setBulkFileName] = useState("");
  const [entryMessage, setEntryMessage] = useState("");
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryProcessing, setEntryProcessing] = useState<{
    total: number;
    completed: number;
    failed: number;
    runtimePhase: string;
  } | null>(null);
  const reduceMotion = useReducedMotion();
  const flipBookRef = useRef<any>(null);
  const bookFoldRef = useRef<HTMLDivElement>(null);
  const bookCoverBackgroundRef = useRef<string | undefined>(undefined);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const importPreviewRef = useRef<HTMLDivElement>(null);
  const skipDeleteConfirmDeckIdsRef = useRef(new Set<string>());
  const flutterTimerRef = useRef<number | null>(null);
  const studyFlutterTimerRef = useRef<number | null>(null);
  const flutteringRef = useRef(false);
  const activeBookSessionRef = useRef("");
  const flutterRetryRef = useRef(0);
  const flutterStartedSessionRef = useRef("");
  const bookOpeningStartedRef = useRef(false);
  const bookClosingRef = useRef(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.createDeck(name.trim());
      setName("");
      setCreateError(null);
      await onRefresh();
    } catch (error) {
      setCreateError(String(error));
      await onRefresh();
    }
  };
  const openedDeck = openedDeckId ? decks.find((deck) => deck.id === openedDeckId) ?? null : null;
  const filteredBookEntries = entrySearch.trim()
    ? bookEntries.filter((entry) => {
      const query = entrySearch.trim().toLocaleLowerCase();
      return entry.term.toLocaleLowerCase().includes(query)
        || (entry.reading ?? "").toLocaleLowerCase().includes(query)
        || entry.meanings.some((meaning) => meaning.toLocaleLowerCase().includes(query));
    })
    : bookEntries;
  const parsedBulkEntries = parseEntryText(bulkText);
  const bulkPreviewEntries = parsedBulkEntries.entries.slice(0, IMPORT_PREVIEW_LIMIT);
  const bulkPreviewHiddenCount = Math.max(0, parsedBulkEntries.entries.length - bulkPreviewEntries.length);
  const japaneseReadingInvalid = Boolean(openedDeck?.target_language === "ja-JP" && /\p{Script=Han}/u.test(singleReading));
  const bookSessionKey = openedDeck ? `${openedDeck.id}:${bookOpenCycle}` : "";
  const bookVisualReady = Boolean(openedDeck && (reduceMotion || (book3DReady && bookFlipReady)));
  const bookProgressRatio = (deck: DeckSummary) => deck.total_stage_count === 0
    ? 0
    : Math.min(1, deck.completed_stage_count / deck.total_stage_count);
  const bookProgressPercent = (deck: DeckSummary) => bookProgressRatio(deck) * 100;
  activeBookSessionRef.current = bookSessionKey;

  const waitForEntryProcessing = async (entryIds: string[]) => {
    if (entryIds.length === 0) return { total: 0, completed: 0, failed: 0, pending: 0, last_error: null, runtime_phase: "ready" };
    setEntryProcessing({ total: entryIds.length, completed: 0, failed: 0, runtimePhase: "ready" });
    try {
      for (;;) {
        const progress = await api.enrichmentProgress(entryIds);
        setEntryProcessing({
          total: progress.total,
          completed: progress.completed,
          failed: progress.failed,
          runtimePhase: progress.runtime_phase,
        });
        if (progress.pending === 0 || progress.runtime_phase === "unavailable") return progress;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    } finally {
      setEntryProcessing(null);
    }
  };

  useEffect(() => {
    if (!entryProcessing) return;
    const blockKeyboard = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockKeyboard, true);
    window.addEventListener("keyup", blockKeyboard, true);
    return () => {
      window.removeEventListener("keydown", blockKeyboard, true);
      window.removeEventListener("keyup", blockKeyboard, true);
    };
  }, [entryProcessing]);

  useEffect(() => {
    if (entryDialog !== "bulk") return;
    const scroller = importPreviewRef.current;
    if (!scroller) return;

    let scrollTarget = scroller.scrollTop;
    let scrollFrame: number | null = null;
    let lastWheelAt = 0;

    const settleAt = (scrollTop: number) => {
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
      }
      scroller.scrollTop = scrollTop;
      scrollTarget = scrollTop;
    };

    const smoothScrollBy = (deltaY: number) => {
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const base = scrollFrame === null ? scroller.scrollTop : scrollTarget;
      let nextTarget = Math.max(0, Math.min(maxScrollTop, base + deltaY));
      const edgeSnapDistance = Math.max(32, Math.abs(deltaY) * 1.25);
      if (deltaY < 0 && nextTarget <= edgeSnapDistance) nextTarget = 0;
      if (deltaY > 0 && maxScrollTop - nextTarget <= edgeSnapDistance) nextTarget = maxScrollTop;
      scrollTarget = nextTarget;

      if (scrollFrame !== null) return;

      const animate = () => {
        const diff = scrollTarget - scroller.scrollTop;
        if (Math.abs(diff) < 0.5) {
          settleAt(scrollTarget);
          return;
        }
        const previousScrollTop = scroller.scrollTop;
        scroller.scrollTop = previousScrollTop + diff * 0.2;
        if (scroller.scrollTop === previousScrollTop) {
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
          ? event.deltaY * scroller.clientHeight
          : event.deltaY;
      const now = performance.now();
      const wheelGapMs = now - lastWheelAt;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const effectiveScrollTop = scrollFrame === null ? scroller.scrollTop : scrollTarget;
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

      // Match the inline expression list edge handoff, but do it explicitly.
      // The preview lives inside a modal, so relying on wheel bubbling is not
      // reliable enough here. A fresh downward gesture after the pause moves
      // to the stats section; the same continuous gesture remains trapped.
      lastWheelAt = now;
      if (atEdge && deltaY > 0) onRequestHomeSection(1);
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  }, [entryDialog, bookPanel, onRequestHomeSection]);

  useEffect(() => {
    if (openedDeckId) void onRefresh();
  }, [openedDeckId, bookOpenCycle]);

  useEffect(() => {
    if (!openedDeck) {
      setStageSchedules({});
      return;
    }
    let disposed = false;
    const stages = Array.from({ length: openedDeck.total_stage_count }, (_, index) => index + 1);
    void Promise.all(stages.map(async (stage) => {
      try {
        return { stage, schedule: await api.stageSchedule(openedDeck.id, stage) };
      } catch {
        return null;
      }
    })).then((schedules) => {
      if (disposed) return;
      const next: Record<number, StageScheduleSummary> = {};
      for (const item of schedules) {
        if (item) next[item.stage] = item.schedule;
      }
      setStageSchedules(next);
      });
    return () => { disposed = true; };
  }, [openedDeck?.id, openedDeck?.entry_count, openedDeck?.current_stage, openedDeck?.total_stage_count, bookStudyActive]);

  const clearFlutterTimer = () => {
    if (flutterTimerRef.current !== null) window.clearTimeout(flutterTimerRef.current);
    flutterTimerRef.current = null;
  };

  const clearStudyFlutterTimer = () => {
    if (studyFlutterTimerRef.current !== null) window.clearTimeout(studyFlutterTimerRef.current);
    studyFlutterTimerRef.current = null;
  };

  const showBookStudy = () => {
    clearStudyFlutterTimer();
    setBookStudyExiting(false);
    setBookStudyTransitioning(false);
    setBookStudyActive(true);
  };

  const scheduleStudyFlutter = (sessionKey: string, delayMs = 8) => {
    clearStudyFlutterTimer();
    studyFlutterTimerRef.current = window.setTimeout(() => {
      if (!sessionKey || activeBookSessionRef.current !== sessionKey || bookClosingRef.current) return;
      const pageFlip = flipBookRef.current?.pageFlip?.();
      if (!pageFlip) {
        scheduleStudyFlutter(sessionKey, 16);
        return;
      }
      const pageIndex = Number(pageFlip.getCurrentPageIndex?.() ?? BOOK_CONTENT_PAGE);
      if (pageFlip.getState?.() !== "read") {
        scheduleStudyFlutter(sessionKey, 16);
        return;
      }
      if (pageIndex >= BOOK_STUDY_PAGE) {
        showBookStudy();
        return;
      }
      pageFlip.flipNext("top");
      scheduleStudyFlutter(sessionKey, 16);
    }, delayMs);
  };

  const startBookStudy = async (stage: number) => {
    if (!openedDeck || bookStudyTransitioning || bookStudyActive || bookClosingRef.current) return;
    setBookStudyExiting(false);
    setBookStudyNavigationLocked(true);
    onRequestHomeSection(0);
    setBookStudyTransitioning(true);
    setEntryMessage("");
    try {
      setStudyResult(await api.startStudy(openedDeck.id, stage));
      if (reduceMotion) {
        flipBookRef.current?.pageFlip?.().turnToPage(BOOK_STUDY_PAGE);
        showBookStudy();
        return;
      }
      scheduleStudyFlutter(bookSessionKey, 8);
    } catch (error) {
      setBookStudyNavigationLocked(false);
      setBookStudyTransitioning(false);
      setEntryMessage(String(error));
    }
  };

  const scheduleBookFlutter = (sessionKey: string, delayMs: number) => {
    clearFlutterTimer();
    flutterTimerRef.current = window.setTimeout(() => {
      if (!sessionKey || activeBookSessionRef.current !== sessionKey || reduceMotion || bookClosingRef.current) return;
      const pageFlip = flipBookRef.current?.pageFlip?.();
      if (!pageFlip) {
        if (flutterRetryRef.current++ < 24) scheduleBookFlutter(sessionKey, 16);
        return;
      }
      flutterRetryRef.current = 0;
      const pageIndex = Number(pageFlip.getCurrentPageIndex?.() ?? 0);
      if (pageIndex >= BOOK_CONTENT_PAGE) {
        flutteringRef.current = false;
        setBookSettled(true);
        return;
      }
      flutteringRef.current = true;
      if (pageFlip.getState?.() !== "read") {
        scheduleBookFlutter(sessionKey, 16);
        return;
      }
      if (pageIndex === 0 && !bookOpeningStartedRef.current) {
        bookOpeningStartedRef.current = true;
        setBookOpeningStarted(true);
        window.requestAnimationFrame(() => {
          if (activeBookSessionRef.current !== sessionKey || bookClosingRef.current) return;
          const readyFlip = flipBookRef.current?.pageFlip?.();
          if (!readyFlip || readyFlip.getState?.() !== "read") {
            scheduleBookFlutter(sessionKey, 16);
            return;
          }
          readyFlip.flipNext("top");
          scheduleBookFlutter(sessionKey, 16);
        });
        return;
      }
      pageFlip.flipNext("top");
      scheduleBookFlutter(sessionKey, 16);
    }, delayMs);
  };

  const beginBookFlutter = (sessionKey: string) => {
    if (reduceMotion || bookSettled || bookClosingRef.current || !sessionKey || activeBookSessionRef.current !== sessionKey) return;
    if (flutterStartedSessionRef.current === sessionKey) return;
    flutterStartedSessionRef.current = sessionKey;
    flutterRetryRef.current = 0;
    flutteringRef.current = true;
    setBookSettled(false);
    // Keep the cover readable for a beat and let the 3D page volume finish
    // its first canvas render before the cover starts turning.
    scheduleBookFlutter(sessionKey, BOOK_COVER_HOLD_MS);
  };

  const finishClosingBook = () => {
    setBookStudyNavigationLocked(false);
    activeBookSessionRef.current = "";
    clearFlutterTimer();
    clearStudyFlutterTimer();
    flutteringRef.current = false;
    flutterRetryRef.current = 0;
    flutterStartedSessionRef.current = "";
    bookClosingRef.current = false;
    bookOpeningStartedRef.current = false;
    setBookOpeningStarted(false);
    setBook3DReady(false);
    setBookFlipReady(false);
    setBookSettled(false);
    setBookStudyActive(false);
    setBookStudyExiting(false);
    setBookStudyTransitioning(false);
    setBookPanel("study");
    setEntryDialog(null);
    setEditingEntryId(null);
    setBulkText("");
    setBulkFileName("");
    setDeleteCandidate(null);
    setSkipDeleteConfirm(false);
    setEntryMessage("");
    setOpenedDeckId(null);
    onOpenedDeckChange(null);
  };

  const closeOpenedBook = () => {
    if (bookClosingRef.current) return;
    const fold = bookFoldRef.current;
    const stack = fold?.parentElement;
    const leftPage = stack?.querySelector<HTMLElement>(".tanren-flip-book .book-inside-left");
    const rightPage = stack?.querySelector<HTMLElement>(".tanren-flip-book .book-inside-right");
    const cover = stack?.querySelector<HTMLElement>(".book-shelf-cover-page .ebook-cover");
    if (reduceMotion || !fold || !stack || !leftPage || !rightPage || !cover) {
      finishClosingBook();
      return;
    }
    prepareBookClosing(fold, leftPage, rightPage, cover);
    clearFlutterTimer();
    bookClosingRef.current = true;
    setBookClosing(true);
    flutteringRef.current = false;
  };

  const openEntryPanel = async () => {
    if (!openedDeck) return;
    setBookPanel("entries");
    setEntryMessage("");
    setBookPanelLoading(true);
    try {
      setBookEntries(await api.listEntries(openedDeck.id));
    } finally {
      setBookPanelLoading(false);
    }
  };

  const refreshBookEntries = async (deckId: string, scrollToBottom = false) => {
    if (bookPanel === "entries") setBookEntries(await api.listEntries(deckId));
    await onRefresh();
    window.dispatchEvent(new CustomEvent("tanren:deck-entries-changed", { detail: { deckId, scrollToBottom } }));
  };

  const openAddEntryDialog = () => {
    setEditingEntryId(null);
    setSingleTerm("");
    setSingleMeaning("");
    setSingleReading("");
    setOriginalEntry(null);
    setEntryMessage("");
    setEntryDialog("single");
  };

  const openEditEntryDialog = (entry: EntryListRecord) => {
    setEditingEntryId(entry.id);
    setSingleTerm(entry.term);
    setSingleMeaning(entry.meanings.join(" / "));
    setSingleReading(entry.reading ?? "");
    setOriginalEntry(entry);
    setEntryMessage("");
    setEntryDialog("single");
    if (!openedDeck) return;
    void api.entryDetails(openedDeck.id, entry.id).then((details) => {
      if (details.entry.id !== entry.id) return;
      setOriginalEntry(details.entry);
      setSingleTerm(details.entry.term);
      setSingleMeaning(details.entry.meanings.join(" / "));
      setSingleReading(details.entry.reading ?? "");
    }).catch((cause) => setEntryMessage(String(cause)));
  };

  const chooseImportEntryFile = () => importFileInputRef.current?.click();

  const handleImportEntryFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    const text = await file.text();
    setEditingEntryId(null);
    setEntryMessage("");
    setBulkText(text);
    setBulkFileName(file.name);
    setEntryDialog("bulk");
  };

  const closeEntryDialog = () => {
    if (entryDialog === "bulk") {
      setBulkText("");
      setBulkFileName("");
    }
    setEntryDialog(null);
    setEditingEntryId(null);
    setOriginalEntry(null);
  };

  const deleteEntry = async (entry: EntryListRecord) => {
    if (!openedDeck || entrySaving) return;
    setEntrySaving(true);
    try {
      await api.deleteEntry(openedDeck.id, entry.id);
      setDeleteCandidate(null);
      setSkipDeleteConfirm(false);
      await refreshBookEntries(openedDeck.id);
    } finally {
      setEntrySaving(false);
    }
  };

  const openDeleteEntryDialog = (entry: EntryListRecord) => {
    if (!openedDeck) return;
    if (skipDeleteConfirmDeckIdsRef.current.has(openedDeck.id)) {
      void deleteEntry(entry);
      return;
    }
    setSkipDeleteConfirm(false);
    setDeleteCandidate(entry);
  };

  const confirmDeleteEntry = async () => {
    if (!openedDeck || !deleteCandidate) return;
    if (skipDeleteConfirm) skipDeleteConfirmDeckIdsRef.current.add(openedDeck.id);
    await deleteEntry(deleteCandidate);
  };

  useEffect(() => {
    if ((!entryDialog && !deleteCandidate) || entrySaving) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (deleteCandidate) {
        setDeleteCandidate(null);
        setSkipDeleteConfirm(false);
      } else {
        closeEntryDialog();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [entryDialog, deleteCandidate, entrySaving]);

  const addSingleEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!openedDeck || !singleTerm.trim() || !singleMeaning.trim() || entrySaving) return;
    setEntrySaving(true);
    try {
      const entry = {
        term: singleTerm.trim(),
        meanings: parseMeaningInput(singleMeaning),
        reading: singleReading.trim() || undefined,
      };
      const textChanged = !originalEntry
        || entry.term !== originalEntry.term
        || (entry.reading ?? "") !== (originalEntry.reading ?? "")
        || entry.meanings.join("\u0000") !== originalEntry.meanings.join("\u0000");
      const result = editingEntryId
        ? null
        : await api.importEntries(openedDeck.id, [entry]);
      const pronunciationChanged = editingEntryId && textChanged
        ? await api.updateEntry(openedDeck.id, editingEntryId, entry)
        : false;
      const processing = result?.entry_ids?.length
        ? await waitForEntryProcessing(result.entry_ids)
        : editingEntryId && pronunciationChanged
          ? await waitForEntryProcessing([editingEntryId])
          : null;
      const processingPrefix = editingEntryId ? "저장했지만" : "추가했지만";

      setSingleTerm("");
      setSingleMeaning("");
      setSingleReading("");
      setOriginalEntry(null);
      setEntryDialog(null);
      setEditingEntryId(null);
      setEntryMessage(processing?.failed
        ? `${processingPrefix} ${processing.failed.toLocaleString("ko-KR")}개 표현의 피치·음성 생성에 실패했어요.${processing.last_error ? ` ${processing.last_error}` : ""}`
        : processing?.runtime_phase === "unavailable"
          ? `${processingPrefix} 음성 엔진을 사용할 수 없어 피치·음성 생성을 완료하지 못했어요.`
          : "");
      await refreshBookEntries(openedDeck.id, Boolean(result?.inserted));
    } finally {
      setEntrySaving(false);
    }
  };

  const addBulkEntries = async () => {
    if (!openedDeck || parsedBulkEntries.entries.length === 0 || entrySaving) return;
    setEntrySaving(true);
    try {
      const result = await api.importEntries(openedDeck.id, parsedBulkEntries.entries);
      const processing = result.entry_ids.length ? await waitForEntryProcessing(result.entry_ids) : null;
      setEntryMessage(processing?.failed
        ? `추가했지만 ${processing.failed.toLocaleString("ko-KR")}개 표현의 피치·음성 생성에 실패했어요.${processing.last_error ? ` ${processing.last_error}` : ""}`
        : processing?.runtime_phase === "unavailable"
          ? "추가했지만 음성 엔진을 사용할 수 없어 피치·음성 생성을 완료하지 못했어요."
          : "");
      setBulkText("");
      setBulkFileName("");
      setEntryDialog(null);
      await refreshBookEntries(openedDeck.id, result.inserted > 0);
    } finally {
      setEntrySaving(false);
    }
  };

  useEffect(() => {
    bookClosingRef.current = false;
    setBookClosing(false);
    bookOpeningStartedRef.current = Boolean(openedDeckId && reduceMotion);
    setBookOpeningStarted(Boolean(openedDeckId && reduceMotion));
    clearFlutterTimer();
    flutteringRef.current = false;
    flutterRetryRef.current = 0;
    flutterStartedSessionRef.current = "";
    setBookSettled(Boolean(openedDeckId && reduceMotion));
    return () => {
      setBookStudyNavigationLocked(false);
      clearFlutterTimer();
      clearStudyFlutterTimer();
      flutteringRef.current = false;
    };
  }, [openedDeckId, bookOpenCycle]);

  useEffect(() => {
    if (!openedDeckId || reduceMotion || !bookSessionKey || !book3DReady || !bookFlipReady) return;
    beginBookFlutter(bookSessionKey);
  }, [openedDeckId, bookOpenCycle, book3DReady, bookFlipReady]);

  const continueBookFlutter = (pageIndex: number, sessionKey: string) => {
    if (activeBookSessionRef.current !== sessionKey || bookClosingRef.current) return;
    if (reduceMotion || !flutteringRef.current || pageIndex >= BOOK_CONTENT_PAGE) {
      flutteringRef.current = false;
      if (pageIndex >= BOOK_CONTENT_PAGE) setBookSettled(true);
      return;
    }
    scheduleBookFlutter(sessionKey, 4);
  };

  return <section className={`content home-content ${bookLayoutOpen ? "is-book-open" : ""}`}>
    <AnimatePresence
      initial={false}
      mode="wait"
      onExitComplete={() => setBookLayoutOpen(Boolean(openedDeck))}
    >
      {openedDeck ? <motion.section
        key={`opened-${openedDeck.id}-${bookOpenCycle}`}
        className={`open-book-stage ${bookSettled ? "is-settled" : ""} ${bookOpeningStarted ? "is-opening" : "is-cover-hold"} ${bookClosing ? "is-closing" : ""} ${bookStudyTransitioning ? "is-study-transitioning" : ""} ${bookStudyActive ? "is-book-study" : ""} ${bookStudyExiting ? "is-study-exiting" : ""}`}
        inert={bookClosing || bookStudyTransitioning}
        aria-label={`${openedDeck.name} deck`}
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: bookVisualReady ? 1 : 0, y: bookVisualReady ? 0 : 12 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        transition={reduceMotion ? { duration: .01 } : { duration: .28, ease: [0.22, 1, 0.36, 1] }}
      >
        <OpenBook3D
          openingStarted={bookOpeningStarted || bookSettled}
          onReady={() => {
            if (activeBookSessionRef.current === bookSessionKey) setBook3DReady(true);
          }}
        />
        <div className="book-flip-stack" style={{ maxWidth: OPEN_BOOK_TARGET_WIDTH }}>
          <div ref={bookFoldRef} className="book-fold" aria-hidden="true"
            onAnimationEnd={(event) => {
              if (event.animationName === "book-volume-close" && bookClosingRef.current) finishClosingBook();
            }} />
          <span className="book-paper-center-edge" aria-hidden="true" />
          <HTMLFlipBook
            key={`${openedDeck.id}-${bookOpenCycle}`}
            ref={flipBookRef}
            className="tanren-flip-book"
            style={{}}
            width={590}
            height={690}
            size="stretch"
            minWidth={390}
            maxWidth={OPEN_BOOK_PAGE_MAX_WIDTH}
            minHeight={500}
            maxHeight={OPEN_BOOK_PAGE_MAX_HEIGHT}
            startPage={reduceMotion || bookSettled ? BOOK_CONTENT_PAGE : 0}
            drawShadow={!reduceMotion}
            flippingTime={reduceMotion ? 1 : 125}
            usePortrait={false}
            startZIndex={10}
            autoSize={true}
            maxShadowOpacity={0.38}
            showCover={true}
            mobileScrollSupport={true}
            clickEventForward={true}
            useMouseEvents={false}
            swipeDistance={30}
            showPageCorners={false}
            disableFlipByClick={true}
            renderOnlyPageLengthChange={false}
            onInit={() => setBookFlipReady(true)}
            onFlip={(event) => continueBookFlutter(Number(event.data), bookSessionKey)}
          >
            <FlipPage className="book-cover-page book-shelf-cover-page" hard>
              <span className="ebook-cover">
                <span className="ebook-cover-face" style={{ background: bookCoverBackgroundRef.current }}>
                  <span className="ebook-volume">Vol. {String(decks.findIndex((deck) => deck.id === openedDeck.id) + 1).padStart(2, "0")}</span>
                  <span className="ebook-rule" />
                  <span className="ebook-language">日本語</span>
                  <strong title={openedDeck.name}>{openedDeck.name}</strong>
                  <span className="ebook-bottom">
                    <span className="ebook-meta">{openedDeck.entry_count.toLocaleString("en-US")} Expressions</span>
                    <span className="ebook-current">
                      <span className="ebook-current-stage">{openedDeck.current_stage}단계</span>
                      <span className="ebook-current-range">{formatStudyRangeLabel(openedDeck.active_range, " - ")}</span>
                    </span>
                    <span className="ebook-progress" aria-hidden="true"><i style={{ width: `${bookProgressPercent(openedDeck)}%` }} /></span>
                  </span>
                </span>
                <span className="ebook-page-edge ebook-page-edge-right" aria-hidden="true" />
              </span>
            </FlipPage>

            {Array.from({ length: BOOK_FLUTTER_LEAF_COUNT }, (_, index) => (
              <FlipPage key={`flutter-${index}`} className="book-flutter-page">
                <span className="book-flutter-folio">{String(index + 1).padStart(2, "0")}</span>
              </FlipPage>
            ))}

            <FlipPage className="book-inside-page book-inside-left">
              <div className="book-page-inner">
              <div className="book-page-topline">
                <button className="book-close ghost" onClick={closeOpenedBook} aria-label="책장으로 돌아가기" title="책장으로 돌아가기" />
                <BookDeleteButton
                  deck={openedDeck}
                  onDeleted={async () => {
                    setOpenedDeckId(null);
                    onOpenedDeckChange(null);
                    await onRefresh();
                  }}
                />
                </div>
                <div className="book-title-page">
                  <span className="book-language">
                    {openedDeck.target_language === "ja-JP" ? "日本語"
                      : openedDeck.target_language === "ko-KR" ? "한국어"
                        : openedDeck.target_language === "en-US" ? "English"
                          : openedDeck.target_language}
                  </span>
                  <BookTitleEditor deck={openedDeck} onRefresh={onRefresh} />
                  <div className="book-progress-summary" aria-label="책 전체 진행률">
                    <div className="book-progress-rate">
                      <span>진행률</span>
                      <strong>{Math.round(bookProgressPercent(openedDeck))}%</strong>
                    </div>
                    <div className="book-progress-count">
                      {numberFormat.format(openedDeck.completed_stage_count)} / {numberFormat.format(openedDeck.total_stage_count)}단계
                    </div>
                  </div>
                </div>
                <BookInlineEntryManager
                  deckId={openedDeck.id}
                  onAdd={openAddEntryDialog}
                  onImport={chooseImportEntryFile}
                  onEdit={openEditEntryDialog}
                  onDelete={openDeleteEntryDialog}
                />
              </div>
            </FlipPage>

            <FlipPage className="book-inside-page book-inside-right">
              <div className="book-page-inner book-page-inner-right">
                <div className="range-heading">
                  <div><span>CONTENTS</span><strong>학습 단계</strong></div>
                </div>
                {entryMessage && <p className="book-entry-message" role="alert">{entryMessage}</p>}
                <div className="book-range-scroll" aria-label={`${openedDeck.name} study ranges`}>
                  <div className="book-stage-list">
                    {Array.from({ length: openedDeck.total_stage_count }, (_, index) => index + 1).map((stage) => {
                      const current = stage === openedDeck.current_stage;
                      const fallbackRange = openedDeck.study_ranges[stage - 1];
                      const schedule = stageSchedules[stage];
                      const range = schedule?.study_range ?? fallbackRange;
                      const entryCount = range ? Math.max(0, range.end - range.start) : 0;
                      const questionCount = entryCount * openedDeck.enabled_modes.length;
                      const completed = Boolean(schedule?.completed);
                      return <div className={`book-stage-group ${current ? "is-current-stage" : ""} ${completed ? "is-completed-stage" : ""}`} key={stage}>
                        <button
                          type="button"
                          className="ghost book-stage-card"
                          onClick={() => void startBookStudy(stage)}
                        >
                          <strong className={`book-stage-title ${range?.cumulative ? "is-cumulative" : ""}`}>
                            {range?.cumulative && <small>총복습</small>}
                            <span>{stage.toLocaleString("ko-KR")}단계</span>
                          </strong>

                          <span className={`book-stage-middle ${schedule?.clear_times_ms.length ? "has-clear-times" : ""}`}>
                            <span className="book-stage-range" aria-label={`${stage}단계 학습 단계`}>
                              {range && <>
                                <span
                                  className={`book-stage-range-link ${schedule?.active ? "is-current" : ""}`}
                                >{formatStudyRangeLabel(range.label)}</span>
                                <span className="book-stage-range-meta">
                                  <span>{entryCount.toLocaleString("ko-KR")}개</span>
                                  <span>{questionCount.toLocaleString("ko-KR")}문항</span>
                                </span>
                              </>}
                            </span>
                            {schedule?.clear_times_ms.length ? <span className="book-stage-clear-times" aria-label={`${stage}단계 클리어 기록`}>
                              {schedule.clear_times_ms.map((durationMs, clearIndex) => <span className="book-stage-clear-time" key={`${stage}-${clearIndex}-${durationMs}`}>
                                {clearIndex + 1}회독 {formatStudyTime(durationMs)}
                              </span>)}
                            </span> : null}
                          </span>
                          {completed && <span className="book-stage-complete" aria-label="클리어 완료">✓</span>}
                        </button>
                      </div>;
                    })}
                  </div>
                </div>
            </div>
            </FlipPage>

            {Array.from({ length: BOOK_STUDY_FLUTTER_LEAF_COUNT }, (_, index) => (
              <FlipPage key={`study-flutter-${index}`} className="book-flutter-page book-study-flutter-page">
                <span className="book-flutter-folio">{String(BOOK_FLUTTER_LEAF_COUNT + index + 1).padStart(2, "0")}</span>
              </FlipPage>
            ))}

            <FlipPage className="book-flutter-page book-study-page"><span aria-hidden="true" /></FlipPage>
            <FlipPage className="book-flutter-page book-study-page"><span aria-hidden="true" /></FlipPage>

            <FlipPage className="book-back-page" hard>
              <span>鍛錬</span>
            </FlipPage>
          </HTMLFlipBook>
          {bookStudyActive && studyResult && <BookStudy
            deck={openedDeck}
            initialResult={studyResult}
            audioSettings={audioSettings}
            exiting={bookStudyExiting}
            onExitFadeComplete={() => {
              setBookStudyActive(false);
              setBookStudyExiting(false);
              setBookStudyTransitioning(false);
              setStudyResult(null);
              setBookStudyNavigationLocked(false);
            }}
            onExit={async () => {
            await api.exitStudy();
            if (reduceMotion) {
              flipBookRef.current?.pageFlip?.().turnToPage(BOOK_CONTENT_PAGE);
              setBookStudyActive(false);
              setBookStudyExiting(false);
              setBookStudyTransitioning(false);
              setStudyResult(null);
              setBookStudyNavigationLocked(false);
            } else {
              // Put the expression/stage spread underneath first, then simply
              // fade the learning layer away to reveal it.
              flipBookRef.current?.pageFlip?.().turnToPage(BOOK_CONTENT_PAGE);
              setBookStudyExiting(true);
              setBookStudyTransitioning(true);
            }
            await onRefresh();
          }} />}
        </div>

        {bookPanel !== "study" && <div
          className="book-workspace-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !entryDialog) setBookPanel("study");
          }}
        >
          <div className="book-workspace is-entries" role="dialog" aria-modal="true" aria-label={`${openedDeck.name} 표현 관리`}>
            <header className="book-workspace-header">
              <div className="book-workspace-title">
                <div><span>EXPRESSIONS</span><strong>{openedDeck.name}</strong></div>
              </div>
              <div className="book-workspace-actions">
                <button className="ghost" onClick={openAddEntryDialog}>+ 표현 추가</button>
                <button className="ghost" onClick={chooseImportEntryFile}>파일에서 추가</button>
                <button className="ghost book-workspace-close" aria-label="닫기" onClick={() => setBookPanel("study")}>×</button>
              </div>
            </header>

            <>
              <div className="book-entry-toolbar">
                <label className="book-entry-search">
                  <span aria-hidden="true">⌕</span>
                  <input value={entrySearch} onChange={(event) => setEntrySearch(event.target.value)} placeholder="표현, 발음, 뜻 검색" aria-label="표현 검색" />
                </label>
                <span>{numberFormat.format(filteredBookEntries.length)} / {numberFormat.format(bookEntries.length)}개</span>
              </div>
              {entryMessage && <p className="book-entry-message">{entryMessage}</p>}
              <div className="book-entry-browser">
                <div className="book-entry-row book-entry-row-head" aria-hidden="true">
                  <span>#</span><span>표현</span><span>발음</span><span>뜻</span>
                </div>
                <div className="book-entry-list">
                  {bookPanelLoading ? <div className="book-workspace-empty">표현을 불러오고 있어요.</div>
                    : filteredBookEntries.length === 0 ? <div className="book-workspace-empty">{bookEntries.length === 0 ? "아직 표현이 없어요." : "검색 결과가 없어요."}</div>
                      : filteredBookEntries.map((entry, index) => <div className="book-entry-row" key={entry.id}>
                        <span>{String(index + 1).padStart(3, "0")}</span>
                        <strong>{entry.term}</strong>
                        <span className="book-entry-reading">{entry.reading || "—"}</span>
                        <span className="book-entry-meaning">{entry.meanings.join(" / ")}</span>
                      </div>)}
                </div>
              </div>
            </>

            {entryDialog && <div className="book-entry-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !entrySaving) closeEntryDialog(); }}>
              {entryDialog === "single" ? <form className="book-entry-dialog" onSubmit={(event) => void addSingleEntry(event)}>
                <div className="book-entry-dialog-head"><div><span>{editingEntryId ? "EDIT EXPRESSION" : "ADD EXPRESSION"}</span><h3 className="book-entry-dialog-title">{editingEntryId ? "표현 편집" : "표현 추가"}</h3></div><button type="button" className="book-entry-dialog-close ghost" onClick={closeEntryDialog}>×</button></div>
                <label><span>표현</span><input className="home-create-input" autoFocus value={singleTerm} onChange={(event) => setSingleTerm(event.target.value)} placeholder="표현을 입력해주세요" /></label>
                <label><span>발음 <small>선택</small></span><input className="home-create-input" value={singleReading} onChange={(event) => setSingleReading(event.target.value)} placeholder="발음을 입력해주세요" /></label>
                <label><span>뜻</span><input className="home-create-input" value={singleMeaning} onChange={(event) => setSingleMeaning(event.target.value)} placeholder="뜻을 입력해주세요" /></label>
                <div className="book-entry-dialog-actions"><button type="button" className="settings-action-button" onClick={closeEntryDialog}>취소</button><button className="settings-action-button" disabled={entrySaving || !singleTerm.trim() || !singleMeaning.trim() || japaneseReadingInvalid}>{editingEntryId ? "저장" : "추가"}</button></div>
              </form> : <div className="book-entry-dialog book-entry-import-dialog">
                <div className="book-entry-dialog-head"><div><span>IMPORT EXPRESSIONS</span><h3 className="book-entry-dialog-title">파일로 표현 추가</h3></div><button type="button" className="book-entry-dialog-close ghost" onClick={closeEntryDialog}>×</button></div>
                <div className="book-entry-import-meta">
                  <strong title={bulkFileName}>{bulkFileName || "선택한 파일"}</strong>
                  <span>총 {parsedBulkEntries.entries.length.toLocaleString("ko-KR")}개{bulkPreviewHiddenCount > 0 ? ` (${IMPORT_PREVIEW_LIMIT.toLocaleString("ko-KR")}개 미리보기)` : ""}</span>
                </div>
                {parsedBulkEntries.issues.length > 0 && <div className="book-entry-import-note">
                  <span>확인 필요 행은 추가에서 제외돼요.</span>
                </div>}
                <div className="book-entry-import-table" role="table" aria-label="가져올 표현 미리보기">
                  <div className="book-entry-import-row book-entry-import-head" role="row"><span>#</span><span>표현</span><span>발음</span><span>뜻</span></div>
                  <div className="book-entry-import-body" ref={importPreviewRef}>
                    {bulkPreviewEntries.length > 0
                      ? bulkPreviewEntries.map((entry, index) => <div className="book-entry-import-row" role="row" key={`${index}-${entry.term}-${entry.reading ?? ""}`}>
                        <span>{(index + 1).toLocaleString("ko-KR")}</span><strong title={entry.term}>{entry.term}</strong><span title={entry.reading ?? ""}>{entry.reading || "—"}</span><span title={entry.meanings.join(" / ")}>{entry.meanings.join(" / ")}</span>
                      </div>)
                      : <div className="book-entry-import-empty">가져올 수 있는 표현이 없어요.</div>}
                  </div>
                </div>
                <div className="book-entry-dialog-actions"><button type="button" className="settings-action-button" onClick={closeEntryDialog}>취소</button><button className="settings-action-button" disabled={entrySaving || parsedBulkEntries.entries.length === 0} onClick={() => void addBulkEntries()}>추가</button></div>
              </div>}
            </div>}
          </div>
        </div>}

        {bookPanel === "study" && entryDialog && <div className="book-entry-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !entrySaving) closeEntryDialog(); }}>
          {entryDialog === "single" ? <form className="book-entry-dialog" onSubmit={(event) => void addSingleEntry(event)}>
            <div className="book-entry-dialog-head"><div><span>{editingEntryId ? "EDIT EXPRESSION" : "ADD EXPRESSION"}</span><h3 className="book-entry-dialog-title">{editingEntryId ? "표현 편집" : "표현 추가"}</h3></div><button type="button" className="book-entry-dialog-close ghost" onClick={closeEntryDialog}>×</button></div>
            <label><span>표현</span><input className="home-create-input" autoFocus value={singleTerm} onChange={(event) => setSingleTerm(event.target.value)} placeholder="표현을 입력해주세요" /></label>
            <label><span>발음 <small>선택</small></span><input className="home-create-input" value={singleReading} onChange={(event) => setSingleReading(event.target.value)} placeholder="발음을 입력해주세요" /></label>
            <label><span>뜻</span><input className="home-create-input" value={singleMeaning} onChange={(event) => setSingleMeaning(event.target.value)} placeholder="뜻을 입력해주세요" /></label>
            <div className="book-entry-dialog-actions"><button type="button" className="settings-action-button" onClick={closeEntryDialog}>취소</button><button className="settings-action-button" disabled={entrySaving || !singleTerm.trim() || !singleMeaning.trim() || japaneseReadingInvalid}>{editingEntryId ? "저장" : "추가"}</button></div>
          </form> : <div className="book-entry-dialog book-entry-import-dialog">
            <div className="book-entry-dialog-head"><div><span>IMPORT EXPRESSIONS</span><h3 className="book-entry-dialog-title">파일로 표현 추가</h3></div><button type="button" className="book-entry-dialog-close ghost" onClick={closeEntryDialog}>×</button></div>
            <div className="book-entry-import-meta">
              <strong title={bulkFileName}>{bulkFileName || "선택한 파일"}</strong>
              <span>총 {parsedBulkEntries.entries.length.toLocaleString("ko-KR")}개{bulkPreviewHiddenCount > 0 ? ` (${IMPORT_PREVIEW_LIMIT.toLocaleString("ko-KR")}개 미리보기)` : ""}</span>
            </div>
            {parsedBulkEntries.issues.length > 0 && <div className="book-entry-import-note">
              <span>확인 필요 행은 추가에서 제외돼요.</span>
            </div>}
            <div className="book-entry-import-table" role="table" aria-label="가져올 표현 미리보기">
              <div className="book-entry-import-row book-entry-import-head" role="row"><span>#</span><span>표현</span><span>발음</span><span>뜻</span></div>
              <div className="book-entry-import-body" ref={importPreviewRef}>
                {bulkPreviewEntries.length > 0
                  ? bulkPreviewEntries.map((entry, index) => <div className="book-entry-import-row" role="row" key={`${index}-${entry.term}-${entry.reading ?? ""}`}>
                    <span>{(index + 1).toLocaleString("ko-KR")}</span><strong title={entry.term}>{entry.term}</strong><span title={entry.reading ?? ""}>{entry.reading || "—"}</span><span title={entry.meanings.join(" / ")}>{entry.meanings.join(" / ")}</span>
                  </div>)
                  : <div className="book-entry-import-empty">가져올 수 있는 표현이 없어요.</div>}
              </div>
            </div>
            <div className="book-entry-dialog-actions"><button type="button" className="settings-action-button" onClick={closeEntryDialog}>취소</button><button className="settings-action-button" disabled={entrySaving || parsedBulkEntries.entries.length === 0} onClick={() => void addBulkEntries()}>추가</button></div>
          </div>}
        </div>}

        {deleteCandidate && <div className="book-entry-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !entrySaving) {
            setDeleteCandidate(null);
            setSkipDeleteConfirm(false);
          }
        }}>
          <div className="book-entry-dialog book-entry-delete-dialog" role="dialog" aria-modal="true" aria-label={`${deleteCandidate.term} 삭제 확인`}>
            <div className="book-entry-dialog-head">
              <div><span>DELETE EXPRESSION</span><h3>표현 삭제</h3></div>
              <button type="button" className="book-entry-dialog-close ghost" onClick={() => { setDeleteCandidate(null); setSkipDeleteConfirm(false); }}>×</button>
            </div>
            <p><strong>{deleteCandidate.term}</strong> 표현을 이 책에서 삭제할까요?</p>
            <label className="book-entry-delete-skip">
              <input type="checkbox" checked={skipDeleteConfirm} onChange={(event) => setSkipDeleteConfirm(event.target.checked)} />
              <span>이 책에서는 더 이상 묻지 않기</span>
            </label>
            <div className="book-entry-dialog-actions">
              <button type="button" className="settings-action-button" onClick={() => { setDeleteCandidate(null); setSkipDeleteConfirm(false); }}>취소</button>
              <button type="button" className="settings-action-button book-entry-delete-action" disabled={entrySaving} onClick={() => void confirmDeleteEntry()}>삭제</button>
            </div>
          </div>
        </div>}
        <input
          ref={importFileInputRef}
          className="book-entry-file-input"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void handleImportEntryFile(event)}
        />
        {entryProcessing && createPortal(
          <div className="entry-processing-overlay" role="dialog" aria-modal="true" aria-labelledby="entry-processing-title">
            <div className="initial-loading-content">
              <span className="initial-loading-spinner" aria-hidden="true" />
              <h2 id="entry-processing-title">피치·음성을 생성하고 있어요</h2>
              <div className="initial-loading-status" aria-live="polite">
                <p><span>진행</span><strong>{entryProcessing.completed + entryProcessing.failed} / {entryProcessing.total}</strong></p>
                <p><span>완료</span><strong>{entryProcessing.total === 0 ? "0%" : `${Math.round(((entryProcessing.completed + entryProcessing.failed) / entryProcessing.total) * 100)}%`}</strong></p>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </motion.section> : <motion.div key="shelf" className="book-shelf" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .18 }}>
        <form className="home-create" onSubmit={create}>
          <input
            className="home-create-input"
            value={name}
            maxLength={MAX_DECK_NAME_LENGTH}
            onChange={(e) => { setName(e.target.value); if (createError) setCreateError(null); }}
            placeholder="책 이름을 입력해주세요"
            aria-label="책 이름"
          />
          <button className="settings-action-button add-deck-button" type="submit" aria-label="책 추가" title="책 추가" disabled={!name.trim()}><span aria-hidden="true">+</span></button>
          {createError && <p className="home-create-error">{createError}</p>}
        </form>
        {Array.from({ length: Math.ceil(decks.length / 5) }, (_, rowIndex) => (
          <div className="book-shelf-row" key={`shelf-row-${rowIndex}`}>
            {decks.slice(rowIndex * 5, rowIndex * 5 + 5).map((d, rowDeckIndex) => {
              const index = rowIndex * 5 + rowDeckIndex;
              return <motion.button
                layoutId={`deck-book-${d.id}`}
                className={`deck-book deck-tone-${index % 4}`}
                key={d.id}
                aria-label={`${d.name} 책 열기`}
                onClick={(event) => {
                  const face = event.currentTarget.querySelector<HTMLElement>(".ebook-cover-face");
                  bookCoverBackgroundRef.current = face ? getComputedStyle(face).background : undefined;
                  clearFlutterTimer();
                  clearStudyFlutterTimer();
                  flutteringRef.current = false;
                  flutterRetryRef.current = 0;
                  flutterStartedSessionRef.current = "";
                  bookOpeningStartedRef.current = false;
                  setBookOpeningStarted(false);
                  setBook3DReady(false);
                  setBookFlipReady(false);
                  setBookSettled(false);
                  setBookStudyActive(false);
                  setBookStudyExiting(false);
                  setBookStudyTransitioning(false);
                  bookClosingRef.current = false;
                  setBookClosing(false);
                  setBookPanel("study");
                  setBookEntries([]);
                  setEntrySearch("");
                  setEntryDialog(null);
                  setEditingEntryId(null);
                  setBulkText("");
                  setBulkFileName("");
                  setDeleteCandidate(null);
                  setSkipDeleteConfirm(false);
                  setEntryMessage("");
                  setBookOpenCycle((cycle) => cycle + 1);
                  setOpenedDeckId(d.id);
                  onOpenedDeckChange(d.id);
                }}
                whileHover={reduceMotion ? undefined : { y: -4 }}
                whileTap={reduceMotion ? undefined : { y: -1, scale: .99 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
              >
                <span className="ebook-cover">
                  <span className="ebook-cover-face">
                    <span className="ebook-volume">Vol. {String(index + 1).padStart(2, "0")}</span>
                    <span className="ebook-rule" />
                    <span className="ebook-language">日本語</span>
                    <strong title={d.name}>{d.name}</strong>
                    <span className="ebook-bottom">
                      <span className="ebook-meta">{d.entry_count.toLocaleString("en-US")} Expressions</span>
                      <span className="ebook-current">
                        <span className="ebook-current-stage">{d.current_stage}단계</span>
                        <span className="ebook-current-range">{formatStudyRangeLabel(d.active_range, " - ")}</span>
                      </span>
                      <span className="ebook-progress" aria-hidden="true"><i style={{ width: `${bookProgressPercent(d)}%` }} /></span>
                    </span>
                  </span>
                  <span className="ebook-page-edge ebook-page-edge-right" aria-hidden="true" />
                </span>
              </motion.button>;
            })}
          </div>
        ))}
        {decks.length === 0 && <div className="empty"><strong>아직 책이 없어요.</strong></div>}
      </motion.div>}
    </AnimatePresence>
  </section>;
}

const MemoDeckList = memo(DeckList, (previous, next) => (
  previous.decks === next.decks
  && previous.audioSettings === next.audioSettings
));

function DeckEditor({ deck, onDone }: { deck: DeckSummary; onDone: () => Promise<void> }) {
  const [text, setText] = useState("見据える\t내다보다 / 전망하다\n躊躇う\t망설이다");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(deck.name);
  const [modes, setModes] = useState<StudyMode[]>(deck.enabled_modes);
  const importText = async () => {
    const parsed = parseEntryText(text);
    const result = await api.importEntries(deck.id, parsed.entries);
    const issueText = parsed.issues.length ? ` 확인이 필요한 표현이 ${parsed.issues.length}개 있어요: ${parsed.issues.map((issue) => `${issue.row}행 ${issue.message}`).join("; ")}` : "";
    setMessage(`${result.inserted}개를 추가했어요.${result.duplicates ? ` 중복 ${result.duplicates}개는 건너뛰었어요.` : ""}${issueText}`);
    await onDone();
  };
  const toggleMode = (mode: StudyMode) => setModes((current) => current.includes(mode) ? current.filter((value) => value !== mode) : [...current, mode]);
  const save = async () => {
    await api.updateDeck(deck.id, name, modes);
    setMessage("책 설정을 저장했어요.");
    await onDone();
  };
  const remove = async () => {
    if (!window.confirm(`'${name}' 책을 삭제할까요?\n책장에서 바로 사라져요.`)) return;
    await api.deleteDeck(deck.id);
    await onDone();
    window.location.reload();
  };
  const exportDeck = async () => {
    const payload = await api.exportDeck(deck.id);
    const blob = new Blob([payload], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/[^\p{L}\p{N}._-]+/gu, "-") || "tanren-deck"}.tanren.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return <section className="content narrow">
    <div className="section-heading"><div><h1>{name}</h1><p>표현을 붙여넣거나 CSV로 추가할 수 있어요.</p></div></div>
    <div className="deck-settings">
      <input value={name} maxLength={MAX_DECK_NAME_LENGTH} onChange={(event) => setName(event.target.value)} aria-label="책 이름" />
      <div className="mode-options">
        {(["reading", "listening", "writing"] as StudyMode[]).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} /> {STUDY_MODE_LABELS[mode]}</label>)}
        <label title="추가 예정"><input type="checkbox" disabled /> Speaking <span>(추가 예정)</span></label>
      </div>
      <div className="actions"><button disabled={!name.trim() || modes.length === 0} onClick={() => void save()}>저장하기</button><button className="ghost danger" onClick={() => void remove()}>삭제하기</button></div>
    </div>
    <DeckEntryInput value={text} onChange={setText} />
    <button onClick={importText}>표현 추가</button>
    {message && <p className="success">{message}</p>}
    <div className="editor-footer"><button className="ghost" onClick={() => void exportDeck()}>백업하기</button></div>
  </section>;
}

const numberFormat = new Intl.NumberFormat("ko-KR");

function formatPercent(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatLatency(value: number | null) {
  if (value == null) return "—";
  return value < 1_000 ? `${numberFormat.format(value)} ms` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatStudyTime(value: number | null) {
  if (value == null) return "—";
  const totalSeconds = Math.round(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  if (minutes > 0) return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  return `${seconds}초`;
}

function StatsMetric({ label, value, help, featured = false }: { label: string; value: string; help: string; featured?: boolean }) {
  const helpRef = useRef<HTMLSpanElement>(null);
  const helpTipRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLElement>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [helpPosition, setHelpPosition] = useState<{ left: number; top: number } | null>(null);

  const positionHelp = () => {
    const trigger = helpRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const tooltip = helpTipRef.current;
    const tooltipWidth = tooltip?.offsetWidth ?? 260;
    const tooltipHeight = tooltip?.offsetHeight ?? 0;
    const viewportPadding = 12;
    const preferredLeft = rect.right + 10;
    const left = Math.min(preferredLeft, window.innerWidth - tooltipWidth - viewportPadding);
    const preferredTop = rect.top + rect.height / 2;
    const minTop = viewportPadding + tooltipHeight / 2;
    const maxTop = window.innerHeight - viewportPadding - tooltipHeight / 2;
    setHelpPosition({
      left: Math.max(viewportPadding, left),
      top: tooltipHeight > 0 ? Math.min(Math.max(preferredTop, minTop), maxTop) : preferredTop,
    });
  };

  const openHelp = () => {
    setHelpPosition(null);
    setShowHelp(true);
  };

  const closeHelp = () => {
    setShowHelp(false);
    setHelpPosition(null);
  };

  useEffect(() => {
    if (!showHelp) return;
    const frame = window.requestAnimationFrame(positionHelp);
    const reposition = () => positionHelp();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [showHelp]);

  useLayoutEffect(() => {
    const element = valueRef.current;
    if (!element) return;

    const fitValue = () => {
      element.style.fontSize = "";
      const baseSize = Number.parseFloat(window.getComputedStyle(element).fontSize);
      if (!Number.isFinite(baseSize) || element.scrollWidth <= element.clientWidth) return;

      const ratio = element.clientWidth / element.scrollWidth;
      element.style.fontSize = `${Math.max(20, Math.floor(baseSize * ratio * 100) / 100)}px`;
    };

    fitValue();
    const observer = new ResizeObserver(fitValue);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  return <article className={`stats-metric ${featured ? "is-featured" : ""}`}>
    <div className="stats-metric-label">
      <span>{label}</span>
      <span
        ref={helpRef}
        className="stats-help"
        tabIndex={0}
        aria-label={`${label} 설명`}
        aria-expanded={showHelp}
        onMouseEnter={openHelp}
        onMouseLeave={closeHelp}
        onFocus={openHelp}
        onBlur={closeHelp}
      >?</span>
      {showHelp && createPortal(
        <span
          ref={helpTipRef}
          className="stats-help-tip stats-help-tip-portal"
          role="tooltip"
          style={{
            left: helpPosition?.left ?? 0,
            top: helpPosition?.top ?? 0,
            visibility: helpPosition ? "visible" : "hidden",
          }}
        >{help}</span>,
        document.body,
      )}
    </div>
    <strong ref={valueRef}>{value}</strong>
  </article>;
}

type GrowthMetric = "attempts" | "seen_entry_count" | "base_accuracy" | "pitch_accuracy" | "median_recall_latency_ms" | "study_time_ms";
type GrowthScope = "all" | "reading" | "writing" | "listening" | "speaking";

const GROWTH_SCOPES: Record<GrowthScope, string> = {
  all: "전체",
  reading: "Reading",
  writing: "Writing",
  listening: "Listening",
  speaking: "Speaking",
};

const GROWTH_METRICS: Record<GrowthMetric, { label: string; format: (value: number | null) => string; value: (point: LibraryStats["history"][number]) => number | null }> = {
  attempts: { label: "누적 시도", format: (value) => value == null ? "—" : `${numberFormat.format(value)}회`, value: (point) => point.attempts },
  seen_entry_count: { label: "누적 표현 수", format: (value) => value == null ? "—" : `${numberFormat.format(value)}개`, value: (point) => point.seen_entry_count },
  base_accuracy: { label: "문제 정확도", format: (value) => value == null ? "—" : `${(value * 100).toFixed(1)}%`, value: (point) => point.base_accuracy },
  pitch_accuracy: { label: "피치 정확도", format: (value) => value == null ? "—" : `${(value * 100).toFixed(1)}%`, value: (point) => point.pitch_accuracy },
  median_recall_latency_ms: { label: "중앙 응답시간", format: (value) => value == null ? "—" : formatLatency(value), value: (point) => point.median_recall_latency_ms },
  study_time_ms: { label: "공부 시간", format: (value) => formatStudyTime(value), value: (point) => point.study_time_ms },
};

function GrowthSelect<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!selectRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return <label ref={selectRef} className={`stats-growth-select ${label === "지표" ? "stats-growth-select--metric " : ""}${isOpen ? "is-open" : ""}`}>
    <span>{label}</span>
    <select
      value={String(value)}
      aria-expanded={isOpen}
      onMouseDown={(event) => {
        event.preventDefault();
        setIsOpen((open) => !open);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
          event.preventDefault();
          setIsOpen(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setIsOpen(false);
        }
      }}
      onChange={(event) => {
        const option = options.find((item) => String(item.value) === event.target.value);
        if (option) onChange(option.value);
      }}
    >
      {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>
    <i aria-hidden="true" />
    <AnimatePresence>
      {isOpen && <motion.div
        className="stats-growth-select-menu"
        role="listbox"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: .3, ease: [.4, 0, .2, 1] }}
      >
        {options.map((option) => {
          const isSelected = String(option.value) === String(value);
          return <button
            key={String(option.value)}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={isSelected ? "is-selected" : ""}
            onClick={() => {
              onChange(option.value);
              setIsOpen(false);
            }}
          >
            {option.label}
          </button>;
        })}
      </motion.div>}
    </AnimatePresence>
  </label>;
}

function formatGrowthDate(value: string) {
  const day = new Date(`${value}T00:00:00`).getDay();
  return `${value} (${["일", "월", "화", "수", "목", "금", "토"][day]})`;
}

type GrowthAxisGranularity = "year" | "month" | "day";

function formatGrowthAxisDate(value: number, granularity: GrowthAxisGranularity) {
  const date = new Date(value);
  if (granularity === "year") return `${date.getUTCFullYear()}년`;
  if (granularity === "month") return `${date.getUTCMonth() + 1}월`;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function GrowthAxisTick({ x = 0, y = 0, payload, chartWidth, plotLeft, plotRight, granularity }: any) {
  const rightEdge = Math.max(plotLeft, chartWidth - plotRight);
  if (x < plotLeft - 1 || x > rightEdge + 1) return null;

  let safeX = x;
  let textAnchor: "start" | "middle" | "end" = "middle";
  const edgeGuard = granularity === "year" ? 34 : 28;
  if (x <= plotLeft + edgeGuard) {
    safeX = plotLeft + 2;
    textAnchor = "start";
  } else if (x >= rightEdge - edgeGuard) {
    safeX = rightEdge - 2;
    textAnchor = "end";
  }

  return <text
    x={safeX}
    y={y}
    dy={14}
    textAnchor={textAnchor}
    fill="#f3f1eb"
    fontSize={13}
    fontFamily="var(--font-ui)"
    pointerEvents="none"
  >
    {formatGrowthAxisDate(Number(payload?.value), granularity)}
  </text>;
}

function GrowthTooltip({ active, payload, metricInfo }: any) {
  const value = payload?.[0]?.value as number | null | undefined;
  const date = payload?.[0]?.payload?.date as string | undefined;
  if (!active || !payload?.length || value == null) return null;
  return <div className="stats-growth-tooltip">
    <strong>{date ? formatGrowthDate(date) : ""}</strong>
    <b>{metricInfo.format(value)}</b>
  </div>;
}

function GrowthChart({ stats }: { stats: LibraryStats }) {
  const [metric, setMetric] = useState<GrowthMetric>("base_accuracy");
  const [scope, setScope] = useState<GrowthScope>("all");
  const [zoomWindow, setZoomWindow] = useState({ start: 0, end: Math.max(0, stats.history.length - 1) });
  const [chartWidth, setChartWidth] = useState(0);
  const growthChartRef = useRef<HTMLDivElement>(null);
  const tooltipMotionFrameRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; clientX: number; start: number; end: number } | null>(null);

  const resetTooltipMotion = () => {
    if (tooltipMotionFrameRef.current != null) {
      window.cancelAnimationFrame(tooltipMotionFrameRef.current);
      tooltipMotionFrameRef.current = null;
    }
    growthChartRef.current?.classList.remove("is-tooltip-following");
  };

  useEffect(() => {
    resetTooltipMotion();
    return resetTooltipMotion;
  }, [metric, scope, zoomWindow.start, zoomWindow.end]);

  useEffect(() => {
    const container = growthChartRef.current;
    if (!container) return;

    const armFollowMotion = () => {
      if (container.classList.contains("is-tooltip-following") || tooltipMotionFrameRef.current != null) return;
      const wrapper = container.querySelector<HTMLElement>(".recharts-tooltip-wrapper");
      if (!wrapper) return;
      const transform = wrapper.style.transform;
      const isVisible = wrapper.style.visibility !== "hidden" && wrapper.style.opacity !== "0";
      const hasRealPosition = transform.includes("translate") && !/translate(?:3d)?\(\s*0(?:px)?\s*,\s*0(?:px)?/i.test(transform);
      if (!isVisible || !hasRealPosition) return;

      tooltipMotionFrameRef.current = window.requestAnimationFrame(() => {
        tooltipMotionFrameRef.current = window.requestAnimationFrame(() => {
          container.classList.add("is-tooltip-following");
          tooltipMotionFrameRef.current = null;
        });
      });
    };

    const observer = new MutationObserver(armFollowMotion);
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    armFollowMotion();

    return () => {
      observer.disconnect();
      if (tooltipMotionFrameRef.current != null) {
        window.cancelAnimationFrame(tooltipMotionFrameRef.current);
        tooltipMotionFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const container = growthChartRef.current;
    if (!container) return;
    const updateWidth = () => setChartWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoomWindow({ start: 0, end: Math.max(0, stats.history.length - 1) });
  }, [stats.history.length, stats.history.at(-1)?.date]);

  const metricInfo = GROWTH_METRICS[metric];
  const chartData = stats.history.map((point, index) => {
    const modePoint = scope === "all" || scope === "speaking" ? null : point.modes[scope];
    const value = scope === "all" ? metricInfo.value(point) : modePoint?.[metric] ?? null;
    return {
      index,
      date: point.date,
      timestamp: Date.parse(`${point.date}T00:00:00Z`),
      value,
    };
  });
  const visibleStart = Math.max(0, Math.floor(zoomWindow.start) - 1);
  const visibleEnd = Math.min(chartData.length - 1, Math.ceil(zoomWindow.end) + 1);
  const visibleChartData = chartData.slice(visibleStart, visibleEnd + 1);
  const values = visibleChartData.map((point) => point.value);
  const validValues = values.filter((value): value is number => value != null);
  const isPercent = metric === "base_accuracy" || metric === "pitch_accuracy";
  const yDomain: [number, number | "auto"] = isPercent ? [0, 1] : [0, "auto"];
  const yTick = (value: number) => {
    if (isPercent) return `${Math.round(value * 100)}%`;
    if (metric === "median_recall_latency_ms") return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
    if (metric === "study_time_ms") return formatStudyTime(value);
    if (metric === "attempts") return `${numberFormat.format(value)}회`;
    if (metric === "seen_entry_count") return `${numberFormat.format(value)}개`;
    return numberFormat.format(value);
  };
  const scopeOptions = (Object.keys(GROWTH_SCOPES) as GrowthScope[]).map((key) => ({ value: key, label: GROWTH_SCOPES[key] }));
  const metricOptions = (Object.keys(GROWTH_METRICS) as GrowthMetric[]).map((key) => ({ value: key, label: GROWTH_METRICS[key].label }));

  const timestampAtIndex = (index: number) => {
    if (chartData.length === 0) return 0;
    const clamped = Math.max(0, Math.min(chartData.length - 1, index));
    const lowerIndex = Math.floor(clamped);
    const upperIndex = Math.ceil(clamped);
    if (lowerIndex === upperIndex) return chartData[lowerIndex].timestamp;
    const lower = chartData[lowerIndex].timestamp;
    const upper = chartData[upperIndex].timestamp;
    return lower + (upper - lower) * (clamped - lowerIndex);
  };
  const DAY_MS = 86_400_000;
  const rawXDomain: [number, number] = [timestampAtIndex(zoomWindow.start), timestampAtIndex(zoomWindow.end)];
  const xDomain: [number, number] = chartData.length === 1
    ? [rawXDomain[0] - DAY_MS / 2, rawXDomain[1] + DAY_MS / 2]
    : rawXDomain;
  const visibleDays = Math.max(1, (xDomain[1] - xDomain[0]) / DAY_MS);
  const xGranularity: GrowthAxisGranularity = visibleDays > 540 ? "year" : visibleDays > 60 ? "month" : "day";
  const targetTickCount = Math.max(2, Math.min(8, Math.floor((chartWidth || 900) / 115)));
  const xTicks: number[] = [];

  if (xGranularity === "year") {
    const firstYear = new Date(xDomain[0]).getUTCFullYear();
    const lastYear = new Date(xDomain[1]).getUTCFullYear();
    const visibleYears = Math.max(1, lastYear - firstYear + 1);
    const rawStep = visibleYears / targetTickCount;
    const step = [1, 2, 5, 10, 20, 50].find((candidate) => candidate >= rawStep) ?? Math.ceil(rawStep);
    const startYear = Math.ceil(firstYear / step) * step;
    for (let year = startYear; year <= lastYear; year += step) {
      const tick = Date.UTC(year, 0, 1);
      if (tick >= xDomain[0] && tick <= xDomain[1]) xTicks.push(tick);
    }
  } else if (xGranularity === "month") {
    const startDate = new Date(xDomain[0]);
    const endDate = new Date(xDomain[1]);
    const firstMonthIndex = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
    const lastMonthIndex = endDate.getUTCFullYear() * 12 + endDate.getUTCMonth();
    const visibleMonths = Math.max(1, lastMonthIndex - firstMonthIndex + 1);
    const rawStep = visibleMonths / targetTickCount;
    const step = [1, 2, 3, 6, 12, 24].find((candidate) => candidate >= rawStep) ?? Math.ceil(rawStep);
    const startMonthIndex = Math.ceil(firstMonthIndex / step) * step;
    for (let monthIndex = startMonthIndex; monthIndex <= lastMonthIndex; monthIndex += step) {
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex % 12;
      const tick = Date.UTC(year, month, 1);
      if (tick >= xDomain[0] && tick <= xDomain[1]) xTicks.push(tick);
    }
  } else {
    const rawStep = visibleDays / targetTickCount;
    const step = [1, 2, 3, 5, 7, 10, 14, 21, 30].find((candidate) => candidate >= rawStep) ?? Math.ceil(rawStep);
    const firstDayIndex = Math.ceil(xDomain[0] / DAY_MS);
    const lastDayIndex = Math.floor(xDomain[1] / DAY_MS);
    const startDayIndex = Math.ceil(firstDayIndex / step) * step;
    for (let dayIndex = startDayIndex; dayIndex <= lastDayIndex; dayIndex += step) {
      xTicks.push(dayIndex * DAY_MS);
    }
  }

  if (xTicks.length === 0) {
    xTicks.push((xDomain[0] + xDomain[1]) / 2);
  }

  const yearBoundaries: number[] = [];
  if (chartData.length > 0) {
    const firstDataYear = new Date(chartData[0].timestamp).getUTCFullYear();
    const lastDataYear = new Date(chartData[chartData.length - 1].timestamp).getUTCFullYear();
    for (let year = firstDataYear + 1; year <= lastDataYear; year += 1) {
      const boundary = Date.UTC(year, 0, 1);
      if (boundary > xDomain[0] && boundary < xDomain[1]) yearBoundaries.push(boundary);
    }
  }

  const zoomByWheel = (deltaY: number, anchorRatio: number) => {
    const total = chartData.length;
    if (total <= 1) return;
    const maxIndex = total - 1;
    const minSpan = Math.min(6, maxIndex);
    const normalizedDelta = Math.max(-120, Math.min(120, deltaY));
    const factor = Math.exp(normalizedDelta * .0012);

    setZoomWindow((current) => {
      const currentSpan = current.end - current.start;
      const nextSpan = Math.max(minSpan, Math.min(maxIndex, currentSpan * factor));
      if (Math.abs(nextSpan - currentSpan) < .001) return current;
      if (nextSpan >= maxIndex - .001) return { start: 0, end: maxIndex };

      const anchor = current.start + currentSpan * anchorRatio;
      let start = anchor - nextSpan * anchorRatio;
      let end = start + nextSpan;

      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > maxIndex) {
        start -= end - maxIndex;
        end = maxIndex;
      }

      return { start: Math.max(0, start), end: Math.min(maxIndex, end) };
    });
  };

  const panByPointer = (clientX: number) => {
    const pan = panRef.current;
    const container = growthChartRef.current;
    if (!pan || !container) return;
    const rect = container.getBoundingClientRect();
    const plotLeft = 66;
    const plotRight = 24;
    const plotWidth = Math.max(1, rect.width - plotLeft - plotRight);
    const span = pan.end - pan.start;
    const maxIndex = Math.max(0, chartData.length - 1);
    if (span >= maxIndex) return;

    const shift = -((clientX - pan.clientX) / plotWidth) * span;
    let start = pan.start + shift;
    let end = pan.end + shift;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > maxIndex) {
      start -= end - maxIndex;
      end = maxIndex;
    }
    setZoomWindow({ start: Math.max(0, start), end: Math.min(maxIndex, end) });
  };

  const isZoomed = zoomWindow.start > .001 || zoomWindow.end < chartData.length - 1 - .001;

  return <section className="stats-growth">
    {stats.attempts > 0 && <div className="stats-growth-toolbar">
      <GrowthSelect label="훈련" value={scope} options={scopeOptions} onChange={setScope} />
      <GrowthSelect label="지표" value={metric} options={metricOptions} onChange={setMetric} />
    </div>}
    <div
      ref={growthChartRef}
      className={`stats-growth-chart ${isZoomed ? "is-pannable" : ""}`}
      onPointerDown={(event) => {
        event.preventDefault();
        if (!isZoomed || event.button !== 0) return;
        panRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          start: zoomWindow.start,
          end: zoomWindow.end,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add("is-panning");
      }}
      onPointerMove={(event) => {
        if (panRef.current?.pointerId !== event.pointerId) return;
        panByPointer(event.clientX);
      }}
      onPointerUp={(event) => {
        if (panRef.current?.pointerId !== event.pointerId) return;
        panRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        event.currentTarget.classList.remove("is-panning");
      }}
      onPointerCancel={(event) => {
        if (panRef.current?.pointerId !== event.pointerId) return;
        panRef.current = null;
        event.currentTarget.classList.remove("is-panning");
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const plotLeft = 66;
        const plotRight = 24;
        const plotWidth = Math.max(1, rect.width - plotLeft - plotRight);
        const anchorRatio = Math.max(0, Math.min(1, (event.clientX - rect.left - plotLeft) / plotWidth));
        const deltaY = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
        zoomByWheel(deltaY, anchorRatio);
      }}
      onMouseLeave={resetTooltipMotion}
    >
      {validValues.length === 0 ? <div className="stats-growth-empty">학습 기록이 쌓이면 성장 곡선이 보여요.</div> :
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart accessibilityLayer={false} data={visibleChartData} margin={{ top: 68, right: 24, bottom: 4, left: 8 }}>
            <defs>
              <linearGradient id="tanrenGrowthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d8ad5c" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#d8ad5c" stopOpacity={0.015} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,.055)" />
            {yearBoundaries.map((boundary) => <ReferenceLine
              key={boundary}
              x={boundary}
              stroke="rgba(216,173,92,.15)"
              strokeWidth={1}
              ifOverflow="hidden"
            />)}
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={xDomain}
              ticks={xTicks}
              allowDataOverflow
              axisLine={{ stroke: "rgba(255,255,255,.16)" }}
              tickLine={false}
              interval={0}
              tick={(props) => <GrowthAxisTick
                {...props}
                chartWidth={chartWidth}
                plotLeft={66}
                plotRight={24}
                granularity={xGranularity}
              />}
            />
            <YAxis
              domain={yDomain}
              axisLine={{ stroke: "rgba(255,255,255,.16)" }}
              tickLine={false}
              tick={{ fill: "#f3f1eb", fontSize: 13 }}
              tickFormatter={yTick}
              width={58}
            />
            <Tooltip
              content={<GrowthTooltip metricInfo={metricInfo} />}
              cursor={{ stroke: "rgba(216,173,92,.22)", strokeWidth: 1 }}
              isAnimationActive={false}
              offset={28}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#d8ad5c"
              strokeWidth={2.2}
              fill="url(#tanrenGrowthFill)"
              connectNulls
              dot={false}
              activeDot={{ r: 4.5, fill: "#e6c578", stroke: "#151616", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>}
    </div>
  </section>;
}

function LibraryStatsView({ stats, deck }: { stats: LibraryStats | null; deck: DeckSummary | null }) {
  return <section className="content stats-dashboard stats-dashboard-global">
    {!stats ? <div className="stats-loading" aria-live="polite"><span />통계를 불러오고 있어요.</div>
      : stats.deck_count === 0 ? <div className="stats-empty"><span>統</span><strong>아직 보여드릴 통계가 없어요.</strong><p>학습을 시작하면 기록이 여기에 쌓여요.</p></div>
        : <>
          <div className="stats-context" aria-label={deck ? `${deck.name} 통계` : "전체 통계"}>
            <span>{deck ? "BOOK" : "LIBRARY"}</span>
            <strong>{deck ? `${deck.name} 통계` : "전체 통계"}</strong>
          </div>
          <div className="stats-summary-grid">
            <StatsMetric label="누적 시도" value={`${numberFormat.format(stats.attempts)}회`} help="지금까지 문제를 푼 횟수예요." />
            <StatsMetric label="누적 표현 수" value={`${numberFormat.format(stats.seen_entry_count)}개`} help="한 번이라도 학습한 표현 수예요." />
            <StatsMetric label="문제 정확도" value={formatPercent(stats.base_accuracy)} help="피치를 제외한 문제의 정답률이에요." />
            <StatsMetric label="피치 정확도" value={formatPercent(stats.pitch_accuracy)} help="피치를 정확히 맞힌 비율이에요." />
            <StatsMetric label="중앙 응답시간" value={formatLatency(stats.median_recall_latency_ms)} help="문제를 보고 답을 입력하기 시작하기까지 걸린 시간이에요." />
            <StatsMetric label="공부 시간" value={formatStudyTime(stats.study_time_ms)} help="학습 화면에서 실제로 공부한 시간을 기록해요." />
            {deck
              ? <StatsMetric label="수록 표현" value={`${numberFormat.format(stats.entry_count)}개`} help="이 책에 들어 있는 전체 표현 수예요." />
              : <StatsMetric label="책 개수" value={`${numberFormat.format(stats.deck_count)}개`} help="현재 책장에 있는 책의 개수예요." />}
          </div>

          <GrowthChart stats={stats} />
        </>}
  </section>;
}

export default App;
