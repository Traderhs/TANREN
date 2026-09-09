import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import { api } from "./lib/api";
import {
  activeCardTimerRuns,
  cardAfterResult,
  emptyPitchSelection,
  pitchSubmission,
  reviewAnswerForMode,
  setPitchLevel,
  type PitchLevel,
  type PitchSelection,
} from "./lib/studyFlow";
import { completionDelayMs, firstMeaningfulInputAt, isMeaningfulInput } from "./lib/studyTimers";
import { japaneseImeEnterCommitsYomi, japaneseImeKeyStartsInput, japaneseImeKeyTap, loadJapaneseImeRuntime } from "./lib/japaneseIme";
import type { JapaneseImeSegment, JapaneseImeSession } from "./lib/japaneseIme";
import { playEffectSound } from "./lib/soundEffects";
import type { AudioSettings, DeckSummary, PitchQuestion, StudyCard, SubmitResult } from "./lib/types";

function answerPlaceholder(card: StudyCard | null) {
  if (!card) return "답을 입력해주세요";
  if (card.mode === "listening") return "들은 표현을 입력해주세요";
  return card.mode === "reading" ? "뜻을 입력해주세요" : "표현을 입력해주세요";
}

function formatTimerSeconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}초`;
}

function formatStageStudyTime(ms: number) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function PitchTrace({
  morae,
  levels,
  tone = "neutral",
  cursor = null,
  traceRef,
  onScroll,
  showMoraLabels = true,
  logicalWidth,
}: {
  morae: string[];
  levels: Array<number | null>;
  tone?: "neutral" | "correct" | "incorrect";
  cursor?: number | null;
  traceRef?: Ref<HTMLDivElement>;
  onScroll?: (scrollLeft: number) => void;
  showMoraLabels?: boolean;
  logicalWidth?: number;
}) {
  const count = Math.max(morae.length, 1);
  const width = logicalWidth ?? Math.max(240, count * 76);
  const step = width / count;
  const points = morae.map((_, index) => {
    const level = levels[index];
    return {
      x: step * index + step / 2,
      y: level === 1 ? 24 : level === 0 ? 64 : 44,
      level,
    };
  });

  const minimumReadableWidth = logicalWidth ?? Math.max(240, count * 48);

  return <div
    ref={traceRef}
    className={`learning-pitch-trace is-${tone} ${showMoraLabels ? "has-mora-labels" : ""}`}
    onScroll={onScroll ? (event) => onScroll(event.currentTarget.scrollLeft) : undefined}
  >
    <svg
      viewBox={`0 0 ${width} ${showMoraLabels ? 98 : 78}`}
      style={{ width: `max(100%, ${minimumReadableWidth}px)` }}
      role="img"
      aria-label={`피치 ${morae.join(" ")}`}
    >
      <line className="learning-pitch-guide" x1="0" y1="24" x2={width} y2="24" />
      <line className="learning-pitch-guide" x1="0" y1="64" x2={width} y2="64" />
      {points.length > 1 && <polyline className="learning-pitch-line" points={points.map((point) => `${point.x},${point.y}`).join(" ")} />}
      {points.map((point, index) => <g key={`${morae[index]}-${index}`}>
        {cursor === index && <circle className="learning-pitch-cursor" cx={point.x} cy={point.y} r="11" />}
        <circle className={`learning-pitch-node ${point.level == null ? "is-unset" : ""}`} cx={point.x} cy={point.y} r="5.5" />
        {showMoraLabels && <text className={`learning-pitch-mora-label ${cursor === index ? "is-current" : ""}`} x={point.x} y="92" textAnchor="middle">{morae[index]}</text>}
      </g>)}
    </svg>
  </div>;
}

export function BookStudy({
  deck,
  initialResult,
  audioSettings,
  onExit,
  exiting = false,
  onExitFadeComplete,
}: {
  deck: DeckSummary;
  initialResult: SubmitResult;
  audioSettings: AudioSettings;
  onExit: () => Promise<void>;
  exiting?: boolean;
  onExitFadeComplete?: () => void;
}) {
  const [result, setResult] = useState(initialResult);
  const [card, setCard] = useState(initialResult.card ?? null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inputWarning, setInputWarning] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [studyActivityNow, setStudyActivityNow] = useState(() => performance.now());
  const [playing, setPlaying] = useState(false);
  const [listeningAudioFinished, setListeningAudioFinished] = useState(
    initialResult.card?.mode !== "listening" || !initialResult.card?.audio_path,
  );
  const [imeSegments, setImeSegments] = useState<JapaneseImeSegment[]>([]);
  const [imeReady, setImeReady] = useState(false);
  const [pitch, setPitch] = useState<PitchSelection>(emptyPitchSelection(initialResult.pitch?.morae.length ?? 0));
  const [pitchCursor, setPitchCursor] = useState(0);
  const [submittedPitch, setSubmittedPitch] = useState<PitchSelection | null>(null);
  const [submittedPitchQuestion, setSubmittedPitchQuestion] = useState<PitchQuestion | null>(null);
  const [submittedAnswerKnown, setSubmittedAnswerKnown] = useState(false);

  const ime = useRef<JapaneseImeSession | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const learningSurface = useRef<HTMLElement>(null);
  const transitionContent = useRef<HTMLDivElement>(null);
  const exitTurnStarted = useRef(false);
  const stageComplete = useRef(false);
  const pitchControl = useRef<HTMLDivElement>(null);
  const pitchScroll = useRef<HTMLDivElement>(null);
  const reviewExpectedPitch = useRef<HTMLDivElement>(null);
  const reviewSubmittedPitch = useRef<HTMLDivElement>(null);
  const syncingReviewPitchScroll = useRef(false);
  const imeCandidateList = useRef<HTMLDivElement>(null);
  const cardRef = useRef(card);
  const answerRef = useRef(answer);
  const selection = useRef({ start: 0, end: 0 });
  const lastTotal = useRef(initialResult.card?.total ?? 0);
  const lastStage = useRef(initialResult.card?.stage ?? deck.current_stage);
  const timeoutSent = useRef(false);
  const locked = useRef(false);
  const composing = useRef(false);
  const listeningTimerStarted = useRef(
    initialResult.card?.mode !== "listening" || !initialResult.card?.audio_path,
  );
  const studyActivityStartedAt = useRef<number | null>(null);
  const stageStudyDuration = useRef(initialResult.card?.active_duration_ms ?? 0);
  const studyActivityMode = useRef(card?.mode ?? null);
  const pendingStudyActivity = useRef(new Map<StudyCard["mode"] | "all", number>());
  const timing = useRef({
    start: performance.now(),
    first: null as number | null,
    last: null as number | null,
    gaps: [] as number[],
    compositionStart: 0,
    compositionMs: 0,
    compositionEnd: null as number | null,
  });

  cardRef.current = card;
  answerRef.current = answer;

  const active = activeCardTimerRuns(card, result);
  const complete = result.status === "stage_complete";
  stageComplete.current = complete;
  const cycleComplete = result.status === "cycle_complete";
  const review = result.status === "review" || result.status === "fail";
  const ambiguous = result.status === "ambiguous";
  const pitchQuestion = result.pitch ?? null;
  const pitchTrackWidth = pitchQuestion ? Math.max(320, pitchQuestion.morae.length * 76) : 320;
  const pitchCorrection = Boolean(pitchQuestion && result.failure_type);
  const japanese = card?.answer_language === "ja-JP";
  const preedit = imeSegments.map((segment) => segment.text).join("");
  const candidates = imeSegments.find((segment) => segment.kind === "focus" && segment.candidates?.length);
  const total = card?.total ?? lastTotal.current;

  const syncReviewPitchScroll = (target: HTMLDivElement | null, scrollLeft: number) => {
    if (!target || syncingReviewPitchScroll.current || target.scrollLeft === scrollLeft) return;
    syncingReviewPitchScroll.current = true;
    target.scrollLeft = scrollLeft;
    requestAnimationFrame(() => {
      syncingReviewPitchScroll.current = false;
    });
  };
  const resolvedPass = review && !result.failure_type && !result.card;
  const displayRemaining = card ? Math.max(0, card.remaining - (resolvedPass ? 1 : 0)) : 0;
  const completedCount = complete ? total : card ? Math.max(0, total - displayRemaining) : 0;
  const progress = complete ? 100 : total > 0 ? Math.max(0, Math.min(100, completedCount / total * 100)) : 0;
  const now = timing.current.start + elapsed;
  const recalling = timing.current.first === null;
  const recallLeft = Math.max(0, (card?.recall_timeout_ms ?? 0) - (recalling ? elapsed : timing.current.first! - timing.current.start));
  const inputDelay = completionDelayMs(card?.completion_idle_ms, composing.current, answer, timing.current.compositionEnd, timing.current.last ?? now);
  const inputLeft = inputDelay === null ? null : Math.max(0, inputDelay - (now - (timing.current.last ?? now)));
  const inputElapsed = recalling ? 0 : Math.max(0, now - timing.current.first!);
  const completionTimerEnabled = card?.completion_idle_ms != null;
  const inputClock = recalling
    ? "대기"
    : completionTimerEnabled
      ? formatTimerSeconds(inputLeft ?? card?.completion_idle_ms ?? 0)
      : formatTimerSeconds(inputElapsed);
  const stageStudyTimeMs = stageStudyDuration.current + (studyActivityStartedAt.current == null
    ? 0
    : Math.max(0, studyActivityNow - studyActivityStartedAt.current));

  const studyViewIsActive = () => document.visibilityState === "visible" && document.hasFocus() && !stageComplete.current;

  function collectStudyActivity(stop = false) {
    const currentNow = performance.now();
    if (studyActivityStartedAt.current != null) {
      const duration = Math.max(0, currentNow - studyActivityStartedAt.current);
      const mode = studyActivityMode.current ?? "all";
      stageStudyDuration.current += duration;
      pendingStudyActivity.current.set(mode, (pendingStudyActivity.current.get(mode) ?? 0) + duration);
    }
    studyActivityStartedAt.current = !stop && studyViewIsActive() ? currentNow : null;
    setStudyActivityNow(currentNow);
  }

  async function flushStudyActivity(stop = false) {
    collectStudyActivity(stop);
    const pending = [...pendingStudyActivity.current.entries()];
    pendingStudyActivity.current.clear();
    await Promise.all(pending.map(async ([mode, duration]) => {
      const durationMs = Math.round(duration);
      if (durationMs <= 0) return;
      try {
        await api.recordStudyActivity(deck.id, mode === "all" ? null : mode, durationMs);
      } catch {
        pendingStudyActivity.current.set(mode, (pendingStudyActivity.current.get(mode) ?? 0) + duration);
      }
    }));
  }

  async function continueReview() {
    await flushStudyActivity(true);
    try {
      const next = await api.continueReview();
      if (next.status !== "stage_complete" && studyViewIsActive()) {
        studyActivityStartedAt.current = performance.now();
      }
      return next;
    } catch (cause) {
      if (studyViewIsActive()) studyActivityStartedAt.current = performance.now();
      throw cause;
    }
  }

  async function continueCycle() {
    await flushStudyActivity(true);
    try {
      const next = await api.continueCycle();
      if (next.status !== "stage_complete" && studyViewIsActive()) {
        studyActivityStartedAt.current = performance.now();
      }
      return next;
    } catch (cause) {
      if (studyViewIsActive()) studyActivityStartedAt.current = performance.now();
      throw cause;
    }
  }

  function exitStudy() {
    void run(async () => {
      await flushStudyActivity(true);
      try { await onExit(); }
      catch (cause) {
        if (studyViewIsActive()) studyActivityStartedAt.current = performance.now();
        throw cause;
      }
    });
  }

  function resetCardInput(nextCard: StudyCard) {
    audio.current?.pause();
    lastTotal.current = nextCard.total;
    lastStage.current = nextCard.stage;
    timeoutSent.current = false;
    setAnswer("");
    answerRef.current = "";
    setPlaying(false);
    const listeningReady = nextCard.mode !== "listening" || !nextCard.audio_path;
    listeningTimerStarted.current = listeningReady;
    setListeningAudioFinished(listeningReady);
    setInputWarning("");
    setImeSegments([]);
    selection.current = { start: 0, end: 0 };
    setSubmittedPitch(null);
    setSubmittedPitchQuestion(null);
    setSubmittedAnswerKnown(false);
    setPitch(emptyPitchSelection(0));
    setPitchCursor(0);
    timing.current = {
      start: performance.now(),
      first: null,
      last: null,
      gaps: [],
      compositionStart: 0,
      compositionMs: 0,
      compositionEnd: null,
    };
    setElapsed(0);
  }

  function startListeningTimer() {
    const currentCard = cardRef.current;
    if (!currentCard || currentCard.mode !== "listening" || listeningTimerStarted.current) return;
    listeningTimerStarted.current = true;
    const currentNow = performance.now();
    timing.current = {
      start: currentNow,
      first: null,
      last: null,
      gaps: [],
      compositionStart: 0,
      compositionMs: 0,
      compositionEnd: null,
    };
    setElapsed(0);
    setListeningAudioFinished(true);
  }

  useEffect(() => {
    if (!active || busy || card?.mode !== "listening" || !listeningAudioFinished) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, busy, card?.variant_id, card?.mode, listeningAudioFinished]);

  async function run(action: () => Promise<SubmitResult | void>, reviewCorrectOverride?: boolean) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (!next) return;

      if (next.status === "review") {
        const reviewCorrect = !next.failure_type && reviewCorrectOverride !== false;
        playEffectSound(reviewCorrect ? "correct" : "incorrect", audioSettings.effect_volume);
      } else if (next.status === "stage_complete") {
        playEffectSound("complete", audioSettings.effect_volume);
      }

      const previousCard = cardRef.current;
      const nextCard = cardAfterResult(previousCard, next);
      const applyNext = () => {
        if (next.card) resetCardInput(next.card);
        else if (next.status === "pitch" && next.pitch) {
          setPitch(emptyPitchSelection(next.pitch.morae.length));
          setPitchCursor(0);
          setSubmittedPitch(null);
          setSubmittedPitchQuestion(null);
        }

        cardRef.current = nextCard;
        setCard(nextCard);
        setResult(next);
      };

      const shouldSlide = (next.card && next.status === "pass")
        || next.status === "cycle_complete"
        || next.status === "stage_complete";
      const canSlide = shouldSlide
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (canSlide && transitionContent.current) {
        const content = transitionContent.current;
        const outgoing = content.animate([
          { transform: "translateX(0)", opacity: 1 },
          { transform: "translateX(-56px)", opacity: 0 },
        ], {
          duration: 170,
          easing: "cubic-bezier(.4, 0, 1, 1)",
          fill: "forwards",
        });
        await outgoing.finished.catch(() => undefined);

        flushSync(applyNext);
        const incoming = content.animate([
          { transform: "translateX(56px)", opacity: 0 },
          { transform: "translateX(0)", opacity: 1 },
        ], {
          duration: 210,
          easing: "cubic-bezier(0, 0, .2, 1)",
          fill: "forwards",
        });
        outgoing.cancel();
        await incoming.finished.catch(() => undefined);
        incoming.cancel();
      } else {
        applyNext();
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function handleInput(value: string, recordKeyActivity = true) {
    const currentNow = performance.now();
    const currentTiming = timing.current;
    currentTiming.first = firstMeaningfulInputAt(currentTiming.first, value, currentNow);
    if (isMeaningfulInput(value) && !composing.current) {
      if (recordKeyActivity && currentTiming.last !== null) currentTiming.gaps.push(Math.round(currentNow - currentTiming.last));
      currentTiming.last = currentNow;
    }
    answerRef.current = value;
    setAnswer(value);
  }

  function insertText(text: string) {
    const { start, end } = selection.current;
    const next = answerRef.current.slice(0, start) + text + answerRef.current.slice(end);
    handleInput(next, false);
    selection.current = { start: start + text.length, end: start + text.length };
    requestAnimationFrame(() => input.current?.setSelectionRange(selection.current.start, selection.current.end));
  }

  function hostKey(key: string) {
    const value = answerRef.current;
    let { start, end } = selection.current;
    const previous = start - (Array.from(value.slice(0, start)).pop()?.length ?? 0);
    const following = end + (Array.from(value.slice(end))[0]?.length ?? 0);
    if (key === "Backspace" || key === "Delete") {
      if (start === end) {
        if (key === "Backspace") start = previous;
        else end = following;
      }
      selection.current = { start, end };
      insertText("");
      return;
    }
    if (key === "ArrowLeft") start = end = previous;
    if (key === "ArrowRight") start = end = following;
    if (key === "Home") start = end = 0;
    if (key === "End") start = end = value.length;
    selection.current = { start, end };
    input.current?.setSelectionRange(start, end);
  }

  useEffect(() => {
    if (!active || !card) return;
    input.current?.focus();
    let cancelled = false;
    let retry: number | undefined;
    setImeReady(false);
    setImeSegments([]);
    selection.current = { start: 0, end: 0 };

    if (japanese) {
      void loadJapaneseImeRuntime().then((runtime) => {
        if (cancelled) return;
        const finishComposition = () => {
          if (composing.current) timing.current.compositionMs += performance.now() - timing.current.compositionStart;
          composing.current = false;
          timing.current.compositionEnd = performance.now();
          timing.current.last = performance.now();
          setImeSegments([]);
        };
        ime.current = runtime.createSession({
          show: (segments) => {
            if (cancelled) return;
            if (!composing.current) timing.current.compositionStart = performance.now();
            composing.current = true;
            setImeSegments(segments);
          },
          hide: () => { if (!cancelled) finishComposition(); },
          commit: (text) => {
            if (cancelled) return;
            finishComposition();
            insertText(text);
          },
          hostKey: (key) => { if (!cancelled) hostKey(key); },
        });
        ime.current.setActive(true);
        setImeReady(true);
        input.current?.focus();
    }).catch(() => { if (!cancelled) setInputWarning("내장 일본어 입력기를 불러오지 못했어요"); });
    } else {
      const activate = () => {
        input.current?.focus();
        void api.activateInputProfile(card.answer_language)
          .then((warning) => { if (!cancelled) setInputWarning(warning ?? ""); })
          .catch((cause) => { if (!cancelled) setInputWarning(String(cause)); });
      };
      activate();
      retry = window.setTimeout(activate, 100);
    }

    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
      ime.current?.reset();
      ime.current?.setActive(false);
      ime.current = null;
      composing.current = false;
    };
  }, [card?.variant_id, card?.answer_language, active, japanese]);

  useEffect(() => {
    if (!preedit) return;
    let offset = 0;
    for (const segment of imeSegments) {
      if (segment.kind === "yomi" && segment.caretOffset != null) {
        offset += Array.from(segment.text).slice(0, segment.caretOffset).join("").length;
        break;
      }
      offset += segment.text.length;
    }
    const caret = selection.current.start + offset;
    input.current?.setSelectionRange(caret, caret);
    imeCandidateList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [imeSegments]);

  useEffect(() => {
    if (!active || busy) return;
    input.current?.focus();
  }, [active, busy]);

  useEffect(() => {
    if (!active || busy) return;
    const keepInputFocus = (event: MouseEvent) => {
      if (event.button !== 0 || event.target === input.current) return;
      event.preventDefault();
    };
    const keepInputFocusFromPointer = (event: PointerEvent) => {
      if (event.button !== 0 || event.target === input.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, input, textarea, select, a, [role='button'], [contenteditable='true']")) return;
      event.preventDefault();
    };
    window.addEventListener("pointerdown", keepInputFocusFromPointer, true);
    document.addEventListener("mousedown", keepInputFocus, true);
    return () => {
      window.removeEventListener("pointerdown", keepInputFocusFromPointer, true);
      document.removeEventListener("mousedown", keepInputFocus, true);
    };
  }, [active, busy, card?.variant_id]);

  useEffect(() => {
    if (!review || pitchQuestion || busy) return;
    const nextOnEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.isComposing) return;
      event.preventDefault();
      void run(continueReview);
    };
    window.addEventListener("keydown", nextOnEnter, true);
    return () => window.removeEventListener("keydown", nextOnEnter, true);
  }, [review, pitchQuestion, busy, card?.variant_id]);

  useEffect(() => {
    if (!cycleComplete || busy) return;
    const nextCycleOnEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.isComposing) return;
      event.preventDefault();
      void run(continueCycle);
    };
    window.addEventListener("keydown", nextCycleOnEnter, true);
    return () => window.removeEventListener("keydown", nextCycleOnEnter, true);
  }, [cycleComplete, busy, card?.variant_id]);

  useEffect(() => {
    if (!complete || busy) return;
    const exitOnEnter = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.isComposing) return;
      event.preventDefault();
      exitStudy();
    };
    window.addEventListener("keydown", exitOnEnter, true);
    return () => window.removeEventListener("keydown", exitOnEnter, true);
  }, [complete, busy]);

  useEffect(() => {
    if (!pitchQuestion) return;
    setPitch(emptyPitchSelection(pitchQuestion.morae.length));
    setPitchCursor(0);
    const frame = requestAnimationFrame(() => pitchControl.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, pitchQuestion?.reading, pitchQuestion?.morae.join("|")]);

  useEffect(() => {
    if (!pitchQuestion || busy) return;
    const control = pitchControl.current;
    if (!control) return;
    let restoreFrame = 0;
    const restorePitchFocus = () => {
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = window.requestAnimationFrame(() => {
        if (document.visibilityState !== "visible" || !document.hasFocus()) return;
        control.focus({ preventScroll: true });
      });
    };
    const keepPitchFocusFromPointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target === control) return;
      event.preventDefault();
      restorePitchFocus();
    };
    const keepPitchFocusFromMouse = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target === control) return;
      event.preventDefault();
      restorePitchFocus();
    };
    const recoverLostPitchFocus = () => {
      if (document.activeElement === control) return;
      restorePitchFocus();
    };
    window.addEventListener("pointerdown", keepPitchFocusFromPointer, true);
    document.addEventListener("mousedown", keepPitchFocusFromMouse, true);
    window.addEventListener("focus", restorePitchFocus);
    document.addEventListener("visibilitychange", restorePitchFocus);
    document.addEventListener("focusin", recoverLostPitchFocus, true);
    control.addEventListener("focusout", recoverLostPitchFocus);
    restorePitchFocus();
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener("pointerdown", keepPitchFocusFromPointer, true);
      document.removeEventListener("mousedown", keepPitchFocusFromMouse, true);
      window.removeEventListener("focus", restorePitchFocus);
      document.removeEventListener("visibilitychange", restorePitchFocus);
      document.removeEventListener("focusin", recoverLostPitchFocus, true);
      control.removeEventListener("focusout", recoverLostPitchFocus);
    };
  }, [card?.variant_id, pitchQuestion?.reading, pitchQuestion?.morae.join("|"), busy]);

  function playAudio(restart = false) {
    const player = audio.current;
    if (!player) return;
    if (restart) {
      player.pause();
      player.currentTime = 0;
    } else if (!player.paused && !player.ended) {
      return;
    }
    player.volume = audioSettings.volume;
    player.playbackRate = audioSettings.playback_rate;
    void player.play().catch(() => {
      setInputWarning("음성을 재생하지 못했어요 재생 버튼으로 다시 시도해 주세요");
      startListeningTimer();
    });
  }

  useEffect(() => {
    const player = audio.current;
    if (player) {
      player.volume = audioSettings.volume;
      player.playbackRate = audioSettings.playback_rate;
    }
    if (active && card?.mode === "listening") playAudio();
  }, [card?.variant_id, card?.audio_path, active, audioSettings]);

  useEffect(() => {
    if (!review || pitchQuestion || !card?.audio_path) return;
    const frame = requestAnimationFrame(() => playAudio(true));
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, card?.audio_path, review, pitchQuestion]);

  useEffect(() => {
    if (!pitchCorrection || !card?.audio_path) return;
    const frame = requestAnimationFrame(() => playAudio());
    return () => cancelAnimationFrame(frame);
  }, [card?.variant_id, card?.audio_path, pitchCorrection]);

  useEffect(() => {
    if (complete) void flushStudyActivity(true);
  }, [complete]);

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
  }, [deck.id]);

  useEffect(() => {
    const interval = window.setInterval(() => setStudyActivityNow(performance.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const nextMode = card?.mode ?? studyActivityMode.current;
    if (nextMode === studyActivityMode.current) return;
    collectStudyActivity(false);
    studyActivityMode.current = nextMode;
  }, [card?.mode]);

  useEffect(() => {
    if (!exiting) {
      exitTurnStarted.current = false;
      return;
    }
    if (exitTurnStarted.current) return;
    exitTurnStarted.current = true;
    void (async () => {
      const surface = learningSurface.current;
      if (surface && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const fade = surface.animate([
          { opacity: 1 },
          { opacity: 0 },
        ], {
          duration: 190,
          easing: "ease-out",
          fill: "forwards",
        });
        await fade.finished.catch(() => undefined);
      }
      onExitFadeComplete?.();
    })();
  }, [exiting]);

  useEffect(() => {
    if (!active || !card || busy || timeoutSent.current) return;
    if (card.mode === "listening" && !listeningAudioFinished) return;
    const interval = window.setInterval(() => {
      const currentNow = performance.now();
      const currentTiming = timing.current;
      setElapsed(currentNow - currentTiming.start);
      const idle = completionDelayMs(card.completion_idle_ms, composing.current, answerRef.current, currentTiming.compositionEnd, currentTiming.last ?? currentNow);
      const recall = currentTiming.first === null && currentNow - currentTiming.start >= card.recall_timeout_ms;
      const completion = currentTiming.last !== null && idle !== null && currentNow - currentTiming.last >= idle;
      if ((recall || completion) && !locked.current && !timeoutSent.current) {
        timeoutSent.current = true;
        setSubmittedAnswerKnown(true);
        void run(() => api.timeoutCurrent(
          card.variant_id,
          recall ? "recall" : "completion",
          answerRef.current,
          Math.round(currentNow - currentTiming.start),
          currentTiming.first === null ? 0 : Math.round(currentNow - currentTiming.first),
        ));
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [active, card?.variant_id, card?.recall_timeout_ms, card?.completion_idle_ms, card?.mode, listeningAudioFinished, busy, error]);

  function submitAnswer() {
    if (!card || !active || locked.current || composing.current || (japanese && !imeReady)) return;
    setSubmittedAnswerKnown(true);
    const currentTiming = timing.current;
    const currentNow = performance.now();
    void run(() => api.submitAnswer(
      card.variant_id,
      answerRef.current,
      Math.round((currentTiming.first ?? currentNow) - currentTiming.start),
      Math.round(currentNow - (currentTiming.first ?? currentNow)),
      currentTiming.gaps,
      Math.round(currentTiming.compositionMs),
    ));
  }

  function focusPitch(index: number, smooth = true) {
    if (!pitchQuestion) return;
    const bounded = Math.max(0, Math.min(index, pitchQuestion.morae.length - 1));
    setPitchCursor(bounded);
    requestAnimationFrame(() => {
      const scroller = pitchScroll.current;
      const target = scroller?.querySelector<HTMLElement>(`[data-pitch-index="${bounded}"]`);
      if (!scroller || !target) return;

      const margin = Math.min(84, scroller.clientWidth * .15);
      const targetLeft = target.offsetLeft;
      const targetRight = targetLeft + target.offsetWidth;
      const visibleLeft = scroller.scrollLeft + margin;
      const visibleRight = scroller.scrollLeft + scroller.clientWidth - margin;

      if (targetLeft < visibleLeft) {
        scroller.scrollTo({ left: Math.max(0, targetLeft - margin), behavior: smooth ? "smooth" : "auto" });
      } else if (targetRight > visibleRight) {
        scroller.scrollTo({ left: targetRight - scroller.clientWidth + margin, behavior: smooth ? "smooth" : "auto" });
      }
    });
  }

  function choosePitch(index: number, level: PitchLevel, advance = false, smooth = true) {
    setPitch((current) => setPitchLevel(current, index, level));
    setPitchCursor(index);
    if (advance && pitchQuestion) focusPitch(Math.min(index + 1, pitchQuestion.morae.length - 1), smooth);
  }

  function submitPitch() {
    if (!card || !pitchQuestion) return;
    const contour = pitchSubmission(pitch);
    if (!contour) return;
    const pitchCorrect = pitchQuestion.allowed_patterns.some((pattern) => (
      pattern.length === contour.length && pattern.every((level, index) => level === contour[index])
    ));
    setSubmittedPitch([...pitch]);
    setSubmittedPitchQuestion(pitchQuestion);
    void run(() => api.submitPitch(card.variant_id, contour), pitchCorrect);
  }

  function pitchKeydown(event: ReactKeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusPitch(index - 1, !event.repeat);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusPitch(index + 1, !event.repeat);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      choosePitch(index, 1, true, !event.repeat);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      choosePitch(index, 0, true, !event.repeat);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitPitch();
    }
  }

  const pitchWasCorrect = submittedPitch && submittedPitchQuestion
    ? submittedPitchQuestion.allowed_patterns.some((pattern) => pattern.length === submittedPitch.length && pattern.every((level, index) => level === submittedPitch[index]))
    : null;
  const expectedPitch = submittedPitchQuestion
    ? submittedPitchQuestion.allowed_patterns.find((pattern) => submittedPitch && pattern.length === submittedPitch.length && pattern.every((level, index) => level === submittedPitch[index]))
      ?? submittedPitchQuestion.allowed_patterns[0]
      ?? null
    : null;
  const submittedAnswerCorrect = !result.failure_type || result.failure_type === "PITCH_WRONG";
  const submittedAnswerLabel = answer.trim();
  const reviewAnswer = card ? reviewAnswerForMode(card.mode, result.canonical_answer) : result.canonical_answer ?? "";
  const reviewCue = card
    ? reviewAnswerForMode(card.mode === "reading" ? "writing" : "reading", result.canonical_answer)
    : "";
  const pitchTitle = pitchQuestion
    ? result.canonical_answer ?? (card?.mode === "reading" || card?.mode === "listening" ? card.question : pitchQuestion.reading)
    : "";

  return <section
    ref={learningSurface}
    className={`book-learning ${card?.mode === "listening" && active ? "is-listening" : ""}`}
    aria-label="학습"
    aria-busy={busy}
  >
    <header className="book-learning-header">
      {review && !pitchQuestion && <button type="button" className="book-close ghost" onClick={exitStudy} disabled={busy} aria-label="책으로 돌아가기" title="책으로 돌아가기" />}
      <div className="learning-stage">
        <span>{card?.stage ?? lastStage.current}단계</span>
        <strong aria-label={`완료 문항 ${completedCount} / ${total}`}>{completedCount.toLocaleString("ko-KR")} / {total.toLocaleString("ko-KR")}</strong>
      </div>
      <div className="learning-stage-time" role="timer" aria-label={`이번 회독 공부 시간 ${formatStageStudyTime(stageStudyTimeMs)}`}>
        <strong>{formatStageStudyTime(stageStudyTimeMs)}</strong>
      </div>
    </header>
    <div className="learning-progress" role="progressbar" aria-label="단계 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{ width: `${progress}%` }} /></div>

    <main ref={transitionContent} className="learning-body book-learning-content">
      {complete ? <div className="learning-complete">
        <span className="learning-complete-mark">✓</span>
        <span className="learning-eyebrow">WELL DONE</span>
        <h1>한 걸음 더, 익숙해졌어요</h1>
        <p>이번 단계를 모두 마쳤어요</p>
      </div> : <>
        {active && <>
          <div className="learning-question">
            {card?.mode === "listening" ? <div className="learning-listening-prompt">
              <div className={`learning-listen ${playing ? "is-playing" : ""}`} aria-hidden="true">
                {playing
                  ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7Z" /></svg>}
              </div>
            </div> : <h1 lang={card?.mode === "writing" ? deck.source_language : deck.target_language}>{card?.question}</h1>}
          </div>

          <form className="learning-answer" onSubmit={(event) => { event.preventDefault(); submitAnswer(); }}>
            <div className="learning-input-row">
              <input
                id="learning-answer"
                aria-label={card?.mode === "reading" ? "뜻 답변" : "표현 답변"}
                ref={input}
                value={preedit ? answer.slice(0, selection.current.start) + preedit + answer.slice(selection.current.end) : answer}
                readOnly={japanese}
                disabled={busy || (card?.mode === "listening" && !listeningAudioFinished)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                lang={card?.answer_language}
                placeholder={answerPlaceholder(card)}
                onSelect={(event) => {
                  if (!preedit) selection.current = {
                    start: event.currentTarget.selectionStart ?? 0,
                    end: event.currentTarget.selectionEnd ?? 0,
                  };
                }}
                onPaste={(event) => {
                  if (!japanese || !active) return;
                  event.preventDefault();
                  const text = event.clipboardData.getData("text");
                  if (!text) return;
                  ime.current?.reset();
                  setImeSegments([]);
                  if (composing.current) timing.current.compositionMs += performance.now() - timing.current.compositionStart;
                  composing.current = false;
                  timing.current.compositionEnd = performance.now();
                  const currentNow = performance.now();
                  timing.current.first = firstMeaningfulInputAt(timing.current.first, text, currentNow);
                  timing.current.last = currentNow;
                  insertText(text);
                }}
                onBeforeInput={(event) => { if (japanese) event.preventDefault(); }}
                onCompositionStart={() => {
                  composing.current = true;
                  timing.current.compositionStart = performance.now();
                }}
                onCompositionEnd={(event) => {
                  composing.current = false;
                  const currentNow = performance.now();
                  timing.current.compositionMs += currentNow - timing.current.compositionStart;
                  timing.current.compositionEnd = currentNow;
                  timing.current.first = firstMeaningfulInputAt(timing.current.first, event.currentTarget.value, currentNow);
                  timing.current.last = currentNow;
                }}
                onKeyDown={(event) => {
                  if (japanese && active) {
                    if (!imeReady) {
                      if (event.key !== "Tab") event.preventDefault();
                      return;
                    }
                    const tap = japaneseImeKeyTap(event.nativeEvent);
                    if (japaneseImeKeyStartsInput(tap)) {
                      const currentNow = performance.now();
                      const currentTiming = timing.current;
                      currentTiming.first ??= currentNow;
                      if (currentTiming.last !== null) currentTiming.gaps.push(Math.round(currentNow - currentTiming.last));
                      currentTiming.last = currentNow;
                    }
                    const submitAfterYomiCommit = event.key === "Enter" && japaneseImeEnterCommitsYomi(imeSegments);
                    if (ime.current?.feed(tap)) {
                      event.preventDefault();
                      if (submitAfterYomiCommit) submitAnswer();
                      return;
                    }
                    if (!["Tab", "Enter"].includes(event.key) && !tap.ctrlKey && !tap.metaKey && !tap.altKey) {
                      event.preventDefault();
                      if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) hostKey(event.key);
                      else if (tap.key.length === 1) insertText(tap.key === " " && !tap.shiftKey ? "　" : tap.key);
                      return;
                    }
                  }
                  if (event.key === "Enter") {
                    if (event.nativeEvent.isComposing || composing.current || (!japanese && event.keyCode === 229)) {
                      event.preventDefault();
                      return;
                    }
                    event.preventDefault();
                    submitAnswer();
                  }
                }}
                onKeyUp={(event) => {
                  if (japanese && active && ime.current?.feedUp(japaneseImeKeyTap(event.nativeEvent))) event.preventDefault();
                }}
                onChange={(event) => {
                  handleInput(event.target.value);
                }}
              />
              {candidates && <div ref={imeCandidateList} className="ime-candidate-list" role="listbox" aria-label="일본어 변환 후보">
                {candidates.candidates?.map((candidate, index) => <button
                  key={`${candidate}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === candidates.candidateIndex}
                  className={`ime-candidate ${index === candidates.candidateIndex ? "is-selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    ime.current?.selectCandidate(index);
                    requestAnimationFrame(() => input.current?.focus());
                  }}
                ><span>{index < 9 ? index + 1 : ""}</span><strong>{candidate}</strong></button>)}
              </div>}
            </div>
            {japanese && !imeReady && <p className="learning-input-status">일본어 입력 준비 중…</p>}
            <div className="learning-timers" aria-label="학습 타이머">
              <div className={`learning-timer ${recalling ? "is-active" : ""}`} role="timer" aria-label="회상 남은 시간">
                <span>회상</span><strong>{formatTimerSeconds(recallLeft)}</strong><i aria-hidden="true"><b style={{ width: `${recallLeft / Math.max(1, card?.recall_timeout_ms ?? 1) * 100}%` }} /></i>
              </div>
              <div className={`learning-timer ${!recalling ? "is-active" : ""}`} role="timer" aria-label={completionTimerEnabled ? "입력 남은 시간" : "입력 경과 시간"}>
                <span>입력</span><strong>{inputClock}</strong><i aria-hidden="true"><b style={{ width: `${recalling ? 0 : inputLeft !== null ? Math.min(100, inputLeft / Math.max(1, inputDelay ?? 1) * 100) : 100}%` }} /></i>{!completionTimerEnabled && <small>타수 측정 기간이에요</small>}
              </div>
            </div>
          </form>
        </>}

        {cycleComplete && <div className="learning-complete" aria-live="polite">
          <span className="learning-complete-mark">↻</span>
          <h1>{result.message}</h1>
          <p>남은 {(card?.remaining ?? 0).toLocaleString("ko-KR")}개를 다시 풀어요</p>
        </div>}

        {pitchQuestion && <div
          className="learning-feedback learning-pitch-step"
          style={{ width: `min(${Math.max(800, pitchTrackWidth)}px, 100%)` }}
        >
          <strong className="learning-target-expression" lang={deck.target_language}>{pitchTitle}</strong>
          <div
            ref={pitchControl}
            className="learning-pitch-control"
            style={{ width: `min(${pitchTrackWidth}px, 100%)` }}
            role="group"
            aria-label="피치 입력"
            tabIndex={0}
            onKeyDown={(event) => pitchKeydown(event, pitchCursor)}
          >
            <div ref={pitchScroll} className="learning-pitch-scroll">
              <div
                className="learning-pitch-track"
                style={{
                  width: `max(100%, ${pitchTrackWidth}px)`,
                  ["--pitch-mora-count" as string]: pitchQuestion.morae.length,
                }}
              >
                <PitchTrace
                  morae={pitchQuestion.morae}
                  levels={pitch}
                  cursor={pitchCursor}
                  showMoraLabels={false}
                  logicalWidth={pitchTrackWidth}
                />
                <div className="learning-pitch" aria-hidden="true">
                  {pitchQuestion.morae.map((mora, index) => <div
                    className={`learning-pitch-mora ${pitchCursor === index ? "is-current" : ""} ${pitch[index] != null ? "is-set" : ""}`}
                    data-pitch-index={index}
                    key={`${mora}-${index}`}
                  >
                    <span lang="ja">{mora}</span>
                    <small>{pitch[index] === 1 ? "↑" : pitch[index] === 0 ? "↓" : pitchCursor === index ? "↕" : "·"}</small>
                  </div>)}
                </div>
              </div>
            </div>
          </div>
        </div>}

        {ambiguous && <div className="learning-feedback learning-answer-review learning-adjudication" aria-live="polite">
          <div className="learning-review-cue learning-adjudication-cue">
            <strong lang={deck.target_language}>{card?.question}</strong>
            {deck.target_language === "ja-JP" && result.reading && result.reading !== card?.question && <span className="learning-reading" lang="ja">{result.reading}</span>}
          </div>
          <div className={`learning-review-result-stack ${submittedAnswerKnown ? "has-user-answer" : ""}`}>
            <div className={`learning-answer-comparison ${submittedAnswerKnown ? "has-user-answer" : ""}`}>
              <div className="learning-correct-answer"><span>기준 답</span><strong>{result.canonical_answer}</strong></div>
              {submittedAnswerKnown && <div className="learning-user-answer"><span>응답</span><strong>{submittedAnswerLabel}</strong></div>}
            </div>
          </div>
          <div className="learning-feedback-actions">
            <button disabled={busy} onClick={() => card && void run(() => api.adjudicate(card.variant_id, false))}>오답으로 처리할게요</button>
            <button disabled={busy} onClick={() => card && void run(() => api.adjudicate(card.variant_id, true))}>정답으로 처리할게요</button>
          </div>
        </div>}

        {review && !pitchQuestion && <div className={`learning-feedback learning-answer-review ${result.failure_type ? "needs-review" : "is-correct"}`} aria-live="polite">
          <div className="learning-review-cue">
            <strong lang={card?.mode === "reading" ? deck.target_language : deck.source_language}>{reviewCue}</strong>
            {card?.audio_path && <button className="learning-review-audio" aria-label="발음 듣기" title="발음 듣기" onClick={() => playAudio()}>▶</button>}
          </div>
          <div className={`learning-review-result-stack ${submittedAnswerKnown ? "has-user-answer" : ""}`}>
            <div className={`learning-answer-comparison ${submittedAnswerKnown ? "has-user-answer" : ""}`}>
              <div className="learning-correct-answer"><span>정답</span><strong lang={card?.mode === "reading" ? deck.source_language : deck.target_language}>{reviewAnswer}</strong></div>
              {submittedAnswerKnown && <div className={`learning-user-answer ${submittedAnswerCorrect ? "is-correct" : "is-incorrect"}`}><span>응답</span><strong>{submittedAnswerLabel}</strong></div>}
            </div>
            {submittedPitch && submittedPitchQuestion && expectedPitch && <div className="learning-pitch-review">
              <div><PitchTrace
                morae={submittedPitchQuestion.morae}
                levels={expectedPitch}
                tone="correct"
                traceRef={reviewExpectedPitch}
                onScroll={(scrollLeft) => syncReviewPitchScroll(reviewSubmittedPitch.current, scrollLeft)}
              /></div>
              <div><PitchTrace
                morae={submittedPitchQuestion.morae}
                levels={submittedPitch}
                tone={pitchWasCorrect ? "correct" : "incorrect"}
                traceRef={reviewSubmittedPitch}
                onScroll={(scrollLeft) => syncReviewPitchScroll(reviewExpectedPitch.current, scrollLeft)}
              /></div>
            </div>}
          </div>
        </div>}
      </>}

      {card?.audio_path && <audio
        ref={audio}
        src={convertFileSrc(card.audio_path)}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          startListeningTimer();
        }}
        onError={() => startListeningTimer()}
        onEmptied={() => setPlaying(false)}
      />}
      {(card?.input_warning || inputWarning) && <p className="learning-warning">{card?.input_warning || inputWarning}</p>}
      {error && <p className="learning-error" role="alert">{error}</p>}
    </main>
  </section>;
}
