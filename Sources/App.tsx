import { FormEvent, KeyboardEvent, forwardRef, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import HTMLFlipBook from "react-pageflip";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, RoundedBox } from "@react-three/drei";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "./lib/api";
import { parseEntryText } from "./lib/importParser";
import { japaneseImeKeyStartsInput, japaneseImeKeyTap, loadJapaneseImeRuntime, type JapaneseImeSegment, type JapaneseImeSession } from "./lib/japaneseIme";
import type { AudioSettings, DeckStats, DeckSummary, EntryListRecord, EntryRecord, LibraryStats, PitchQuestion, SemanticRuntimeStatus, StageScheduleSummary, StorageSettings, StudyCard, StudyMode, SubmitResult, VoicevoxRuntimeStatus } from "./lib/types";
import { activeCardTimerRuns, cardAfterResult, emptyPitchSelection, enterAction, exitStudyForDeckNavigation, pitchSubmission, setPitchLevel, shouldAutoPlayAfterWrittenAnswer, type PitchLevel, type PitchSelection } from "./lib/studyFlow";
import { completionDelayMs, firstMeaningfulInputAt, isMeaningfulInput, recallHasTimedOut } from "./lib/studyTimers";

type View = "decks" | "editor" | "study" | "stats" | "settings";

const BOOK_FLUTTER_LEAF_COUNT = 8;
const BOOK_CONTENT_PAGE = BOOK_FLUTTER_LEAF_COUNT + 1;
const MAX_DECK_NAME_LENGTH = 20;
const STUDY_MODE_LABELS: Record<StudyMode, string> = {
  reading: "Reading",
  listening: "Listening",
  writing: "Writing",
};
const VIEW_LABELS: Record<Exclude<View, "decks" | "study">, string> = {
  editor: "책 편집",
  stats: "통계",
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

function OpenBook3D() {
  return <div className="book-3d book-3d-open" aria-hidden="true">
    <Canvas
      orthographic
      camera={{ position: [0, 0.1, 10], zoom: 154 }}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true }}
      resize={{ scroll: false }}
    >
      <ambientLight intensity={0.92} />
      <directionalLight position={[2.4, 5.8, 7.5]} intensity={1.55} />
      <directionalLight position={[-4, -1, 4]} intensity={0.38} />
      <group rotation={[-0.065, 0, 0]} position={[0, 0.02, -0.12]} scale={[1.15, 1.05, 1]}>
        <group position={[-1.76, 0, 0]} rotation={[0, -0.085, -0.008]}>
          <RoundedBox args={[3.36, 4.46, 0.27]} radius={0.04} smoothness={4} position={[-0.01, -0.005, -0.09]}><meshStandardMaterial color="#b1a68f" roughness={0.94} /></RoundedBox>
          <RoundedBox args={[0.075, 4.18, 0.20]} radius={0.018} smoothness={3} position={[-1.64, 0.01, 0.015]}><meshStandardMaterial color="#d0c4aa" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.10, 0.075, 0.20]} radius={0.018} smoothness={3} position={[-0.03, -2.16, 0.015]}><meshStandardMaterial color="#c7baa0" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.24, 4.31, 0.06]} radius={0.025} smoothness={3} position={[0.05, 0, 0.105]}><meshStandardMaterial color="#151719" roughness={0.88} /></RoundedBox>
        </group>
        <group position={[1.76, 0, 0]} rotation={[0, 0.085, 0.008]}>
          <RoundedBox args={[3.36, 4.46, 0.27]} radius={0.04} smoothness={4} position={[0.01, -0.005, -0.09]}><meshStandardMaterial color="#b1a68f" roughness={0.94} /></RoundedBox>
          <RoundedBox args={[0.075, 4.18, 0.20]} radius={0.018} smoothness={3} position={[1.64, 0.01, 0.015]}><meshStandardMaterial color="#d0c4aa" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.10, 0.075, 0.20]} radius={0.018} smoothness={3} position={[0.03, -2.16, 0.015]}><meshStandardMaterial color="#c7baa0" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.24, 4.31, 0.06]} radius={0.025} smoothness={3} position={[-0.05, 0, 0.105]}><meshStandardMaterial color="#131517" roughness={0.88} /></RoundedBox>
        </group>
        <RoundedBox args={[0.24, 4.36, 0.30]} radius={0.07} smoothness={4} position={[0, -0.01, -0.15]}><meshStandardMaterial color="#06080a" roughness={0.8} /></RoundedBox>
        <RoundedBox args={[0.07, 4.16, 0.13]} radius={0.02} smoothness={3} position={[-0.10, 0, 0.045]} rotation={[0, -0.17, 0]}><meshStandardMaterial color="#9f947f" roughness={0.95} /></RoundedBox>
        <RoundedBox args={[0.07, 4.16, 0.13]} radius={0.02} smoothness={3} position={[0.10, 0, 0.045]} rotation={[0, 0.17, 0]}><meshStandardMaterial color="#9f947f" roughness={0.95} /></RoundedBox>
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
  const [card, setCard] = useState<StudyCard | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [stats, setStats] = useState<DeckStats[]>([]);
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticRuntimeStatus | null>(null);
  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxRuntimeStatus | null>(null);
  const [initialRuntimeReady, setInitialRuntimeReady] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({ auto_play: true, volume: 1, playback_rate: 1 });
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
  useEffect(() => { void api.audioSettings().then(setAudioSettings); }, []);
  useEffect(() => { void loadJapaneseImeRuntime().catch(() => undefined); }, []);
  useEffect(() => {
    if (view !== "decks") return;
    let active = true;
    setLibraryStats(null);
    void api.libraryStats()
      .then((nextStats) => { if (active) setLibraryStats(nextStats); })
      .catch(() => { if (active) setLibraryStats(null); });
    return () => { active = false; };
  }, [view, decks]);
  useEffect(() => {
    if (view !== "decks") return;
    const scroller = homeScrollRef.current;
    if (!scroller) return;

    let unlockTimer: number | null = null;
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
        const canScrollUp = deltaY < 0 && bookRangeScroller.scrollTop > 2;
        const canScrollDown = deltaY > 0 && bookRangeScroller.scrollHeight - bookRangeScroller.clientHeight - bookRangeScroller.scrollTop > 2;
        if (canScrollUp || canScrollDown) return;
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

      if (currentIndex === 0) {
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
      homeShelfScrollTargetRef.current = null;
      unlock();
    };
  }, [view]);
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

  const openStudy = async (deck: DeckSummary, stage?: number) => {
    try {
      setSelected(deck);
      const started = await api.startStudy(deck.id, stage);
      setCard(started.card ?? null);
      setResult(started);
      setView("study");
    } catch (e) {
      setError(String(e));
    }
  };

  const openStats = async (deck: DeckSummary) => {
    setSelected(deck);
    setStats(await api.stats(deck.id));
    setView("stats");
  };

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
      await exitStudyForDeckNavigation(view, api.exitStudy);
      setCard(null);
      setResult(null);
      await refresh();
      setView("decks");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <main className={`app-shell ${view === "decks" ? "home-shell" : ""}`}>
      {view !== "study" && view !== "decks" && <header className="topbar">
        <button className="brand" onClick={() => void openDecks()}>
          <span className="brand-mark">鍛</span>
          <strong>TANREN</strong>
        </button>
        <div className="topbar-context">{view === "editor" || view === "stats" || view === "settings" ? VIEW_LABELS[view] : ""}</div>
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
              onStudy={openStudy}
              onStats={openStats}
            />
          </section>
          <section className="home-snap-section home-stats-section">
            <button
              type="button"
              className="home-guide-arrow home-guide-arrow--up"
              aria-label="책장으로 이동"
              onClick={() => scrollHomeSection(0)}
            />
            <LibraryStatsView stats={libraryStats} />
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
      {view === "study" && (card || result) && (
        <StudyView
          deckId={selected?.id ?? ""}
          card={card}
          result={result}
          setCard={setCard}
          setResult={setResult}
          audioSettings={audioSettings}
          onExit={openDecks}
        />
      )}
      {view === "stats" && selected && <DeckStatsView deck={selected} stats={stats} />}
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
            <p>책, 단어, 학습 기록, 통계와 설정을 하나의 <code>.tanren</code> 파일로 저장해요.</p>
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
          <div className="settings-control-row">
            <div><strong>자동 재생</strong><small>문제와 정답 음성을 자동으로 재생해요.</small></div>
            <button
              type="button"
              className={`settings-toggle ${audioSettings.auto_play ? "is-on" : ""}`}
              aria-pressed={audioSettings.auto_play}
              onClick={() => updateAudio({ ...audioSettings, auto_play: !audioSettings.auto_play })}
            ><span /></button>
          </div>
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

type BookWordSortKey = "position" | "term" | "reading" | "meaning" | "attempts";

function BookInlineWordManager({ deckId, onAdd, onImport, onEdit, onDelete }: {
  deckId: string;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (entry: EntryListRecord) => void;
  onDelete: (entry: EntryListRecord) => void;
}) {
  const [entries, setEntries] = useState<EntryListRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: BookWordSortKey; direction: "asc" | "desc" }>({ key: "position", direction: "asc" });
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
  const toggleSort = (key: BookWordSortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  const sortMark = (key: BookWordSortKey) => sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  const sortMarkBefore = (key: BookWordSortKey) => sort.key === key ? (sort.direction === "asc" ? "↑ " : "↓ ") : "";

  return <section className="book-inline-words" aria-label="단어 관리">
    <div className="book-inline-word-toolbar">
      <input
        className="home-create-input"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="단어 검색"
        aria-label="단어 검색"
      />
      <button className="settings-action-button book-inline-word-add" onClick={onAdd} aria-label="단어 추가">+</button>
      <button className="settings-action-button" onClick={onImport}>파일</button>
    </div>
    <div className={`book-inline-word-list ${loading || filteredEntries.length === 0 ? "is-empty" : ""}`} ref={listRef}>
      <div className="book-inline-word-row book-inline-word-header" role="row">
        <button type="button" className="ghost book-inline-word-sort" onClick={() => toggleSort("position")}>번호{sortMark("position")}</button>
        <button type="button" className="ghost book-inline-word-sort" onClick={() => toggleSort("term")}>단어{sortMark("term")}</button>
        <button type="button" className="ghost book-inline-word-sort" onClick={() => toggleSort("reading")}>발음{sortMark("reading")}</button>
        <button type="button" className="ghost book-inline-word-sort" onClick={() => toggleSort("meaning")}>뜻{sortMark("meaning")}</button>
        <button type="button" className="ghost book-inline-word-sort is-numeric" onClick={() => toggleSort("attempts")}>{sortMarkBefore("attempts")}시도</button>
        <span className="book-inline-word-settings-head">편집</span>
        <span className="book-inline-word-delete-head">삭제</span>
      </div>
      {loading ? <div className="book-inline-word-empty">불러오는 중</div>
        : filteredEntries.length === 0 ? <div className="book-inline-word-empty">{entries.length === 0 ? "아직 단어가 없어요." : "검색 결과가 없어요."}</div>
          : sortedEntries.map((entry) => <div className="book-inline-word-row" key={entry.id} role="row">
            <span className="book-inline-word-number">{(entryNumbers.get(entry.id) ?? 0).toLocaleString("ko-KR")}</span>
            <strong>{entry.term}</strong>
            <span className="book-inline-word-reading">{entry.reading || "—"}</span>
            <span className="book-inline-word-meaning">{entry.meanings.join(" / ")}</span>
            <span className="book-inline-word-attempts">{entry.attempts.toLocaleString("ko-KR")}회</span>
            <button type="button" className="book-inline-word-settings" onClick={() => onEdit(entry)} aria-label={`${entry.term} 편집`} title="단어 편집">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 20h4.2L19 9.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z" />
                <path d="m13.8 6 4.2 4.2" />
              </svg>
            </button>
            <button type="button" className="book-inline-word-delete" onClick={() => onDelete(entry)} aria-label={`${entry.term} 삭제`} title="단어 삭제">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16" />
                <path d="M9 7V4h6v3" />
                <path d="m7 7 1 13h8l1-13" />
                <path d="M10 11v5M14 11v5" />
              </svg>
            </button>
          </div>)}
    </div>
  </section>;
}

function DeckList({ decks, onRefresh, onEdit, onStudy, onStats }: {
  decks: DeckSummary[];
  onRefresh: () => Promise<void>;
  onEdit: (d: DeckSummary) => void;
  onStudy: (d: DeckSummary, stage?: number) => void;
  onStats: (d: DeckSummary) => void;
}) {
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [openedDeckId, setOpenedDeckId] = useState<string | null>(null);
  const [bookOpenCycle, setBookOpenCycle] = useState(0);
  const [bookSettled, setBookSettled] = useState(false);
  const [bookPanel, setBookPanel] = useState<"study" | "words" | "stats">("study");
  const [bookEntries, setBookEntries] = useState<EntryRecord[]>([]);
  const [bookStats, setBookStats] = useState<DeckStats[] | null>(null);
  const [bookPanelLoading, setBookPanelLoading] = useState(false);
  const [stageSchedules, setStageSchedules] = useState<Record<number, StageScheduleSummary>>({});
  const [wordSearch, setWordSearch] = useState("");
  const [wordDialog, setWordDialog] = useState<"single" | "bulk" | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<EntryListRecord | null>(null);
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false);
  const [singleTerm, setSingleTerm] = useState("");
  const [singleMeaning, setSingleMeaning] = useState("");
  const [singleReading, setSingleReading] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [wordMessage, setWordMessage] = useState("");
  const [wordSaving, setWordSaving] = useState(false);
  const reduceMotion = useReducedMotion();
  const flipBookRef = useRef<any>(null);
  const skipDeleteConfirmDeckIdsRef = useRef(new Set<string>());
  const flutterTimerRef = useRef<number | null>(null);
  const flutteringRef = useRef(false);
  const activeBookSessionRef = useRef("");
  const flutterRetryRef = useRef(0);
  const flutterStartedSessionRef = useRef("");
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
  const filteredBookEntries = wordSearch.trim()
    ? bookEntries.filter((entry) => {
      const query = wordSearch.trim().toLocaleLowerCase();
      return entry.term.toLocaleLowerCase().includes(query)
        || (entry.reading ?? "").toLocaleLowerCase().includes(query)
        || entry.meanings.some((meaning) => meaning.toLocaleLowerCase().includes(query));
    })
    : bookEntries;
  const parsedBulkEntries = parseEntryText(bulkText);
  const bookSessionKey = openedDeck ? `${openedDeck.id}:${bookOpenCycle}` : "";
  activeBookSessionRef.current = bookSessionKey;

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
  }, [openedDeck?.id, openedDeck?.entry_count, openedDeck?.current_stage, openedDeck?.total_stage_count]);

  const clearFlutterTimer = () => {
    if (flutterTimerRef.current !== null) window.clearTimeout(flutterTimerRef.current);
    flutterTimerRef.current = null;
  };

  const scheduleBookFlutter = (sessionKey: string, delayMs: number) => {
    clearFlutterTimer();
    flutterTimerRef.current = window.setTimeout(() => {
      if (!sessionKey || activeBookSessionRef.current !== sessionKey || reduceMotion) return;
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
      pageFlip.flipNext("top");
    }, delayMs);
  };

  const beginBookFlutter = (sessionKey: string) => {
    if (reduceMotion || bookSettled || !sessionKey || activeBookSessionRef.current !== sessionKey) return;
    if (flutterStartedSessionRef.current === sessionKey) return;
    flutterStartedSessionRef.current = sessionKey;
    flutterRetryRef.current = 0;
    flutteringRef.current = true;
    setBookSettled(false);
    scheduleBookFlutter(sessionKey, 32);
  };

  const closeOpenedBook = () => {
    activeBookSessionRef.current = "";
    clearFlutterTimer();
    flutteringRef.current = false;
    flutterRetryRef.current = 0;
    flutterStartedSessionRef.current = "";
    setBookSettled(false);
    setBookPanel("study");
    setWordDialog(null);
    setEditingEntryId(null);
    setDeleteCandidate(null);
    setSkipDeleteConfirm(false);
    setWordMessage("");
    setOpenedDeckId(null);
  };

  const openWordPanel = async () => {
    if (!openedDeck) return;
    setBookPanel("words");
    setWordMessage("");
    setBookPanelLoading(true);
    try {
      setBookEntries(await api.listEntries(openedDeck.id));
    } finally {
      setBookPanelLoading(false);
    }
  };

  const openStatsPanel = async () => {
    if (!openedDeck) return;
    setBookPanel("stats");
    setBookPanelLoading(true);
    try {
      setBookStats(await api.stats(openedDeck.id));
    } finally {
      setBookPanelLoading(false);
    }
  };

  const refreshBookEntries = async (deckId: string, scrollToBottom = false) => {
    if (bookPanel === "words") setBookEntries(await api.listEntries(deckId));
    await onRefresh();
    window.dispatchEvent(new CustomEvent("tanren:deck-entries-changed", { detail: { deckId, scrollToBottom } }));
  };

  const openAddWordDialog = () => {
    setEditingEntryId(null);
    setSingleTerm("");
    setSingleMeaning("");
    setSingleReading("");
    setWordMessage("");
    setWordDialog("single");
  };

  const openEditWordDialog = (entry: EntryListRecord) => {
    setEditingEntryId(entry.id);
    setSingleTerm(entry.term);
    setSingleMeaning(entry.meanings.join(" / "));
    setSingleReading(entry.reading ?? "");
    setWordMessage("");
    setWordDialog("single");
  };

  const openImportWordDialog = () => {
    setEditingEntryId(null);
    setWordMessage("");
    setWordDialog("bulk");
  };

  const closeWordDialog = () => {
    setWordDialog(null);
    setEditingEntryId(null);
  };

  const deleteWord = async (entry: EntryListRecord) => {
    if (!openedDeck || wordSaving) return;
    setWordSaving(true);
    try {
      await api.deleteEntry(openedDeck.id, entry.id);
      setDeleteCandidate(null);
      setSkipDeleteConfirm(false);
      await refreshBookEntries(openedDeck.id);
    } finally {
      setWordSaving(false);
    }
  };

  const openDeleteWordDialog = (entry: EntryListRecord) => {
    if (!openedDeck) return;
    if (skipDeleteConfirmDeckIdsRef.current.has(openedDeck.id)) {
      void deleteWord(entry);
      return;
    }
    setSkipDeleteConfirm(false);
    setDeleteCandidate(entry);
  };

  const confirmDeleteWord = async () => {
    if (!openedDeck || !deleteCandidate) return;
    if (skipDeleteConfirm) skipDeleteConfirmDeckIdsRef.current.add(openedDeck.id);
    await deleteWord(deleteCandidate);
  };

  useEffect(() => {
    if ((!wordDialog && !deleteCandidate) || wordSaving) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (deleteCandidate) {
        setDeleteCandidate(null);
        setSkipDeleteConfirm(false);
      } else {
        closeWordDialog();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [wordDialog, deleteCandidate, wordSaving]);

  const addSingleEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!openedDeck || !singleTerm.trim() || !singleMeaning.trim() || wordSaving) return;
    setWordSaving(true);
    try {
      const entry = {
        term: singleTerm.trim(),
        meanings: singleMeaning.split("/").map((value) => value.trim()).filter(Boolean),
        reading: singleReading.trim() || undefined,
      };
      const result = editingEntryId
        ? null
        : await api.importEntries(openedDeck.id, [entry]);
      if (editingEntryId) await api.updateEntry(openedDeck.id, editingEntryId, entry);
      setSingleTerm("");
      setSingleMeaning("");
      setSingleReading("");
      setWordDialog(null);
      setEditingEntryId(null);
      setWordMessage("");
      await refreshBookEntries(openedDeck.id, Boolean(result?.inserted));
    } finally {
      setWordSaving(false);
    }
  };

  const addBulkEntries = async () => {
    if (!openedDeck || parsedBulkEntries.entries.length === 0 || wordSaving) return;
    setWordSaving(true);
    try {
      const result = await api.importEntries(openedDeck.id, parsedBulkEntries.entries);
      setWordMessage("");
      setBulkText("");
      setWordDialog(null);
      await refreshBookEntries(openedDeck.id, result.inserted > 0);
    } finally {
      setWordSaving(false);
    }
  };
  useEffect(() => {
    clearFlutterTimer();
    flutteringRef.current = false;
    flutterRetryRef.current = 0;
    flutterStartedSessionRef.current = "";
    setBookSettled(Boolean(openedDeckId && reduceMotion));
    if (openedDeckId && !reduceMotion && bookSessionKey) {
      flutterTimerRef.current = window.setTimeout(() => beginBookFlutter(bookSessionKey), 120);
    }
    return () => {
      clearFlutterTimer();
      flutteringRef.current = false;
    };
  }, [openedDeckId, bookOpenCycle, reduceMotion]);
  const continueBookFlutter = (pageIndex: number, sessionKey: string) => {
    if (activeBookSessionRef.current !== sessionKey) return;
    if (reduceMotion || !flutteringRef.current || pageIndex >= BOOK_CONTENT_PAGE) {
      flutteringRef.current = false;
      if (pageIndex >= BOOK_CONTENT_PAGE) setBookSettled(true);
      return;
    }
    scheduleBookFlutter(sessionKey, 4);
  };
  return <section className={`content home-content ${openedDeck ? "is-book-open" : ""}`}>
    <AnimatePresence initial={false} mode="popLayout">
      {openedDeck ? <motion.section
        key={`opened-${openedDeck.id}-${bookOpenCycle}`}
        className={`open-book-stage ${bookSettled ? "is-settled" : ""}`}
        aria-label={`${openedDeck.name} deck`}
        initial={reduceMotion ? false : { opacity: 0, scale: .965, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .975, y: 8 }}
        transition={reduceMotion ? { duration: .01 } : { duration: .28, ease: [0.22, 1, 0.36, 1] }}
      >
        <OpenBook3D />
        <div className="book-flip-stack">
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
            maxWidth={620}
            minHeight={500}
            maxHeight={720}
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
            onInit={() => beginBookFlutter(bookSessionKey)}
            onFlip={(event) => continueBookFlutter(Number(event.data), bookSessionKey)}
          >
            <FlipPage className="book-cover-page book-shelf-cover-page" hard>
              <span className="ebook-cover">
                <span className="ebook-cover-face">
                  <span className="ebook-volume">Vol. {String(decks.findIndex((deck) => deck.id === openedDeck.id) + 1).padStart(2, "0")}</span>
                  <span className="ebook-rule" />
                  <span className="ebook-language">日本語</span>
                  <strong title={openedDeck.name}>{openedDeck.name}</strong>
                  <span className="ebook-bottom">
                    <span className="ebook-meta">{openedDeck.entry_count.toLocaleString("en-US")} Words</span>
                    <span className="ebook-current">
                      <span className="ebook-current-stage">{openedDeck.current_stage}단계</span>
                      <span className="ebook-current-range">{formatStudyRangeLabel(openedDeck.active_range, " - ")}</span>
                    </span>
                    <span className="ebook-progress" aria-hidden="true"><i style={{ width: `${openedDeck.total_stage_count === 0 ? 0 : Math.min(100, (openedDeck.completed_stage_count / openedDeck.total_stage_count) * 100)}%` }} /></span>
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
                <button className="book-close ghost" onClick={closeOpenedBook} aria-label="책장" title="책장" />
                <button className="book-top-stats ghost" onClick={() => void openStatsPanel()}>통계</button>
                </div>
                <div className="book-title-summary">
                  <div className="book-title-page">
                    <span className="book-language">
                      {openedDeck.target_language === "ja-JP" ? "日本語"
                        : openedDeck.target_language === "ko-KR" ? "한국어"
                          : openedDeck.target_language === "en-US" ? "English"
                            : openedDeck.target_language}
                    </span>
                    <h2>{openedDeck.name}</h2>
                  </div>
                  <dl className="book-stats">
                    <div><dt>Words</dt><dd>{openedDeck.entry_count.toLocaleString("ko-KR")}개</dd></div>
                    <div><dt>단계</dt><dd>{openedDeck.total_stage_count.toLocaleString("ko-KR")}개</dd></div>
                  </dl>
                </div>
                <BookInlineWordManager
                  deckId={openedDeck.id}
                  onAdd={openAddWordDialog}
                  onImport={openImportWordDialog}
                  onEdit={openEditWordDialog}
                  onDelete={openDeleteWordDialog}
                />
              </div>
            </FlipPage>

            <FlipPage className="book-inside-page book-inside-right">
              <div className="book-page-inner book-page-inner-right">
                <div className="range-heading">
                  <div><span>CONTENTS</span><strong>학습 구간</strong></div>
                </div>
                <div className="book-range-scroll" aria-label={`${openedDeck.name} study ranges`}>
                  <div className="book-stage-list">
                    {Array.from({ length: openedDeck.total_stage_count }, (_, index) => index + 1).map((stage) => {
                      const current = stage === openedDeck.current_stage;
                      const fallbackRange = openedDeck.study_ranges[stage - 1];
                      const schedule = stageSchedules[stage];
                      const range = schedule?.study_range ?? fallbackRange;
                      const completed = Boolean(schedule?.completed);
                      return <div className={`book-stage-group ${current ? "is-current-stage" : ""} ${completed ? "is-completed-stage" : ""}`} key={stage}>
                        <button
                          type="button"
                          className="ghost book-stage-card"
                          onClick={() => onStudy(openedDeck, stage)}
                        >
                          <strong className="book-stage-title">{stage.toLocaleString("ko-KR")}단계</strong>

                          <span className="book-stage-middle">
                            <span className="book-stage-range" aria-label={`${stage}단계 학습 구간`}>
                              {range && <span
                                className={`book-stage-range-link ${schedule?.active ? "is-current" : ""}`}
                              >{formatStudyRangeLabel(range.label)}</span>}
                            </span>
                          </span>
                          {completed && <span className="book-stage-complete" aria-label="클리어 완료">✓</span>}
                        </button>
                      </div>;
                    })}
                  </div>
                </div>
            </div>
            </FlipPage>

            <FlipPage className="book-back-page" hard>
              <span>鍛錬</span>
            </FlipPage>
          </HTMLFlipBook>
        </div>

        {bookPanel !== "study" && <div
          className="book-workspace-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !wordDialog) setBookPanel("study");
          }}
        >
          <div className={`book-workspace ${bookPanel === "stats" ? "is-stats" : "is-words"}`} role="dialog" aria-modal="true" aria-label={bookPanel === "words" ? `${openedDeck.name} 단어 관리` : `${openedDeck.name} 통계`}>
            <header className="book-workspace-header">
              <div className="book-workspace-title">
                <div><span>{bookPanel === "words" ? "WORDS" : "STATISTICS"}</span><strong>{openedDeck.name}</strong></div>
              </div>
              <div className="book-workspace-actions">
                {bookPanel === "words" && <>
                  <button className="ghost" onClick={openAddWordDialog}>+ 단어 추가</button>
                  <button className="ghost" onClick={openImportWordDialog}>파일에서 추가</button>
                </>}
                <button className="ghost book-workspace-close" aria-label="닫기" onClick={() => setBookPanel("study")}>×</button>
              </div>
            </header>

            {bookPanel === "words" ? <>
              <div className="book-word-toolbar">
                <label className="book-word-search">
                  <span aria-hidden="true">⌕</span>
                  <input value={wordSearch} onChange={(event) => setWordSearch(event.target.value)} placeholder="단어, 발음, 뜻 검색" aria-label="단어 검색" />
                </label>
                <span>{numberFormat.format(filteredBookEntries.length)} / {numberFormat.format(bookEntries.length)}개</span>
              </div>
              {wordMessage && <p className="book-word-message">{wordMessage}</p>}
              <div className="book-word-browser">
                <div className="book-word-row book-word-row-head" aria-hidden="true">
                  <span>#</span><span>단어</span><span>발음</span><span>뜻</span>
                </div>
                <div className="book-word-list">
                  {bookPanelLoading ? <div className="book-workspace-empty">단어를 불러오고 있어요.</div>
                    : filteredBookEntries.length === 0 ? <div className="book-workspace-empty">{bookEntries.length === 0 ? "아직 단어가 없어요." : "검색 결과가 없어요."}</div>
                      : filteredBookEntries.map((entry, index) => <div className="book-word-row" key={entry.id}>
                        <span>{String(index + 1).padStart(3, "0")}</span>
                        <strong>{entry.term}</strong>
                        <span className="book-word-reading">{entry.reading || "—"}</span>
                        <span className="book-word-meaning">{entry.meanings.join(" / ")}</span>
                      </div>)}
                </div>
              </div>
            </> : <div className="book-stats-workspace">
              {bookPanelLoading || !bookStats ? <div className="book-workspace-empty">통계를 불러오고 있어요.</div> : <DeckStatsView deck={openedDeck} stats={bookStats} />}
            </div>}

            {wordDialog && <div className="book-word-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !wordSaving) closeWordDialog(); }}>
              {wordDialog === "single" ? <form className="book-word-dialog" onSubmit={(event) => void addSingleEntry(event)}>
                <div className="book-word-dialog-head"><div><span>{editingEntryId ? "EDIT WORD" : "ADD WORD"}</span><h3>{editingEntryId ? "단어 편집" : "단어 추가"}</h3></div><button type="button" className="ghost" onClick={closeWordDialog}>×</button></div>
                <label><span>단어</span><input autoFocus value={singleTerm} onChange={(event) => setSingleTerm(event.target.value)} placeholder="例: 見据える" /></label>
                <label><span>발음 <small>선택</small></span><input value={singleReading} onChange={(event) => setSingleReading(event.target.value)} placeholder="みすえる" /></label>
                <label><span>뜻</span><input value={singleMeaning} onChange={(event) => setSingleMeaning(event.target.value)} placeholder="여러 뜻은 / 로 구분" /></label>
                <div className="book-word-dialog-actions"><button type="button" className="ghost" onClick={closeWordDialog}>취소</button><button disabled={wordSaving || !singleTerm.trim() || !singleMeaning.trim()}>{editingEntryId ? "저장" : "추가"}</button></div>
              </form> : <div className="book-word-dialog book-word-dialog-bulk">
                <div className="book-word-dialog-head"><div><span>IMPORT WORDS</span><h3>파일에서 추가</h3></div><button type="button" className="ghost" onClick={closeWordDialog}>×</button></div>
                <label className="book-word-file">
                  <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void file.text().then(setBulkText);
                  }} />
                  <span><strong>CSV · TSV · TXT</strong><small>파일을 선택하면 아래에서 미리 볼 수 있어요.</small></span>
                </label>
                <DeckEntryInput value={bulkText} onChange={setBulkText} compact />
                <div className="book-word-import-summary"><span>인식 {parsedBulkEntries.entries.length}개</span><span>확인 필요 {parsedBulkEntries.issues.length}개</span></div>
                <div className="book-word-dialog-actions"><button type="button" className="ghost" onClick={closeWordDialog}>취소</button><button disabled={wordSaving || parsedBulkEntries.entries.length === 0} onClick={() => void addBulkEntries()}>추가</button></div>
              </div>}
            </div>}
          </div>
        </div>}

        {bookPanel === "study" && wordDialog && <div className="book-word-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !wordSaving) closeWordDialog(); }}>
          {wordDialog === "single" ? <form className="book-word-dialog" onSubmit={(event) => void addSingleEntry(event)}>
            <div className="book-word-dialog-head"><div><span>{editingEntryId ? "EDIT WORD" : "ADD WORD"}</span><h3>{editingEntryId ? "단어 편집" : "단어 추가"}</h3></div><button type="button" className="ghost" onClick={closeWordDialog}>×</button></div>
            <label><span>단어</span><input autoFocus value={singleTerm} onChange={(event) => setSingleTerm(event.target.value)} placeholder="例: 見据える" /></label>
            <label><span>발음 <small>선택</small></span><input value={singleReading} onChange={(event) => setSingleReading(event.target.value)} placeholder="みすえる" /></label>
            <label><span>뜻</span><input value={singleMeaning} onChange={(event) => setSingleMeaning(event.target.value)} placeholder="여러 뜻은 / 로 구분" /></label>
            <div className="book-word-dialog-actions"><button type="button" className="ghost" onClick={closeWordDialog}>취소</button><button disabled={wordSaving || !singleTerm.trim() || !singleMeaning.trim()}>{editingEntryId ? "저장" : "추가"}</button></div>
          </form> : <div className="book-word-dialog book-word-dialog-bulk">
            <div className="book-word-dialog-head"><div><span>IMPORT WORDS</span><h3>파일에서 추가</h3></div><button type="button" className="ghost" onClick={closeWordDialog}>×</button></div>
            <label className="book-word-file">
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void file.text().then(setBulkText);
              }} />
              <span><strong>CSV · TSV · TXT</strong><small>파일을 선택하면 아래에서 미리 볼 수 있어요.</small></span>
            </label>
            <DeckEntryInput value={bulkText} onChange={setBulkText} compact />
            <div className="book-word-import-summary"><span>인식 {parsedBulkEntries.entries.length}개</span><span>확인 필요 {parsedBulkEntries.issues.length}개</span></div>
            <div className="book-word-dialog-actions"><button type="button" className="ghost" onClick={closeWordDialog}>취소</button><button disabled={wordSaving || parsedBulkEntries.entries.length === 0} onClick={() => void addBulkEntries()}>추가</button></div>
          </div>}
        </div>}

        {deleteCandidate && <div className="book-word-dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !wordSaving) {
            setDeleteCandidate(null);
            setSkipDeleteConfirm(false);
          }
        }}>
          <div className="book-word-dialog book-word-delete-dialog" role="dialog" aria-modal="true" aria-label={`${deleteCandidate.term} 삭제 확인`}>
            <div className="book-word-dialog-head">
              <div><span>DELETE WORD</span><h3>단어를 삭제할까요?</h3></div>
              <button type="button" className="ghost" onClick={() => { setDeleteCandidate(null); setSkipDeleteConfirm(false); }}>×</button>
            </div>
            <p><strong>{deleteCandidate.term}</strong> 단어를 이 책에서 삭제해요.</p>
            <label className="book-word-delete-skip">
              <input type="checkbox" checked={skipDeleteConfirm} onChange={(event) => setSkipDeleteConfirm(event.target.checked)} />
              <span>이 책에서는 더 이상 묻지 않기</span>
            </label>
            <div className="book-word-dialog-actions">
              <button type="button" className="ghost" onClick={() => { setDeleteCandidate(null); setSkipDeleteConfirm(false); }}>취소</button>
              <button type="button" className="danger" disabled={wordSaving} onClick={() => void confirmDeleteWord()}>삭제</button>
            </div>
          </div>
        </div>}
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
          <button className="add-deck-button" type="submit" aria-label="책 추가" title="책 추가" disabled={!name.trim()}><span aria-hidden="true">+</span></button>
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
                onClick={() => {
                  clearFlutterTimer();
                  flutteringRef.current = false;
                  flutterRetryRef.current = 0;
                  flutterStartedSessionRef.current = "";
                  setBookSettled(false);
                  setBookPanel("study");
                  setBookEntries([]);
                  setBookStats(null);
                  setWordSearch("");
                  setWordDialog(null);
                  setEditingEntryId(null);
                  setDeleteCandidate(null);
                  setSkipDeleteConfirm(false);
                  setWordMessage("");
                  setBookOpenCycle((cycle) => cycle + 1);
                  setOpenedDeckId(d.id);
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
                      <span className="ebook-meta">{d.entry_count.toLocaleString("en-US")} Words</span>
                      <span className="ebook-current">
                        <span className="ebook-current-stage">{d.current_stage}단계</span>
                        <span className="ebook-current-range">{formatStudyRangeLabel(d.active_range, " - ")}</span>
                      </span>
                      <span className="ebook-progress" aria-hidden="true"><i style={{ width: `${d.total_stage_count === 0 ? 0 : Math.min(100, (d.completed_stage_count / d.total_stage_count) * 100)}%` }} /></span>
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

const MemoDeckList = memo(DeckList, (previous, next) => previous.decks === next.decks);

function DeckEditor({ deck, onDone }: { deck: DeckSummary; onDone: () => Promise<void> }) {
  const [text, setText] = useState("見据える\t내다보다 / 전망하다\n躊躇う\t망설이다");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(deck.name);
  const [modes, setModes] = useState<StudyMode[]>(deck.enabled_modes);
  const importText = async () => {
    const parsed = parseEntryText(text);
    const result = await api.importEntries(deck.id, parsed.entries);
    const issueText = parsed.issues.length ? ` 확인이 필요한 항목이 ${parsed.issues.length}개 있어요: ${parsed.issues.map((issue) => `${issue.row}행 ${issue.message}`).join("; ")}` : "";
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
    <div className="section-heading"><div><h1>{name}</h1><p>단어를 붙여넣거나 CSV로 추가할 수 있어요.</p></div></div>
    <div className="deck-settings">
      <input value={name} maxLength={MAX_DECK_NAME_LENGTH} onChange={(event) => setName(event.target.value)} aria-label="책 이름" />
      <div className="mode-options">
        {(["reading", "listening", "writing"] as StudyMode[]).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} /> {STUDY_MODE_LABELS[mode]}</label>)}
        <label title="추가 예정"><input type="checkbox" disabled /> Speaking <span>(추가 예정)</span></label>
      </div>
      <div className="actions"><button disabled={!name.trim() || modes.length === 0} onClick={() => void save()}>저장하기</button><button className="ghost danger" onClick={() => void remove()}>삭제하기</button></div>
    </div>
    <DeckEntryInput value={text} onChange={setText} />
    <button onClick={importText}>단어 추가</button>
    {message && <p className="success">{message}</p>}
    <div className="editor-footer"><button className="ghost" onClick={() => void exportDeck()}>백업하기</button></div>
  </section>;
}

function StudyView({ deckId, card, result, setCard, setResult, audioSettings, onExit }: {
  deckId: string;
  card: StudyCard | null;
  result: SubmitResult | null;
  setCard: (c: StudyCard | null) => void;
  setResult: (r: SubmitResult | null) => void;
  audioSettings: AudioSettings;
  onExit: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [imeSegments, setImeSegments] = useState<JapaneseImeSegment[]>([]);
  const [imeCaret, setImeCaret] = useState(0);
  const [japaneseImeReady, setJapaneseImeReady] = useState(false);
  const [pitchLevels, setPitchLevels] = useState<PitchSelection>([]);
  const [pitchCursor, setPitchCursor] = useState(0);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(performance.now());
  const [submittedPitch, setSubmittedPitch] = useState<PitchSelection | null>(null);
  const [submittedPitchQuestion, setSubmittedPitchQuestion] = useState<PitchQuestion | null>(null);
  const shownAt = useRef(performance.now());
  const answerRef = useRef("");
  const firstInputAt = useRef<number | null>(null);
  const lastActivityAt = useRef<number | null>(null);
  const interkeyGaps = useRef<number[]>([]);
  const composing = useRef(false);
  const compositionStartedAt = useRef<number | null>(null);
  const compositionEndedAt = useRef<number | null>(null);
  const imeCompositionMs = useRef(0);
  const recallTimer = useRef<number | null>(null);
  const completionTimer = useRef<number | null>(null);
  const completionDeadlineAt = useRef<number | null>(null);
  const timeoutSent = useRef(false);
  const studyActivityStartedAt = useRef<number | null>(null);
  const studyActivityMode = useRef<StudyMode | null>(card?.mode ?? null);
  const pendingStudyActivity = useRef(new Map<StudyMode | "all", number>());
  const inputRef = useRef<HTMLInputElement>(null);
  const japaneseImeRef = useRef<JapaneseImeSession | null>(null);
  const imeCaretRef = useRef(0);
  const imeCandidateListRef = useRef<HTMLDivElement>(null);
  const pitchButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pitchQuestion = result?.pitch ?? null;
  const timerActive = activeCardTimerRuns(card, result);
  const reduceMotion = useReducedMotion();
  const usesJapaneseIme = card?.answer_language === "ja-JP";
  const imePreedit = imeSegments.map((segment) => segment.text).join("");
  const imeHasInternalCaret = imeSegments.some((segment) => segment.kind === "yomi" && segment.caretOffset != null);

  const playAudio = (path: string) => {
    const audio = new Audio(convertFileSrc(path));
    audio.volume = audioSettings.volume;
    audio.playbackRate = audioSettings.playback_rate;
    void audio.play();
    return audio;
  };

  const studyViewIsActive = () => document.visibilityState === "visible" && document.hasFocus();

  const collectStudyActivity = (stop = false) => {
    const now = performance.now();
    if (studyActivityStartedAt.current != null) {
      const elapsed = Math.max(0, now - studyActivityStartedAt.current);
      const key = studyActivityMode.current ?? "all";
      pendingStudyActivity.current.set(key, (pendingStudyActivity.current.get(key) ?? 0) + elapsed);
    }
    studyActivityStartedAt.current = !stop && studyViewIsActive() ? now : null;
  };

  const flushStudyActivity = async (stop = false) => {
    collectStudyActivity(stop);
    const pending = [...pendingStudyActivity.current.entries()];
    pendingStudyActivity.current.clear();
    await Promise.all(pending.map(async ([mode, duration]) => {
      const durationMs = Math.round(duration);
      if (durationMs <= 0) return;
      try {
        await api.recordStudyActivity(deckId, mode === "all" ? null : mode, durationMs);
      } catch {
        pendingStudyActivity.current.set(mode, (pendingStudyActivity.current.get(mode) ?? 0) + duration);
      }
    }));
  };

  useEffect(() => {
    if (studyViewIsActive()) studyActivityStartedAt.current = performance.now();
    const syncActiveState = () => {
      if (studyViewIsActive()) {
        if (studyActivityStartedAt.current == null) studyActivityStartedAt.current = performance.now();
      } else {
        void flushStudyActivity(true);
      }
    };
    const interval = window.setInterval(() => void flushStudyActivity(false), 5_000);
    window.addEventListener("focus", syncActiveState);
    window.addEventListener("blur", syncActiveState);
    document.addEventListener("visibilitychange", syncActiveState);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", syncActiveState);
      window.removeEventListener("blur", syncActiveState);
      document.removeEventListener("visibilitychange", syncActiveState);
      void flushStudyActivity(true);
    };
  }, []);

  useEffect(() => {
    const nextMode = card?.mode ?? studyActivityMode.current;
    if (nextMode === studyActivityMode.current) return;
    collectStudyActivity(false);
    studyActivityMode.current = nextMode;
  }, [card?.mode]);

  const exitStudy = async () => {
    await flushStudyActivity(true);
    await onExit();
  };

  const setImeCaretPosition = (next: number) => {
    const bounded = Math.max(0, Math.min(next, answerRef.current.length));
    imeCaretRef.current = bounded;
    setImeCaret(bounded);
  };

  const beginJapaneseComposition = () => {
    if (composing.current) return;
    composing.current = true;
    compositionStartedAt.current = performance.now();
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
    completionTimer.current = null;
    completionDeadlineAt.current = null;
  };

  const endJapaneseComposition = () => {
    if (!composing.current) return;
    const now = performance.now();
    composing.current = false;
    if (compositionStartedAt.current != null) imeCompositionMs.current += now - compositionStartedAt.current;
    compositionStartedAt.current = null;
    compositionEndedAt.current = now;
    lastActivityAt.current = now;
  };

  const insertJapaneseText = (text: string) => {
    if (!text) return;
    const current = answerRef.current;
    const caret = imeCaretRef.current;
    const next = `${current.slice(0, caret)}${text}${current.slice(caret)}`;
    handleInput(next, false);
    setImeCaretPosition(caret + text.length);
  };

  const previousTextIndex = (value: string, index: number) => {
    let next = Math.max(0, index - 1);
    if (next > 0) {
      const code = value.charCodeAt(next);
      const previous = value.charCodeAt(next - 1);
      if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) next -= 1;
    }
    return next;
  };

  const nextTextIndex = (value: string, index: number) => {
    let next = Math.min(value.length, index + 1);
    if (index < value.length - 1) {
      const code = value.charCodeAt(index);
      const following = value.charCodeAt(index + 1);
      if (code >= 0xd800 && code <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) next += 1;
    }
    return next;
  };

  const handleJapaneseHostKey = (name: string) => {
    const current = answerRef.current;
    const caret = imeCaretRef.current;
    if (name === "Backspace") {
      if (caret <= 0) return;
      const start = previousTextIndex(current, caret);
      const next = `${current.slice(0, start)}${current.slice(caret)}`;
      setImeCaretPosition(start);
      handleInput(next, false);
    } else if (name === "Delete") {
      if (caret >= current.length) return;
      const end = nextTextIndex(current, caret);
      handleInput(`${current.slice(0, caret)}${current.slice(end)}`, false);
    } else if (name === "ArrowLeft") {
      setImeCaretPosition(previousTextIndex(current, caret));
    } else if (name === "ArrowRight") {
      setImeCaretPosition(nextTextIndex(current, caret));
    } else if (name === "Home") {
      setImeCaretPosition(0);
    } else if (name === "End") {
      setImeCaretPosition(current.length);
    }
  };

  const moveJapaneseCaretFromPointer = (clientX: number, element: HTMLElement) => {
    if (imeSegments.length > 0) return;
    const value = answerRef.current;
    if (!value) {
      setImeCaretPosition(0);
      return;
    }

    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    const rect = element.getBoundingClientRect();
    const totalWidth = context.measureText(value).width;
    const startX = rect.left + (rect.width - totalWidth) / 2;
    const target = Math.max(0, Math.min(totalWidth, clientX - startX));
    let bestIndex = 0;
    let bestDistance = Math.abs(target);
    let index = 0;
    while (index < value.length) {
      index = nextTextIndex(value, index);
      const distance = Math.abs(context.measureText(value.slice(0, index)).width - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    setImeCaretPosition(bestIndex);
  };

  const recordJapaneseKeyActivity = (event: ReturnType<typeof japaneseImeKeyTap>) => {
    if (!japaneseImeKeyStartsInput(event)) return;
    const now = performance.now();
    if (firstInputAt.current == null) {
      firstInputAt.current = now;
      if (recallTimer.current) window.clearTimeout(recallTimer.current);
    }
    if (lastActivityAt.current != null) interkeyGaps.current.push(Math.round(now - lastActivityAt.current));
    lastActivityAt.current = now;
  };

  useEffect(() => {
    if (!timerActive) return;
    japaneseImeRef.current?.reset();
    japaneseImeRef.current?.setActive(false);
    japaneseImeRef.current = null;
    shownAt.current = performance.now();
    answerRef.current = "";
    firstInputAt.current = null;
    lastActivityAt.current = null;
    interkeyGaps.current = [];
    composing.current = false;
    compositionStartedAt.current = null;
    compositionEndedAt.current = null;
    imeCompositionMs.current = 0;
    timeoutSent.current = false;
    setAnswer("");
    setImeSegments([]);
    imeCaretRef.current = 0;
    setImeCaret(0);
    setJapaneseImeReady(false);
    setSubmittedPitch(null);
    setSubmittedPitchQuestion(null);
    setInputWarning(null);
    setTimerNow(performance.now());
    let current = true;
    let nativeModeRetry: number | null = null;
    const frame = requestAnimationFrame(() => {
      if (!card) return;
      if (card.answer_language === "ja-JP") {
        void loadJapaneseImeRuntime()
          .then((runtime) => {
            if (!current) return;
            const session = runtime.createSession({
              show: (segments) => {
                if (!current) return;
                beginJapaneseComposition();
                setImeSegments(segments);
              },
              hide: () => {
                if (!current) return;
                setImeSegments([]);
                endJapaneseComposition();
              },
              commit: (text) => {
                if (!current) return;
                // Hechima's commit() clears its internal composition but does not
                // guarantee a following hide() callback. Clear TANREN's mirrored
                // preedit state here before inserting the committed text so the
                // same surface text is never rendered twice.
                setImeSegments([]);
                endJapaneseComposition();
                insertJapaneseText(text);
              },
              hostKey: (name) => {
                if (!current) return;
                handleJapaneseHostKey(name);
              },
            });
            if (!current) {
              session.reset();
              session.setActive(false);
              return;
            }
            session.setActive(true);
            japaneseImeRef.current = session;
            setJapaneseImeReady(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          })
          .catch(() => {
            if (current) setInputWarning("내장 일본어 입력기를 불러오지 못했어요.");
          });
        return;
      }

      inputRef.current?.focus();
      void api.activateInputProfile(card.answer_language)
        .then((warning) => {
          if (!current) return;
          setInputWarning(warning);
          nativeModeRetry = window.setTimeout(() => {
            void api.activateInputProfile(card.answer_language)
              .then((retryWarning) => { if (current) setInputWarning(retryWarning); })
              .catch(() => { if (current) setInputWarning("입력 언어를 자동으로 바꾸지 못했어요."); });
          }, 100);
        })
        .catch(() => {
          if (current) setInputWarning("입력 언어를 자동으로 바꾸지 못했어요.");
        });
    });
    return () => {
      current = false;
      cancelAnimationFrame(frame);
      if (nativeModeRetry != null) window.clearTimeout(nativeModeRetry);
      japaneseImeRef.current?.reset();
      japaneseImeRef.current?.setActive(false);
      japaneseImeRef.current = null;
    };
  }, [card?.variant_id, card?.answer_language, timerActive]);

  useEffect(() => {
    if (!timerActive || !card) return;
    let frame = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      if (now - lastPaint >= 48) {
        setTimerNow(now);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, timerActive]);

  useEffect(() => {
    if (!pitchQuestion) {
      setPitchLevels([]);
      setPitchCursor(0);
      pitchButtonRefs.current = [];
      return;
    }
    setPitchLevels(emptyPitchSelection(pitchQuestion.morae.length));
    setPitchCursor(0);
    pitchButtonRefs.current = [];
    const frame = requestAnimationFrame(() => pitchButtonRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, pitchQuestion?.reading, pitchQuestion?.morae.join("|")]);

  useEffect(() => {
    if (recallTimer.current) window.clearTimeout(recallTimer.current);
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
    if (timerActive && card) {
      recallTimer.current = window.setTimeout(async () => {
        if (recallHasTimedOut(firstInputAt.current) && !timeoutSent.current) {
          timeoutSent.current = true;
          advance(await api.timeoutCurrent(card.variant_id, "recall", "", card.recall_timeout_ms, 0));
        }
      }, card.recall_timeout_ms);
    }
    return () => {
      if (recallTimer.current) window.clearTimeout(recallTimer.current);
      if (completionTimer.current) window.clearTimeout(completionTimer.current);
    };
  }, [card?.variant_id, timerActive]);

  useEffect(() => {
    if (!audioSettings.auto_play || !timerActive || !card || card.mode !== "listening") return;
    if (card.audio_path) {
      const audio = playAudio(card.audio_path);
      return () => { audio.pause(); };
    }
  }, [card?.variant_id, timerActive, audioSettings.auto_play, audioSettings.volume, audioSettings.playback_rate]);

  const advance = (r: SubmitResult) => {
    setResult(r);
    setCard(cardAfterResult(card, r));
  };

  const submit = async () => {
    if (!card) return;
    if (audioSettings.auto_play && card.audio_path && shouldAutoPlayAfterWrittenAnswer(card.mode)) {
      playAudio(card.audio_path);
    }
    const now = performance.now();
    const recall = firstInputAt.current == null ? Math.round(now - shownAt.current) : Math.round(firstInputAt.current - shownAt.current);
    const typing = firstInputAt.current == null ? 0 : Math.round(now - firstInputAt.current);
    advance(await api.submitAnswer(
      card.variant_id,
      answer,
      recall,
      typing,
      interkeyGaps.current,
      Math.round(imeCompositionMs.current),
    ));
  };

  const handleInput = (value: string, recordKeyActivity = true) => {
    const now = performance.now();
    if (!isMeaningfulInput(value) && completionTimer.current) {
      window.clearTimeout(completionTimer.current);
      completionTimer.current = null;
      completionDeadlineAt.current = null;
    }
    const nextFirstInputAt = firstMeaningfulInputAt(firstInputAt.current, value, now);
    if (firstInputAt.current == null && nextFirstInputAt != null) {
      firstInputAt.current = nextFirstInputAt;
      if (recallTimer.current) window.clearTimeout(recallTimer.current);
    }
    if (isMeaningfulInput(value) && !composing.current) {
      if (recordKeyActivity && lastActivityAt.current != null) interkeyGaps.current.push(Math.round(now - lastActivityAt.current));
      lastActivityAt.current = now;
      scheduleCompletionTimeout(value);
    }
    answerRef.current = value;
    setAnswer(value);
  };

  const scheduleCompletionTimeout = (partialAnswer: string) => {
    if (!card || !timerActive) return;
    const delay = completionDelayMs(card.completion_idle_ms, composing.current, partialAnswer, compositionEndedAt.current, performance.now());
    if (delay == null) return;
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
    const variantId = card.variant_id;
    const scheduledAt = performance.now();
    completionDeadlineAt.current = scheduledAt + delay;
    completionTimer.current = window.setTimeout(async () => {
      if (composing.current || timeoutSent.current) return;
      timeoutSent.current = true;
      completionDeadlineAt.current = null;
      const now = performance.now();
      const typing = firstInputAt.current == null ? 0 : Math.round(now - firstInputAt.current);
      advance(await api.timeoutCurrent(variantId, "completion", partialAnswer, Math.round(now - shownAt.current), typing));
    }, delay);
  };

  const nextFromReview = async () => advance(await api.continueReview());
  const review = result?.status === "review" || result?.status === "fail";
  const ambiguous = result?.status === "ambiguous";

  useEffect(() => {
    if (!card || !review || pitchQuestion) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, review, pitchQuestion]);

  const submitPitchContour = async () => {
    if (!card) return;
    const contour = pitchSubmission(pitchLevels);
    if (!contour) return;
    setSubmittedPitch([...pitchLevels]);
    setSubmittedPitchQuestion(pitchQuestion);
    advance(await api.submitPitch(card.variant_id, contour));
  };

  const focusPitch = (index: number) => {
    const bounded = Math.max(0, Math.min(index, pitchLevels.length - 1));
    setPitchCursor(bounded);
    requestAnimationFrame(() => pitchButtonRefs.current[bounded]?.focus());
  };

  const choosePitch = (index: number, level: PitchLevel, advanceCursor = false) => {
    setPitchLevels((current) => setPitchLevel(current, index, level));
    focusPitch(advanceCursor ? Math.min(index + 1, pitchLevels.length - 1) : index);
  };

  const pitchKeydown = async (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusPitch(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusPitch(index + 1);
    } else if (e.key === "ArrowUp" || e.key.toLowerCase() === "h" || e.key === "1") {
      e.preventDefault();
      choosePitch(index, 1, true);
    } else if (e.key === "ArrowDown" || e.key.toLowerCase() === "l" || e.key === "0") {
      e.preventDefault();
      choosePitch(index, 0, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      await submitPitchContour();
    }
  };

  const playCachedAnswer = () => {
    if (!card?.audio_path) return;
    playAudio(card.audio_path);
  };

  const keydown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (!card) return;
    if (usesJapaneseIme) {
      const session = japaneseImeRef.current;
      if (!session || !japaneseImeReady) {
        e.preventDefault();
        return;
      }
      const tap = japaneseImeKeyTap(e.nativeEvent);
      recordJapaneseKeyActivity(tap);
      if (session.feed(tap)) {
        e.preventDefault();
        return;
      }
      if (!tap.ctrlKey && !tap.altKey && !tap.metaKey) {
        if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          handleJapaneseHostKey(e.key);
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          insertJapaneseText(e.shiftKey ? " " : "　");
          return;
        }
        if (tap.key.length === 1) {
          e.preventDefault();
          insertJapaneseText(tap.key);
          return;
        }
      }
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const action = enterAction(result);
    if (action === "review") {
      await nextFromReview();
    } else if (action === "submit") {
      await submit();
    }
  };

  const keyup = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!usesJapaneseIme || !japaneseImeReady) return;
    if (japaneseImeRef.current?.feedUp(japaneseImeKeyTap(e.nativeEvent))) e.preventDefault();
  };

  const focusedImeSegment = imeSegments.find((segment) => segment.kind === "focus" && segment.candidates?.length);
  const imeCandidates = focusedImeSegment?.candidates ?? [];
  const imeCandidateIndex = focusedImeSegment?.candidateIndex ?? 0;
  const selectJapaneseCandidate = (index: number) => {
    if (!japaneseImeRef.current?.selectCandidate(index)) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  useEffect(() => {
    if (!imeCandidates.length) return;
    const selected = imeCandidateListRef.current?.querySelector<HTMLElement>(".ime-candidate.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [imeCandidateIndex, imeCandidates.length]);

  const submittedPitchCorrect = submittedPitch && submittedPitchQuestion
    ? submittedPitchQuestion.allowed_patterns.some((pattern) => pattern.length === submittedPitch.length && pattern.every((level, index) => level === submittedPitch[index]))
    : null;
  const feedbackTone = ambiguous
    ? "check"
    : review
      ? ((submittedPitchCorrect ?? !result?.failure_type) ? "correct" : "incorrect")
      : pitchQuestion
        ? "correct"
        : "neutral";
  const feedbackLabel = feedbackTone === "correct" ? (pitchQuestion ? "✓ 뜻 정답" : "✓ 정답") : feedbackTone === "incorrect" ? "× 다시 확인" : feedbackTone === "check" ? "? 확인" : null;
  const recallTotalMs = card?.recall_timeout_ms ?? 0;
  const recallElapsedMs = card ? Math.max(0, (firstInputAt.current ?? timerNow) - shownAt.current) : 0;
  const recallRemainingMs = timerActive && firstInputAt.current == null ? Math.max(0, recallTotalMs - recallElapsedMs) : 0;
  const recallRatio = recallTotalMs > 0 ? Math.max(0, Math.min(1, recallRemainingMs / recallTotalMs)) : 0;
  const inputTotalMs = card?.completion_idle_ms ?? 0;
  const inputRemainingMs = timerActive && completionDeadlineAt.current != null ? Math.max(0, completionDeadlineAt.current - timerNow) : inputTotalMs;
  const inputRatio = inputTotalMs > 0 && completionDeadlineAt.current != null ? Math.max(0, Math.min(1, inputRemainingMs / inputTotalMs)) : 0;
  const expectedPitch = submittedPitchQuestion?.allowed_patterns[0] ?? null;

  if (!card) {
    return <section className="study">
      <div className="study-top"><div className="study-wordmark">TANREN</div><div>단계 완료</div><button className="ghost" onClick={() => void exitStudy()}>나가기</button></div>
      <div className="study-center complete-center">
        <motion.div className="completion-card" initial={reduceMotion ? false : { opacity: 0, y: 18, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
          <span className="completion-kicker">단계 완료</span>
          <div className="completion-title">이번 단계를 끝냈어요.</div>
          <button autoFocus onClick={() => void exitStudy()}>책장으로</button>
        </motion.div>
      </div>
    </section>;
  }

  return <section className={`study feedback-${feedbackTone}`}>
    <div className="study-top">
      <div className="mode"><strong>TANREN</strong><span>{card.mode.toUpperCase()} / {card.answer_language}</span></div>
      <div className="study-stage">{card.stage.toLocaleString("ko-KR")}단계 · {formatStudyRangeLabel(card.range_label)}</div>
      <div className="study-top-right"><span className="remaining"><strong>{card.total - card.remaining}</strong><i>/</i>{card.total}</span><button className="ghost" onClick={() => void exitStudy()}>ESC</button></div>
    </div>
    <div className="progress"><div style={{ width: `${100 * (1 - card.remaining / Math.max(card.total, 1))}%` }} /></div>
    {(inputWarning ?? card.input_warning) && <div className="study-warning">{inputWarning ?? card.input_warning}</div>}
    <div className="study-center">
      <div className="study-card-viewport">
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            className={`study-card tone-${feedbackTone}`}
            key={card.variant_id}
            initial={reduceMotion ? false : { x: "68vw", opacity: 0, scale: .92, rotate: 3.5 }}
            animate={{ x: 0, opacity: 1, scale: 1, rotate: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: "-74vw", opacity: 0, scale: .9, rotate: -4.5 }}
            transition={reduceMotion ? { duration: .01 } : { duration: .34, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="study-card-head">
              <span className="card-sequence">{String(card.total - card.remaining + 1).padStart(2, "0")}</span>
              {feedbackLabel && <span className={`feedback-state ${feedbackTone}`}>{feedbackLabel}</span>}
              <div className="timer-rack" aria-label="answer timers">
                <div className={`timer-unit ${firstInputAt.current == null && timerActive ? "active" : "locked"}`}>
                  <div className="timer-copy"><span>회상</span><strong>{firstInputAt.current == null && timerActive ? `${(recallRemainingMs / 1000).toFixed(1)}s` : `${(recallElapsedMs / 1000).toFixed(2)}s`}</strong></div>
                  <div className="timer-track"><i style={{ transform: `scaleX(${firstInputAt.current == null ? recallRatio : 0})` }} /></div>
                </div>
                <div className={`timer-unit ${completionDeadlineAt.current != null && timerActive ? "active" : "waiting"}`}>
                  <div className="timer-copy"><span>입력</span><strong>{inputTotalMs <= 0 ? "꺼짐" : completionDeadlineAt.current != null && timerActive ? `${(inputRemainingMs / 1000).toFixed(1)}s` : "—"}</strong></div>
                  <div className="timer-track"><i style={{ transform: `scaleX(${inputRatio})` }} /></div>
                </div>
              </div>
            </div>

            <div className={card.mode === "listening" ? "question listening-question" : "question"}>{card.mode === "listening" ? <><span className="audio-orb" aria-hidden="true">▶</span><span>듣고 답을 입력해주세요</span></> : card.question}</div>

            {pitchQuestion && <div className="pitch-panel">
              <div className="pitch-panel-head"><span>PITCH</span><small>{pitchQuestion.confidence} · {pitchQuestion.gate_enabled ? "채점" : "참고"}</small></div>
              <PitchTrace morae={pitchQuestion.morae} levels={pitchLevels} tone="neutral" />
              <div className="pitch-contour" role="group" aria-label="mora pitch contour">
                {pitchQuestion.morae.map((mora, index) => {
                  const level = pitchLevels[index] ?? null;
                  return <button
                    key={`${mora}-${index}`}
                    ref={(element) => { pitchButtonRefs.current[index] = element; }}
                    type="button"
                    className={`mora-toggle ${level === 1 ? "is-high" : level === 0 ? "is-low" : "is-unset"} ${pitchCursor === index ? "is-current" : ""}`}
                    onFocus={() => setPitchCursor(index)}
                    onClick={() => choosePitch(index, level === 1 ? 0 : 1)}
                    onKeyDown={(event) => void pitchKeydown(event, index)}
                    aria-label={`${mora}: ${level === 1 ? "HIGH" : level === 0 ? "LOW" : "unset"}`}
                  >
                    <span className="mora-label">{mora}</span>
                    <span className="pitch-level">{level === 1 ? "HIGH" : level === 0 ? "LOW" : "SET"}</span>
                  </button>;
                })}
              </div>
              <div className="pitch-footer"><p>↑/↓ H/L · ←/→ 이동</p><button className="pitch-submit" type="button" disabled={!pitchSubmission(pitchLevels)} onClick={() => void submitPitchContour()}>Enter ↵</button></div>
            </div>}

            {review && submittedPitch && submittedPitchQuestion && expectedPitch && <motion.div className="pitch-review" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <div><span>정답</span><PitchTrace morae={submittedPitchQuestion.morae} levels={expectedPitch} tone="correct" /></div>
              <div><span>내 답</span><PitchTrace morae={submittedPitchQuestion.morae} levels={submittedPitch} tone={submittedPitchCorrect ? "correct" : "incorrect"} /></div>
            </motion.div>}

            {review && <motion.div className={`review-card ${feedbackTone}`} initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><span className="feedback-label">정답</span><strong>{result?.canonical_answer}</strong>{result?.reading && <span>{result.reading}</span>}<p>{result?.message}</p>{card.audio_path && <button className="compact-button" type="button" onClick={playCachedAnswer}>▶ 정답 듣기</button>}</motion.div>}
            {ambiguous && <motion.div className="review-card ambiguous-card" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><span className="feedback-label">확인</span><p>이 답을 정답으로 기억할까요?</p><div className="actions"><button onClick={async () => advance(await api.adjudicate(card.variant_id, true))}>정답이에요</button><button className="secondary" onClick={async () => advance(await api.adjudicate(card.variant_id, false))}>오답이에요</button></div></motion.div>}

            {!pitchQuestion && (usesJapaneseIme ? <div
              className={`answer-ime-shell ${japaneseImeReady ? "is-ready" : "is-loading"} ${review ? "is-review" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                moveJapaneseCaretFromPointer(event.clientX, event.currentTarget);
                inputRef.current?.focus();
              }}
            >
              <div className="answer-ime-display" aria-live="polite">
                {!answer && !imePreedit && <span className="answer-ime-placeholder">{review ? "Enter로 다음 문제" : japaneseImeReady ? "답을 입력해주세요" : "일본어 입력 준비 중..."}</span>}
                {answer.slice(0, imeCaret)}
                {imeSegments.map((segment, index) => {
                  const chars = Array.from(segment.text);
                  const caretOffset = segment.kind === "yomi" && segment.caretOffset != null
                    ? Math.max(0, Math.min(segment.caretOffset, chars.length))
                    : null;
                  return <span
                    key={`${segment.kind}-${segment.text}-${index}`}
                    className={`answer-ime-preedit ${segment.kind}`}
                  >{caretOffset == null
                    ? segment.text
                    : <>{chars.slice(0, caretOffset).join("")}<span className="answer-ime-caret" aria-hidden="true" />{chars.slice(caretOffset).join("")}</>}</span>;
                })}
                {!imeHasInternalCaret && <span className="answer-ime-caret" aria-hidden="true" />}
                {answer.slice(imeCaret)}
              </div>
              <input
                ref={inputRef}
                className="answer-ime-capture"
                value=""
                onChange={() => undefined}
                onKeyDown={keydown}
                onKeyUp={keyup}
                onBeforeInput={(event) => event.preventDefault()}
                onPaste={(e) => {
                  e.preventDefault();
                  const text = e.clipboardData.getData("text");
                  if (!text) return;
                  japaneseImeRef.current?.reset();
                  setImeSegments([]);
                  endJapaneseComposition();
                  insertJapaneseText(text);
                }}
                disabled={ambiguous}
                aria-label="답 입력"
                aria-busy={!japaneseImeReady}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {!review && !ambiguous && imeCandidates.length > 0 && <div ref={imeCandidateListRef} className="ime-candidate-list" role="listbox" aria-label="일본어 변환 후보">
                {imeCandidates.map((candidate, index) => <button
                  key={`${candidate}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === imeCandidateIndex}
                  className={`ime-candidate ${index === imeCandidateIndex ? "is-selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => selectJapaneseCandidate(index)}
                ><span>{index < 9 ? index + 1 : ""}</span><strong>{candidate}</strong></button>)}
              </div>}
            </div> : <input
              ref={inputRef}
              className="answer-input"
              value={answer}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={keydown}
              onCompositionStart={() => {
                composing.current = true;
                compositionStartedAt.current = performance.now();
                if (completionTimer.current) window.clearTimeout(completionTimer.current);
                completionTimer.current = null;
                completionDeadlineAt.current = null;
              }}
              onCompositionEnd={(e) => {
                const now = performance.now();
                composing.current = false;
                if (compositionStartedAt.current != null) imeCompositionMs.current += now - compositionStartedAt.current;
                compositionStartedAt.current = null;
                compositionEndedAt.current = now;
                lastActivityAt.current = now;
                scheduleCompletionTimeout(e.currentTarget.value);
              }}
              placeholder={review ? "Enter로 다음 문제" : "답을 입력해주세요"}
              disabled={ambiguous}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />)}
            {!review && !ambiguous && !pitchQuestion && <div className="study-hint"><span><kbd>↵</kbd> 확인</span><span><kbd>빈 ↵</kbd> 모르면 넘어가기</span></div>}
            {review && <div className="review-next"><kbd>ENTER</kbd><span>다음 문제</span><b>→</b></div>}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  </section>;
}

function PitchTrace({ morae, levels, tone }: { morae: string[]; levels: Array<number | null>; tone: "neutral" | "correct" | "incorrect" }) {
  const count = Math.max(morae.length, 1);
  const width = Math.max(220, count * 78);
  const step = width / count;
  const points = morae.map((_, index) => {
    const level = levels[index];
    const x = step * index + step / 2;
    const y = level === 1 ? 25 : level === 0 ? 67 : 46;
    return { x, y, level };
  });
  return <div className={`pitch-trace ${tone}`}>
    <svg viewBox={`0 0 ${width} 112`} role="img" aria-label={`pitch contour ${morae.join(" ")}`}>
      <line className="pitch-guide high" x1="0" y1="25" x2={width} y2="25" />
      <line className="pitch-guide low" x1="0" y1="67" x2={width} y2="67" />
      {points.length > 1 && <polyline className="pitch-line" points={points.map((point) => `${point.x},${point.y}`).join(" ")} />}
      {points.map((point, index) => <g key={`${morae[index]}-${index}`}>
        <circle className={point.level == null ? "pitch-node unset" : "pitch-node"} cx={point.x} cy={point.y} r="6" />
        <text className="pitch-mora" x={point.x} y="104" textAnchor="middle">{morae[index]}</text>
      </g>)}
    </svg>
  </div>;
}

const MODE_DETAILS: Record<StudyMode, { label: string; description: string; mark: string }> = {
  reading: { label: "Reading", description: "외국어를 보고 뜻을 떠올려요", mark: "読" },
  listening: { label: "Listening", description: "소리를 듣고 뜻을 떠올려요", mark: "聴" },
  writing: { label: "Writing", description: "뜻을 보고 외국어를 떠올려요", mark: "書" },
};

const numberFormat = new Intl.NumberFormat("ko-KR");
const compactNumberFormat = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });

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

function formatLastPracticed(value: string | null) {
  if (!value) return "시작 전";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
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
  seen_entry_count: { label: "누적 단어 수", format: (value) => value == null ? "—" : `${numberFormat.format(value)}개`, value: (point) => point.seen_entry_count },
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

function ModeStatsGrid({ stats }: { stats: DeckStats[] }) {
  const orderedStats = (["reading", "writing", "listening"] as StudyMode[])
    .map((mode) => stats.find((item) => item.mode === mode))
    .filter((mode): mode is DeckStats => mode != null);

  return <div className="stats-mode-grid">
    {orderedStats.map((mode) => {
      const details = MODE_DETAILS[mode.mode];
      return <article className="stats-mode-card" key={mode.mode}>
        <header>
          <span className="stats-mode-mark" aria-hidden="true">{details.mark}</span>
          <div><h3>{details.label}</h3><p>{details.description}</p></div>
          <strong>{formatPercent(mode.base_accuracy)}</strong>
        </header>
        <dl>
          <div><dt>시도</dt><dd>{numberFormat.format(mode.attempts)}</dd></div>
          <div><dt>억양 정확도</dt><dd>{formatPercent(mode.pitch_accuracy)}</dd></div>
          <div><dt>통합 정확도</dt><dd>{formatPercent(mode.joint_accuracy)}</dd></div>
          <div><dt>중앙 응답시간</dt><dd>{formatLatency(mode.median_recall_latency_ms)}</dd></div>
        </dl>
      </article>;
    })}
    <article className="stats-mode-card is-placeholder">
      <header>
        <span className="stats-mode-mark" aria-hidden="true">話</span>
        <div><h3>Speaking</h3><p>말하기 훈련 준비 중</p></div>
        <strong>—</strong>
      </header>
      <dl>
        <div><dt>시도</dt><dd>—</dd></div>
        <div><dt>억양 정확도</dt><dd>—</dd></div>
        <div><dt>통합 정확도</dt><dd>—</dd></div>
        <div><dt>중앙 응답시간</dt><dd>—</dd></div>
      </dl>
    </article>
  </div>;
}

function LibraryStatsView({ stats }: { stats: LibraryStats | null }) {
  return <section className="content stats-dashboard stats-dashboard-global">
    {!stats ? <div className="stats-loading" aria-live="polite"><span />통계를 불러오고 있어요.</div>
      : stats.deck_count === 0 ? <div className="stats-empty"><span>統</span><strong>아직 보여드릴 통계가 없어요.</strong><p>학습을 시작하면 기록이 여기에 쌓여요.</p></div>
        : <>
          <div className="stats-summary-grid">
            <StatsMetric label="누적 시도" value={`${numberFormat.format(stats.attempts)}회`} help="지금까지 문제를 푼 횟수예요." />
            <StatsMetric label="누적 단어 수" value={`${numberFormat.format(stats.seen_entry_count)}개`} help="한 번이라도 학습한 단어 수예요." />
            <StatsMetric label="문제 정확도" value={formatPercent(stats.base_accuracy)} help="피치를 제외한 문제의 정답률이에요." />
            <StatsMetric label="피치 정확도" value={formatPercent(stats.pitch_accuracy)} help="피치를 정확히 맞힌 비율이에요." />
            <StatsMetric label="중앙 응답시간" value={formatLatency(stats.median_recall_latency_ms)} help="문제를 보고 답을 입력하기 시작하기까지 걸린 시간이에요." />
            <StatsMetric label="공부 시간" value={formatStudyTime(stats.study_time_ms)} help="학습 화면에서 실제로 공부한 시간을 기록해요." />
            <StatsMetric label="책 개수" value={`${numberFormat.format(stats.deck_count)}개`} help="현재 책장에 있는 책의 개수예요." />
          </div>

          <GrowthChart stats={stats} />
        </>}
  </section>;
}

function DeckStatsView({ deck, stats }: { deck: DeckSummary; stats: DeckStats[] }) {
  const attempts = stats.reduce((sum, mode) => sum + mode.attempts, 0);
  const weightedAccuracy = attempts === 0 ? null : stats.reduce((sum, mode) => sum + (mode.base_accuracy ?? 0) * mode.attempts, 0) / attempts;
  const weightedJointAccuracy = attempts === 0 ? null : stats.reduce((sum, mode) => sum + (mode.joint_accuracy ?? 0) * mode.attempts, 0) / attempts;
  return <section className="content stats-dashboard stats-dashboard-deck">
    <header className="stats-dashboard-header">
      <div><span className="stats-kicker">BOOK PERFORMANCE</span><h1>{deck.name}</h1><p>이 책에서 쌓인 학습 기록을 보여드려요.</p></div>
      <div className="stats-scope"><strong>{numberFormat.format(deck.entry_count)}</strong><span>WORDS</span></div>
    </header>
    <div className="stats-summary-grid">
      <StatsMetric featured label="전체 정확도" value={formatPercent(weightedAccuracy)} help={`통합 정답률 ${formatPercent(weightedJointAccuracy)}`} />
      <StatsMetric label="누적 시도" value={compactNumberFormat.format(attempts)} help={`${numberFormat.format(attempts)}회 학습 기록`} />
      <StatsMetric label="수록 단어" value={numberFormat.format(deck.entry_count)} help={`${deck.completed_stage_count}개 단계 완료`} />
      <StatsMetric label="현재 단계" value={`${deck.current_stage}단계`} help={deck.active_range ? formatStudyRangeLabel(deck.active_range) : "새 단계 준비"} />
    </div>
    <section className="stats-dashboard-section">
      <div className="stats-section-title"><div><span>TRAINING MODES</span><h2>훈련별 성과</h2></div><p>모드별 정확도와 응답 속도를 비교해요.</p></div>
      <ModeStatsGrid stats={stats} />
    </section>
  </section>;
}

export default App;
