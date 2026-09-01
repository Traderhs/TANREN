import { FormEvent, KeyboardEvent, forwardRef, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import HTMLFlipBook from "react-pageflip";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, RoundedBox } from "@react-three/drei";
import { api } from "./lib/api";
import { parseEntryText } from "./lib/importParser";
import type { DeckStats, DeckSummary, PitchQuestion, SemanticRuntimeStatus, StorageSettings, StudyCard, StudyMode, SubmitResult, VoicevoxRuntimeStatus } from "./lib/types";
import { activeCardTimerRuns, cardAfterResult, emptyPitchSelection, enterAction, exitStudyForDeckNavigation, pitchSubmission, setPitchLevel, shouldAutoPlayAfterWrittenAnswer, type PitchLevel, type PitchSelection } from "./lib/studyFlow";
import { completionDelayMs, firstMeaningfulInputAt, isMeaningfulInput, recallHasTimedOut } from "./lib/studyTimers";

type View = "decks" | "editor" | "study" | "stats" | "settings";

const BOOK_FLUTTER_LEAF_COUNT = 8;
const BOOK_CONTENT_PAGE = BOOK_FLUTTER_LEAF_COUNT + 1;
const MAX_DECK_NAME_LENGTH = 20;

function OpenBook3D() {
  return <div className="book-3d book-3d-open" aria-hidden="true">
    <Canvas orthographic camera={{ position: [0, 0.1, 10], zoom: 72 }} dpr={[1, 1.5]} gl={{ alpha: true, antialias: true }}>
      <ambientLight intensity={1.08} />
      <directionalLight position={[1.5, 5, 7]} intensity={1.35} />
      <group rotation={[-0.035, 0, 0]} position={[0, 0.02, -0.12]}>
        <group position={[-1.74, 0, 0]} rotation={[0, -0.055, -0.005]}>
          <RoundedBox args={[3.42, 4.52, 0.16]} radius={0.055} smoothness={4} position={[-0.03, 0, -0.19]}><meshStandardMaterial color="#0a0d10" roughness={0.76} /></RoundedBox>
          <RoundedBox args={[3.28, 4.38, 0.16]} radius={0.035} smoothness={4} position={[0, 0, -0.06]}><meshStandardMaterial color="#a99f89" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.22, 4.31, 0.055]} radius={0.025} smoothness={3} position={[0.035, 0, 0.055]}><meshStandardMaterial color="#151719" roughness={0.9} /></RoundedBox>
        </group>
        <group position={[1.74, 0, 0]} rotation={[0, 0.055, 0.005]}>
          <RoundedBox args={[3.42, 4.52, 0.16]} radius={0.055} smoothness={4} position={[0.03, 0, -0.19]}><meshStandardMaterial color="#0a0d10" roughness={0.76} /></RoundedBox>
          <RoundedBox args={[3.28, 4.38, 0.16]} radius={0.035} smoothness={4} position={[0, 0, -0.06]}><meshStandardMaterial color="#a99f89" roughness={0.96} /></RoundedBox>
          <RoundedBox args={[3.22, 4.31, 0.055]} radius={0.025} smoothness={3} position={[-0.035, 0, 0.055]}><meshStandardMaterial color="#131517" roughness={0.9} /></RoundedBox>
        </group>
        <RoundedBox args={[0.18, 4.34, 0.20]} radius={0.05} smoothness={4} position={[0, 0, -0.10]}><meshStandardMaterial color="#090b0d" roughness={0.82} /></RoundedBox>
      </group>
      <ContactShadows position={[0, -2.52, -0.48]} opacity={0.46} scale={8.3} blur={3.2} far={4.5} />
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
  const [homeStats, setHomeStats] = useState<DeckStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticRuntimeStatus | null>(null);
  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxRuntimeStatus | null>(null);
  const homeScrollRef = useRef<HTMLDivElement>(null);
  const homeWheelLockRef = useRef(false);
  const homeShelfWheelAtRef = useRef(0);
  const homeShelfScrollTargetRef = useRef<number | null>(null);
  const homeShelfScrollFrameRef = useRef<number | null>(null);

  const homeStatsDeck = selected && decks.some((item) => item.id === selected.id) ? selected : decks[0] ?? null;

  const refresh = async () => {
    try {
      setDecks(await api.listDecks());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => void refresh(), []);
  useEffect(() => {
    if (view !== "decks" || !homeStatsDeck) {
      setHomeStats([]);
      return;
    }
    void api.stats(homeStatsDeck.id).then(setHomeStats).catch(() => setHomeStats([]));
  }, [view, homeStatsDeck?.id]);
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
      if (homeWheelLockRef.current) {
        event.preventDefault();
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest(".deck-create-backdrop")) return;
      if (target?.closest(".open-book-stage")) return;

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

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
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

  const openStudy = async (deck: DeckSummary, stageIndex?: number) => {
    try {
      setSelected(deck);
      const started = await api.startStudy(deck.id, stageIndex);
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
        <div className="topbar-context">{view.toUpperCase()}</div>
        <div className="topbar-actions">
          <button className="ghost" onClick={() => void openDecks()}>← Library</button>
        </div>
      </header>}

      {error && <div className="error">{error}</div>}

      {view === "decks" && (
        <div ref={homeScrollRef} className="library-frame home-scroll">
          <section className="home-snap-section home-library-section">
            <DeckList
              decks={decks}
              semanticStatus={semanticStatus}
              voicevoxStatus={voicevoxStatus}
              onRefresh={refresh}
              onEdit={(d) => { setSelected(d); setView("editor"); }}
              onStudy={openStudy}
              onStats={openStats}
            />
          </section>
          <section className="home-snap-section home-stats-section">
            {homeStatsDeck
              ? <StatsView deck={homeStatsDeck} stats={homeStats} />
              : <div className="home-empty-section"><strong>Statistics</strong><span>책을 추가하면 통계가 여기에 보여.</span></div>}
          </section>
          <section className="home-snap-section home-settings-section">
            <SettingsView voicevoxStatus={voicevoxStatus} />
          </section>
        </div>
      )}
      {view === "editor" && selected && <DeckEditor deck={selected} onDone={refresh} />}
      {view === "study" && (card || result) && (
        <StudyView
          card={card}
          result={result}
          setCard={setCard}
          setResult={setResult}
          onExit={openDecks}
        />
      )}
      {view === "stats" && selected && <StatsView deck={selected} stats={stats} />}
      {view === "settings" && <SettingsView voicevoxStatus={voicevoxStatus} />}
    </main>
  );
}

function SettingsView({ voicevoxStatus }: { voicevoxStatus: VoicevoxRuntimeStatus | null }) {
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [restoreMessage, setRestoreMessage] = useState("");

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
    setMessage(value.restart_required ? "저장했어. TANREN을 재시작하면 새 폴더를 사용해." : "저장했어.");
  };

  const reset = async () => {
    const value = await api.setStorageDirectory(null);
    setSettings(value);
    setPath(value.default_path);
    setMessage(value.restart_required ? "기본 경로로 복원했어. 재시작 후 적용돼." : "기본 경로를 사용 중이야.");
  };

  const restore = async () => {
    const restored = await api.importDeckExport(restoreText);
    setRestoreText("");
    setRestoreMessage(`${restored.name} 복원 완료`);
  };

  return <section className="content narrow">
    <div className="section-heading"><div><h1>Settings</h1><p>로컬 런타임과 백업.</p></div></div>
    <div className="settings-card">
      <label htmlFor="semantic-storage">Model & voice data</label>
      <p className="setting-help">임베딩 모델과 음성 런타임 저장 위치.</p>
      {voicevoxStatus?.phase !== "ready" && voicevoxStatus && <p className="setting-help runtime-inline">Voice · {voicevoxStatus.phase}{voicevoxStatus.error ? ` · ${voicevoxStatus.error}` : ""}</p>}
      <div className="path-row">
        <input id="semantic-storage" value={path} onChange={(e) => setPath(e.target.value)} placeholder={settings?.default_path ?? ""} />
        <button className="secondary" onClick={() => void browse()}>Browse</button>
      </div>
      {settings && <div className="storage-meta">
        <span>현재 사용 중: <code>{settings.active_path}</code></span>
        <span>기본값: <code>{settings.default_path}</code></span>
      </div>}
      <div className="actions">
        <button onClick={() => void save()}>Save</button>
        <button className="ghost" onClick={() => void reset()}>Use default</button>
      </div>
      {message && <p className="success">{message}</p>}
      {settings?.restart_required && <p className="setting-warning">경로 변경은 재시작 후 적용돼. 기존 폴더의 파일은 자동 삭제하지 않아.</p>}
    </div>
    <details className="advanced-panel">
      <summary>Backup restore</summary>
      <p className="setting-help">TANREN portable JSON 백업을 복원할 때만 사용해.</p>
      <textarea value={restoreText} onChange={(event) => setRestoreText(event.target.value)} placeholder="Portable deck JSON" />
      <button disabled={!restoreText.trim()} onClick={() => void restore()}>Restore deck</button>
      {restoreMessage && <p className="success">{restoreMessage}</p>}
    </details>
  </section>;
}

function DeckList({ decks, semanticStatus, voicevoxStatus, onRefresh, onEdit, onStudy, onStats }: {
  decks: DeckSummary[];
  semanticStatus: SemanticRuntimeStatus | null;
  voicevoxStatus: VoicevoxRuntimeStatus | null;
  onRefresh: () => Promise<void>;
  onEdit: (d: DeckSummary) => void;
  onStudy: (d: DeckSummary, stageIndex?: number) => void;
  onStats: (d: DeckSummary) => void;
}) {
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [openedDeckId, setOpenedDeckId] = useState<string | null>(null);
  const [bookOpenCycle, setBookOpenCycle] = useState(0);
  const [bookSettled, setBookSettled] = useState(false);
  const reduceMotion = useReducedMotion();
  const flipBookRef = useRef<any>(null);
  const flutterTimerRef = useRef<number | null>(null);
  const flutteringRef = useRef(false);
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
  const runtimeIssues = [
    semanticStatus && semanticStatus.phase !== "ready" ? `Semantic ${semanticStatus.phase}${semanticStatus.error ? ` · ${semanticStatus.error}` : ""}` : null,
    voicevoxStatus && voicevoxStatus.phase !== "ready" ? `Voice ${voicevoxStatus.phase}${voicevoxStatus.error ? ` · ${voicevoxStatus.error}` : ""}` : null,
  ].filter(Boolean) as string[];
  const openedDeck = openedDeckId ? decks.find((deck) => deck.id === openedDeckId) ?? null : null;
  useEffect(() => {
    if (flutterTimerRef.current !== null) window.clearTimeout(flutterTimerRef.current);
    flutteringRef.current = Boolean(openedDeckId && !reduceMotion);
    setBookSettled(Boolean(openedDeckId && reduceMotion));
    if (!openedDeckId || reduceMotion) return;
    flutterTimerRef.current = window.setTimeout(() => {
      const pageFlip = flipBookRef.current?.pageFlip?.();
      if (pageFlip?.getCurrentPageIndex?.() === 0) pageFlip.flipNext("top");
    }, 85);
    return () => {
      if (flutterTimerRef.current !== null) window.clearTimeout(flutterTimerRef.current);
      flutterTimerRef.current = null;
      flutteringRef.current = false;
    };
  }, [openedDeckId, reduceMotion]);
  const continueBookFlutter = (pageIndex: number) => {
    if (reduceMotion || !flutteringRef.current || pageIndex >= BOOK_CONTENT_PAGE) {
      flutteringRef.current = false;
      if (pageIndex >= BOOK_CONTENT_PAGE) setBookSettled(true);
      return;
    }
    if (flutterTimerRef.current !== null) window.clearTimeout(flutterTimerRef.current);
    flutterTimerRef.current = window.setTimeout(() => {
      const pageFlip = flipBookRef.current?.pageFlip?.();
      if (!pageFlip || pageFlip.getCurrentPageIndex() >= BOOK_CONTENT_PAGE) {
        flutteringRef.current = false;
        setBookSettled(true);
        return;
      }
      pageFlip.flipNext("top");
    }, 4);
  };
  return <section className={`content home-content ${openedDeck ? "is-book-open" : ""}`}>
    {runtimeIssues.length > 0 && <div className="runtime-strip"><span className="runtime-dot" />{runtimeIssues.join("  ·  ")}</div>}
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
          startPage={reduceMotion ? BOOK_CONTENT_PAGE : 0}
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
          onFlip={(event) => continueBookFlutter(Number(event.data))}
        >
          <FlipPage className="book-cover-page" hard>
            <div className="book-cover-frame" />
            <span className="book-cover-volume">Vol. {String(decks.findIndex((deck) => deck.id === openedDeck.id) + 1).padStart(2, "0")}</span>
            <span className="book-cover-language">{openedDeck.source_language} → {openedDeck.target_language}</span>
            <strong>{openedDeck.name}</strong>
            <span className="book-cover-mark">鍛</span>
            <span className="book-cover-foot">TANREN · TRAINING DECK</span>
          </FlipPage>

          {Array.from({ length: BOOK_FLUTTER_LEAF_COUNT }, (_, index) => (
            <FlipPage key={`flutter-${index}`} className="book-flutter-page">
              <span className="book-flutter-folio">{String(index + 1).padStart(2, "0")}</span>
            </FlipPage>
          ))}

          <FlipPage className="book-inside-page book-inside-left">
            <div className="book-page-inner">
              <div className="book-page-topline">
                <button className="book-close ghost" onClick={() => setOpenedDeckId(null)}>← 책장</button>
                <span className="book-folio">{String(decks.findIndex((deck) => deck.id === openedDeck.id) + 1).padStart(2, "0")}</span>
              </div>
              <div className="book-title-page">
                <span className="book-imprint">TANREN · 鍛錬</span>
                <div className="book-rule" />
                <span className="book-language">{openedDeck.source_language} → {openedDeck.target_language}</span>
                <h2>{openedDeck.name}</h2>
                <p>TRAINING DECK</p>
              </div>
              <dl className="book-stats">
                <div><dt>WORDS</dt><dd>{openedDeck.entry_count}</dd></div>
                <div><dt>ROUND</dt><dd>{openedDeck.current_round}</dd></div>
                <div><dt>RANGES</dt><dd>{openedDeck.study_ranges.length}</dd></div>
              </dl>
              <div className="book-tools">
                <button className="ghost" onClick={() => onEdit(openedDeck)}>Edit</button>
                <button className="ghost" onClick={() => onStats(openedDeck)}>Stats</button>
              </div>
            </div>
          </FlipPage>

          <FlipPage className="book-inside-page book-inside-right">
            <div className="book-page-inner book-page-inner-right">
              <div className="range-heading">
                <div><span>CONTENTS</span><strong>학습 구간</strong></div>
                {openedDeck.active_stage && <small>현재 {openedDeck.active_stage.replace(" · cumulative", "").replace("~", "–")}</small>}
              </div>
              <div className="book-range-scroll" aria-label={`${openedDeck.name} study ranges`}>
                {openedDeck.study_ranges.map((range) => {
                  const label = range.label.replace(" · cumulative", "").replace("~", "–");
                  const active = openedDeck.active_stage === range.label;
                  return <button
                    key={range.stage_index}
                    className={`book-range ${range.cumulative ? "is-cumulative" : ""} ${active ? "is-current" : ""}`}
                    onClick={() => onStudy(openedDeck, range.stage_index)}
                  >
                    <span className="book-range-index">{String(range.stage_index + 1).padStart(2, "0")}</span>
                    <span className="book-range-copy"><strong>{label}</strong><small>{range.end - range.start} words</small></span>
                    {range.cumulative && <span className="book-range-kind">누적</span>}
                    {active && <span className="book-range-current">현재</span>}
                    <span className="book-range-arrow" aria-hidden="true">↗</span>
                  </button>;
                })}
                {openedDeck.study_ranges.length === 0 && <div className="book-range-empty">학습할 단어를 먼저 추가해.</div>}
              </div>
              <span className="book-page-foot">SELECT A RANGE TO BEGIN</span>
            </div>
          </FlipPage>

          <FlipPage className="book-back-page" hard>
            <span>鍛錬</span>
          </FlipPage>
        </HTMLFlipBook>
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
          <button className="add-deck-button" type="submit" aria-label="책 추가" title="책 추가" disabled={!name.trim()}>+</button>
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
                        <span className="ebook-current-round">Round {d.current_round}</span>
                        <span className="ebook-current-range">{d.active_stage ? d.active_stage.replace(" · cumulative", "").replace("~", " - ") : "—"}</span>
                      </span>
                      <span className="ebook-progress" aria-hidden="true"><i style={{ width: `${d.study_ranges.length === 0 ? 0 : Math.min(100, (d.completed_range_count / d.study_ranges.length) * 100)}%` }} /></span>
                    </span>
                  </span>
                  <span className="ebook-page-edge ebook-page-edge-right" aria-hidden="true" />
                </span>
              </motion.button>;
            })}
          </div>
        ))}
        {decks.length === 0 && <div className="empty"><strong>아직 덱이 없어.</strong><span>오른쪽 위 + 버튼으로 첫 덱을 추가해.</span></div>}
      </motion.div>}
    </AnimatePresence>
  </section>;
}

function DeckEditor({ deck, onDone }: { deck: DeckSummary; onDone: () => Promise<void> }) {
  const [text, setText] = useState("見据える\t내다보다 / 전망하다\n躊躇う\t망설이다");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(deck.name);
  const [modes, setModes] = useState<StudyMode[]>(deck.enabled_modes);
  const importText = async () => {
    const parsed = parseEntryText(text);
    const result = await api.importEntries(deck.id, parsed.entries);
    const issueText = parsed.issues.length ? ` · ${parsed.issues.length}개 malformed/입력 중복: ${parsed.issues.map((issue) => `${issue.row}행 ${issue.message}`).join("; ")}` : "";
    setMessage(`${result.inserted}개 저장 · DB 중복 ${result.duplicates}개 건너뜀${issueText} · enrichment는 백그라운드에서 진행돼.`);
    await onDone();
  };
  const toggleMode = (mode: StudyMode) => setModes((current) => current.includes(mode) ? current.filter((value) => value !== mode) : [...current, mode]);
  const save = async () => {
    await api.updateDeck(deck.id, name, modes);
    setMessage("덱 설정을 저장했습니다.");
    await onDone();
  };
  const remove = async () => {
    if (!window.confirm(`'${name}' 덱을 삭제할까요? 데이터는 sync 복구를 위해 soft-delete 됩니다.`)) return;
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
    <div className="section-heading"><div><h1>{name}</h1><p><code>일본어[TAB]한국어 뜻</code> 또는 CSV.</p></div></div>
    <div className="deck-settings">
      <input value={name} maxLength={MAX_DECK_NAME_LENGTH} onChange={(event) => setName(event.target.value)} aria-label="Deck name" />
      <div className="mode-options">{(["recognition", "listening", "production"] as StudyMode[]).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} /> {mode}</label>)}</div>
      <div className="actions"><button disabled={!name.trim() || modes.length === 0} onClick={() => void save()}>Save settings</button><button className="ghost danger" onClick={() => void remove()}>Delete deck</button></div>
    </div>
    <DeckEntryInput value={text} onChange={setText} />
    <button onClick={importText}>Import / Add</button>
    {message && <p className="success">{message}</p>}
    <div className="editor-footer"><button className="ghost" onClick={() => void exportDeck()}>Backup export</button></div>
  </section>;
}

function StudyView({ card, result, setCard, setResult, onExit }: {
  card: StudyCard | null;
  result: SubmitResult | null;
  setCard: (c: StudyCard | null) => void;
  setResult: (r: SubmitResult | null) => void;
  onExit: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [pitchLevels, setPitchLevels] = useState<PitchSelection>([]);
  const [pitchCursor, setPitchCursor] = useState(0);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(performance.now());
  const [submittedPitch, setSubmittedPitch] = useState<PitchSelection | null>(null);
  const [submittedPitchQuestion, setSubmittedPitchQuestion] = useState<PitchQuestion | null>(null);
  const shownAt = useRef(performance.now());
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
  const inputRef = useRef<HTMLInputElement>(null);
  const pitchButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pitchQuestion = result?.pitch ?? null;
  const timerActive = activeCardTimerRuns(card, result);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!timerActive) return;
    shownAt.current = performance.now();
    firstInputAt.current = null;
    lastActivityAt.current = null;
    interkeyGaps.current = [];
    composing.current = false;
    compositionStartedAt.current = null;
    compositionEndedAt.current = null;
    imeCompositionMs.current = 0;
    timeoutSent.current = false;
    setAnswer("");
    setSubmittedPitch(null);
    setSubmittedPitchQuestion(null);
    setInputWarning(null);
    setTimerNow(performance.now());
    let current = true;
    let nativeModeRetry: number | null = null;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (card) void api.activateInputProfile(card.answer_language)
        .then((warning) => {
          if (!current) return;
          setInputWarning(warning);
          nativeModeRetry = window.setTimeout(() => {
            void api.activateInputProfile(card.answer_language)
              .then((retryWarning) => { if (current) setInputWarning(retryWarning); })
              .catch((error) => { if (current) setInputWarning(`Input profile switch failed: ${String(error)}`); });
          }, 100);
        })
        .catch((error) => {
          if (current) setInputWarning(`Input profile switch failed: ${String(error)}`);
        });
    });
    return () => {
      current = false;
      cancelAnimationFrame(frame);
      if (nativeModeRetry != null) window.clearTimeout(nativeModeRetry);
    };
  }, [card?.variant_id, timerActive]);

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
    if (!timerActive || !card || card.mode !== "listening") return;
    if (card.audio_path) {
      const audio = new Audio(convertFileSrc(card.audio_path));
      void audio.play();
      return () => { audio.pause(); };
    }
  }, [card?.variant_id, timerActive]);

  const advance = (r: SubmitResult) => {
    setResult(r);
    setCard(cardAfterResult(card, r));
  };

  const submit = async () => {
    if (!card) return;
    if (card.audio_path && shouldAutoPlayAfterWrittenAnswer(card.mode)) {
      const audio = new Audio(convertFileSrc(card.audio_path));
      void audio.play();
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

  const handleInput = (value: string) => {
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
      if (lastActivityAt.current != null) interkeyGaps.current.push(Math.round(now - lastActivityAt.current));
      lastActivityAt.current = now;
      scheduleCompletionTimeout(value);
    }
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
  const nextFromStage = async () => advance(await api.continueStage());
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
    const audio = new Audio(convertFileSrc(card.audio_path));
    void audio.play();
  };

  const keydown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (!card || e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const action = enterAction(result);
    if (action === "review") {
      await nextFromReview();
    } else if (action === "submit") {
      await submit();
    }
  };

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
  const feedbackLabel = feedbackTone === "correct" ? (pitchQuestion ? "✓ MEANING OK" : "✓ CORRECT") : feedbackTone === "incorrect" ? "× WRONG" : feedbackTone === "check" ? "? CHECK" : null;
  const recallTotalMs = card?.recall_timeout_ms ?? 0;
  const recallElapsedMs = card ? Math.max(0, (firstInputAt.current ?? timerNow) - shownAt.current) : 0;
  const recallRemainingMs = timerActive && firstInputAt.current == null ? Math.max(0, recallTotalMs - recallElapsedMs) : 0;
  const recallRatio = recallTotalMs > 0 ? Math.max(0, Math.min(1, recallRemainingMs / recallTotalMs)) : 0;
  const inputTotalMs = card?.completion_idle_ms ?? 0;
  const inputRemainingMs = timerActive && completionDeadlineAt.current != null ? Math.max(0, completionDeadlineAt.current - timerNow) : inputTotalMs;
  const inputRatio = inputTotalMs > 0 && completionDeadlineAt.current != null ? Math.max(0, Math.min(1, inputRemainingMs / inputTotalMs)) : 0;
  const expectedPitch = submittedPitchQuestion?.allowed_patterns[0] ?? null;

  if (!card) {
    const stageClear = result?.status === "stage_clear";
    return <section className="study">
      <div className="study-top"><div className="study-wordmark">TANREN</div><div>{stageClear ? "STAGE COMPLETE" : "ROUND COMPLETE"}</div><button className="ghost" onClick={onExit}>Exit</button></div>
      <div className="study-center complete-center">
        <motion.div className="completion-card" initial={reduceMotion ? false : { opacity: 0, y: 18, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
          <span className="completion-kicker">{stageClear ? "STAGE CLEAR" : "ROUND CLEAR"}</span>
          <div className="completion-title">{stageClear ? "다음 구간으로 갈 준비 완료." : "이번 회독 끝."}</div>
          {stageClear
            ? <button autoFocus onClick={nextFromStage}>다음 Stage <span aria-hidden="true">→</span></button>
            : <button autoFocus onClick={onExit}>Decks로 돌아가기</button>}
        </motion.div>
      </div>
    </section>;
  }

  return <section className={`study feedback-${feedbackTone}`}>
    <div className="study-top">
      <div className="mode"><strong>TANREN</strong><span>{card.mode.toUpperCase()} / {card.answer_language}</span></div>
      <div className="study-stage">{card.stage_label}</div>
      <div className="study-top-right"><span className="remaining"><strong>{card.total - card.remaining}</strong><i>/</i>{card.total}</span><button className="ghost" onClick={onExit}>ESC</button></div>
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
                  <div className="timer-copy"><span>RECALL</span><strong>{firstInputAt.current == null && timerActive ? `${(recallRemainingMs / 1000).toFixed(1)}s` : `${(recallElapsedMs / 1000).toFixed(2)}s`}</strong></div>
                  <div className="timer-track"><i style={{ transform: `scaleX(${firstInputAt.current == null ? recallRatio : 0})` }} /></div>
                </div>
                <div className={`timer-unit ${completionDeadlineAt.current != null && timerActive ? "active" : "waiting"}`}>
                  <div className="timer-copy"><span>INPUT</span><strong>{inputTotalMs <= 0 ? "OFF" : completionDeadlineAt.current != null && timerActive ? `${(inputRemainingMs / 1000).toFixed(1)}s` : "—"}</strong></div>
                  <div className="timer-track"><i style={{ transform: `scaleX(${inputRatio})` }} /></div>
                </div>
              </div>
            </div>

            <div className={card.mode === "listening" ? "question listening-question" : "question"}>{card.mode === "listening" ? <><span className="audio-orb" aria-hidden="true">▶</span><span>한 번 듣고 입력</span></> : card.question}</div>

            {pitchQuestion && <div className="pitch-panel">
              <div className="pitch-panel-head"><span>PITCH</span><small>{pitchQuestion.confidence} · {pitchQuestion.gate_enabled ? "GRADED" : "REFERENCE"}</small></div>
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
              <div><span>EXPECTED</span><PitchTrace morae={submittedPitchQuestion.morae} levels={expectedPitch} tone="correct" /></div>
              <div><span>YOURS</span><PitchTrace morae={submittedPitchQuestion.morae} levels={submittedPitch} tone={submittedPitchCorrect ? "correct" : "incorrect"} /></div>
            </motion.div>}

            {review && <motion.div className={`review-card ${feedbackTone}`} initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><span className="feedback-label">ANSWER</span><strong>{result?.canonical_answer}</strong>{result?.reading && <span>{result.reading}</span>}<p>{result?.message}</p>{card.audio_path && <button className="compact-button" type="button" onClick={playCachedAnswer}>▶ 정답 듣기</button>}</motion.div>}
            {ambiguous && <motion.div className="review-card ambiguous-card" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><span className="feedback-label">CHECK</span><p>이 답을 이 항목의 정답으로 기억할까?</p><div className="actions"><button onClick={async () => advance(await api.adjudicate(card.variant_id, true))}>A · Accept</button><button className="secondary" onClick={async () => advance(await api.adjudicate(card.variant_id, false))}>R · Reject</button></div></motion.div>}

            {!pitchQuestion && <input
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
              placeholder={review ? "Enter → next" : "답 입력"}
              disabled={ambiguous}
              autoComplete="off"
              spellCheck={false}
            />}
            {!review && !ambiguous && !pitchQuestion && <div className="study-hint"><span><kbd>↵</kbd> 확인</span><span><kbd>빈 ↵</kbd> 모름</span></div>}
            {review && <div className="review-next"><kbd>ENTER</kbd><span>다음 카드</span><b>→</b></div>}
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

function StatsView({ deck, stats }: { deck: DeckSummary; stats: DeckStats[] }) {
  const pct = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  return <section className="content"><div className="section-heading"><div><h1>{deck.name} Statistics</h1><p>통계는 스케줄링에 영향을 주지 않아.</p></div></div>
    <div className="stats-grid">{stats.map((s) => <article className="stat-card" key={s.mode}><h2>{s.mode}</h2><dl><dt>Base</dt><dd>{pct(s.base_accuracy)}</dd><dt>Pitch</dt><dd>{pct(s.pitch_accuracy)}</dd><dt>Joint</dt><dd>{pct(s.joint_accuracy)}</dd><dt>Median recall</dt><dd>{s.median_recall_latency_ms == null ? "—" : `${s.median_recall_latency_ms} ms`}</dd><dt>Attempts</dt><dd>{s.attempts}</dd></dl></article>)}</div>
  </section>;
}

export default App;
