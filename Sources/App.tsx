import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api } from "./lib/api";
import { parseEntryText } from "./lib/importParser";
import type { DeckStats, DeckSummary, SemanticRuntimeStatus, StorageSettings, StudyCard, StudyMode, SubmitResult, VoicevoxRuntimeStatus } from "./lib/types";
import { activeCardTimerRuns, cardAfterResult, emptyPitchSelection, enterAction, exitStudyForDeckNavigation, pitchSubmission, setPitchLevel, shouldAutoPlayAfterWrittenAnswer, type PitchLevel, type PitchSelection } from "./lib/studyFlow";
import { completionDelayMs, firstMeaningfulInputAt, isMeaningfulInput, recallHasTimedOut } from "./lib/studyTimers";

type View = "decks" | "editor" | "study" | "stats" | "settings";

function App() {
  const [view, setView] = useState<View>("decks");
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [selected, setSelected] = useState<DeckSummary | null>(null);
  const [card, setCard] = useState<StudyCard | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [stats, setStats] = useState<DeckStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticRuntimeStatus | null>(null);
  const [voicevoxStatus, setVoicevoxStatus] = useState<VoicevoxRuntimeStatus | null>(null);

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
    <main className="app-shell">
      {view !== "study" && <header className="topbar">
        <div className="brand" onClick={() => void openDecks()}>
          <span className="brand-mark">鍛</span>
          <div><strong>TANREN</strong><small>鍛錬</small></div>
        </div>
        <div className="topbar-actions">
          {view !== "decks" && <button className="ghost" onClick={() => void openDecks()}>Decks</button>}
          {view === "decks" && <button className="ghost icon-button" aria-label="Settings" title="Settings" onClick={() => setView("settings")}>⚙</button>}
        </div>
      </header>}

      {error && <div className="error">{error}</div>}

      {view === "decks" && (
        <DeckList
          decks={decks}
          semanticStatus={semanticStatus}
          voicevoxStatus={voicevoxStatus}
          onRefresh={refresh}
          onEdit={(d) => { setSelected(d); setView("editor"); }}
          onStudy={openStudy}
          onStats={openStats}
        />
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
    <div className="section-heading"><div><span className="eyebrow">LOCAL APP</span><h1>Settings</h1><p>자주 만질 필요 없는 항목만 모아뒀어.</p></div></div>
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
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createDeck(name.trim());
    setName("");
    await onRefresh();
  };
  const runtimeIssues = [
    semanticStatus && semanticStatus.phase !== "ready" ? `Semantic ${semanticStatus.phase}${semanticStatus.error ? ` · ${semanticStatus.error}` : ""}` : null,
    voicevoxStatus && voicevoxStatus.phase !== "ready" ? `Voice ${voicevoxStatus.phase}${voicevoxStatus.error ? ` · ${voicevoxStatus.error}` : ""}` : null,
  ].filter(Boolean) as string[];
  return <section className="content">
    <div className="section-heading home-heading"><div><span className="eyebrow">TRAINING LIBRARY</span><h1>Decks</h1><p>고르고, 바로 훈련.</p></div></div>
    {runtimeIssues.length > 0 && <div className="runtime-strip"><span className="runtime-dot" />{runtimeIssues.join("  ·  ")}</div>}
    <form className="create-row" onSubmit={create}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="새 덱 이름" aria-label="새 덱 이름" />
      <button type="submit">새 덱</button>
    </form>
    <div className="deck-grid">
      {decks.map((d) => <article className="deck-card" key={d.id}>
        <div className="deck-card-head"><small>{d.source_language} → {d.target_language}</small><span>{d.entry_count}</span></div>
        <h2>{d.name}</h2>
        <div className="deck-meta"><span>Round {d.current_round}</span>{d.active_stage && <span>{d.active_stage}</span>}</div>
        <div className="deck-actions">
          <button className="deck-primary" onClick={() => onStudy(d)} disabled={d.entry_count === 0}>{d.active_stage ? "계속하기" : "시작"}<span aria-hidden="true">→</span></button>
          <div className="deck-secondary-actions"><button className="ghost" onClick={() => onEdit(d)}>Edit</button><button className="ghost" onClick={() => onStats(d)}>Stats</button></div>
        </div>
        {d.study_ranges.length > 0 && <details className="range-picker"><summary>구간 선택</summary><div className="range-book" aria-label={`${d.name} study ranges`}>
          {d.study_ranges.map((range) => <button key={range.stage_index} className={range.cumulative ? "range-card cumulative" : "range-card"} onClick={() => onStudy(d, range.stage_index)} title={d.active_stage ? "기존 진행 대신 이 구간으로 새 세션을 시작" : "이 구간으로 시작"}>{range.label.replace(" · cumulative", "")}</button>)}
        </div></details>}
      </article>)}
      {decks.length === 0 && <div className="empty"><strong>아직 덱이 없어.</strong><span>위에서 이름 하나만 정하면 바로 시작할 수 있어.</span></div>}
    </div>
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
    <div className="section-heading"><div><span className="eyebrow">DECK EDITOR</span><h1>{name}</h1><p><code>일본어[TAB]한국어 뜻</code> 또는 CSV를 붙여넣어.</p></div></div>
    <div className="deck-settings">
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Deck name" />
      <div className="mode-options">{(["recognition", "listening", "production"] as StudyMode[]).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} /> {mode}</label>)}</div>
      <div className="actions"><button disabled={!name.trim() || modes.length === 0} onClick={() => void save()}>Save settings</button><button className="ghost danger" onClick={() => void remove()}>Delete deck</button></div>
    </div>
    <textarea className="bulk-input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
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
    setInputWarning(null);
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
    completionTimer.current = window.setTimeout(async () => {
      if (composing.current || timeoutSent.current) return;
      timeoutSent.current = true;
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

  return <section className="study">
    <div className="study-top">
      <div className="mode"><span className="mode-chip">{card.mode}</span><span>{card.answer_language}</span></div>
      <div className="study-stage">{card.stage_label}</div>
      <div className="study-top-right"><span className="remaining"><strong>{card.remaining}</strong> / {card.total}</span><button className="ghost" onClick={onExit}>Exit</button></div>
    </div>
    <div className="progress"><div style={{ width: `${100 * (1 - card.remaining / Math.max(card.total, 1))}%` }} /></div>
    {(inputWarning ?? card.input_warning) && <div className="study-warning">{inputWarning ?? card.input_warning}</div>}
    <div className="study-center">
      <div className="study-card-viewport">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            className="study-card"
            key={card.variant_id}
            initial={reduceMotion ? false : { x: -48, opacity: 0, scale: .985 }}
            animate={{ x: 0, opacity: 1, scale: 1, rotate: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 132, opacity: 0, scale: .97, rotate: 1.1 }}
            transition={reduceMotion ? { duration: .01 } : { x: { type: "spring", stiffness: 520, damping: 42, mass: .55 }, opacity: { duration: .14 }, scale: { duration: .16 }, rotate: { duration: .16 } }}
          >
            <div className={card.mode === "listening" ? "question listening-question" : "question"}>{card.mode === "listening" ? <><span className="audio-orb" aria-hidden="true">▶</span><span>한 번 듣고 입력</span></> : card.question}</div>
            {pitchQuestion && <div className="pitch-panel">
              <small>{pitchQuestion.confidence} · {pitchQuestion.gate_enabled ? "graded" : "reference"}</small>
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
                    <span className="pitch-dot" />
                    <span className="mora-label">{mora}</span>
                    <span className="pitch-level">{level === 1 ? "H" : level === 0 ? "L" : "·"}</span>
                  </button>;
                })}
              </div>
              <p>H/L · ↑/↓ 선택 · ←/→ 이동 · Enter 제출</p>
              <button className="secondary pitch-submit" type="button" disabled={!pitchSubmission(pitchLevels)} onClick={() => void submitPitchContour()}>제출</button>
            </div>}
            {review && <motion.div className="review-card" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><span className="feedback-label">ANSWER</span><strong>{result?.canonical_answer}</strong>{result?.reading && <span>{result.reading}</span>}<p>{result?.message}</p>{card.audio_path && <button className="secondary compact-button" type="button" onClick={playCachedAnswer}>▶ 정답 듣기</button>}</motion.div>}
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
              placeholder={review ? "Enter → next" : "답 입력 · 모르면 빈 Enter"}
              disabled={ambiguous}
              autoComplete="off"
              spellCheck={false}
            />}
            {!review && !ambiguous && !pitchQuestion && <div className="study-hint"><kbd>Enter</kbd><span>확인</span><i /> <span>빈 Enter = 모름</span></div>}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  </section>;
}

function StatsView({ deck, stats }: { deck: DeckSummary; stats: DeckStats[] }) {
  const pct = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  return <section className="content"><div className="section-heading"><div><h1>{deck.name} Statistics</h1><p>통계는 스케줄링에 영향을 주지 않아.</p></div></div>
    <div className="stats-grid">{stats.map((s) => <article className="stat-card" key={s.mode}><h2>{s.mode}</h2><dl><dt>Base</dt><dd>{pct(s.base_accuracy)}</dd><dt>Pitch</dt><dd>{pct(s.pitch_accuracy)}</dd><dt>Joint</dt><dd>{pct(s.joint_accuracy)}</dd><dt>Median recall</dt><dd>{s.median_recall_latency_ms == null ? "—" : `${s.median_recall_latency_ms} ms`}</dd><dt>Attempts</dt><dd>{s.attempts}</dd></dl></article>)}</div>
  </section>;
}

export default App;
