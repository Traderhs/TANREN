import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./lib/api";
import type { DeckStats, DeckSummary, StudyCard, SubmitResult } from "./lib/types";

type View = "decks" | "editor" | "study" | "stats";

function App() {
  const [view, setView] = useState<View>("decks");
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [selected, setSelected] = useState<DeckSummary | null>(null);
  const [card, setCard] = useState<StudyCard | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [stats, setStats] = useState<DeckStats[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setDecks(await api.listDecks());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => void refresh(), []);

  const openStudy = async (deck: DeckSummary) => {
    try {
      setSelected(deck);
      setCard(await api.startStudy(deck.id));
      setResult(null);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" onClick={() => setView("decks")}>
          <span className="brand-mark">鍛</span>
          <div><strong>TANREN</strong><small>鍛錬 · active recall</small></div>
        </div>
        {view !== "decks" && <button className="ghost" onClick={() => setView("decks")}>Decks</button>}
      </header>

      {error && <div className="error">{error}</div>}

      {view === "decks" && (
        <DeckList
          decks={decks}
          onRefresh={refresh}
          onEdit={(d) => { setSelected(d); setView("editor"); }}
          onStudy={openStudy}
          onStats={openStats}
        />
      )}
      {view === "editor" && selected && <DeckEditor deck={selected} onDone={refresh} />}
      {view === "study" && card && (
        <StudyView
          card={card}
          result={result}
          setCard={setCard}
          setResult={setResult}
          onExit={async () => { await api.exitStudy(); await refresh(); setView("decks"); }}
        />
      )}
      {view === "stats" && selected && <StatsView deck={selected} stats={stats} />}
    </main>
  );
}

function DeckList({ decks, onRefresh, onEdit, onStudy, onStats }: {
  decks: DeckSummary[];
  onRefresh: () => Promise<void>;
  onEdit: (d: DeckSummary) => void;
  onStudy: (d: DeckSummary) => void;
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
  return <section className="content">
    <div className="section-heading"><div><h1>Decks</h1><p>정답을 실제로 만들어내는 회독 훈련.</p></div></div>
    <form className="create-row" onSubmit={create}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="새 덱 이름" />
      <button type="submit">Create</button>
    </form>
    <div className="deck-grid">
      {decks.map((d) => <article className="deck-card" key={d.id}>
        <div><small>{d.source_language} → {d.target_language}</small><h2>{d.name}</h2></div>
        <div className="deck-meta"><span>{d.entry_count} entries</span><span>Round {d.current_round}</span></div>
        {d.active_stage && <div className="resume">Resume · {d.active_stage}</div>}
        <div className="actions">
          <button onClick={() => onStudy(d)} disabled={d.entry_count === 0}>Study</button>
          <button className="secondary" onClick={() => onEdit(d)}>Edit</button>
          <button className="ghost" onClick={() => onStats(d)}>Stats</button>
        </div>
      </article>)}
      {decks.length === 0 && <div className="empty">첫 덱을 만들어봐. CSV 없이도 바로 항목을 붙여넣을 수 있어.</div>}
    </div>
  </section>;
}

function DeckEditor({ deck, onDone }: { deck: DeckSummary; onDone: () => Promise<void> }) {
  const [text, setText] = useState("見据える\t내다보다 / 전망하다\n躊躇う\t망설이다");
  const [message, setMessage] = useState("");
  const importText = async () => {
    const entries = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [term, meaning = ""] = line.split(/\t|,/);
      return { term: term.trim(), meanings: meaning.split("/").map((v) => v.trim()).filter(Boolean) };
    }).filter((e) => e.term && e.meanings.length);
    const count = await api.importEntries(deck.id, entries);
    setMessage(`${count}개 항목 저장 · 일본어 enrichment는 백그라운드에서 진행돼.`);
    await onDone();
  };
  return <section className="content narrow">
    <div className="section-heading"><div><h1>{deck.name}</h1><p>한 줄에 <code>일본어[TAB]한국어 뜻</code></p></div></div>
    <textarea className="bulk-input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    <button onClick={importText}>Import / Add</button>
    {message && <p className="success">{message}</p>}
  </section>;
}

function StudyView({ card, result, setCard, setResult, onExit }: {
  card: StudyCard;
  result: SubmitResult | null;
  setCard: (c: StudyCard) => void;
  setResult: (r: SubmitResult | null) => void;
  onExit: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [pitch, setPitch] = useState("");
  const shownAt = useRef(performance.now());
  const firstInputAt = useRef<number | null>(null);
  const lastActivityAt = useRef<number | null>(null);
  const interkeyGaps = useRef<number[]>([]);
  const composing = useRef(false);
  const compositionStartedAt = useRef<number | null>(null);
  const imeCompositionMs = useRef(0);
  const recallTimer = useRef<number | null>(null);
  const completionTimer = useRef<number | null>(null);
  const timeoutSent = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    shownAt.current = performance.now();
    firstInputAt.current = null;
    lastActivityAt.current = null;
    interkeyGaps.current = [];
    composing.current = false;
    compositionStartedAt.current = null;
    imeCompositionMs.current = 0;
    timeoutSent.current = false;
    setAnswer("");
    setPitch("");
    requestAnimationFrame(() => inputRef.current?.focus());
    if (recallTimer.current) window.clearTimeout(recallTimer.current);
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
    if (!result || result.card) {
      recallTimer.current = window.setTimeout(async () => {
        if (firstInputAt.current == null && !timeoutSent.current) {
          timeoutSent.current = true;
          advance(await api.timeoutCurrent("recall", "", card.recall_timeout_ms, 0));
        }
      }, card.recall_timeout_ms);
    }
    return () => {
      if (recallTimer.current) window.clearTimeout(recallTimer.current);
      if (completionTimer.current) window.clearTimeout(completionTimer.current);
    };
  }, [card.variant_id, result?.status]);

  useEffect(() => {
    if (card.mode !== "listening") return;
    if (card.audio_path) {
      const audio = new Audio(convertFileSrc(card.audio_path));
      audio.play().catch(() => speakFallback(card.question));
      return () => { audio.pause(); };
    }
    speakFallback(card.question);
  }, [card.variant_id]);

  const advance = (r: SubmitResult) => {
    setResult(r);
    if (r.card) setCard(r.card);
  };

  const submit = async () => {
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
    if (firstInputAt.current == null && value.trim().length > 0) {
      firstInputAt.current = now;
      if (recallTimer.current) window.clearTimeout(recallTimer.current);
    }
    if (value.trim().length > 0 && !composing.current) {
      if (lastActivityAt.current != null) interkeyGaps.current.push(Math.round(now - lastActivityAt.current));
      lastActivityAt.current = now;
      scheduleCompletionTimeout(value);
    }
    setAnswer(value);
  };

  const scheduleCompletionTimeout = (partialAnswer: string) => {
    if (!card.completion_idle_ms || composing.current || !partialAnswer.trim()) return;
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
    completionTimer.current = window.setTimeout(async () => {
      if (composing.current || timeoutSent.current) return;
      timeoutSent.current = true;
      const now = performance.now();
      const typing = firstInputAt.current == null ? 0 : Math.round(now - firstInputAt.current);
      advance(await api.timeoutCurrent("completion", partialAnswer, Math.round(now - shownAt.current), typing));
    }, card.completion_idle_ms);
  };

  const nextFromReview = async () => advance(await api.continueReview());
  const pitchQuestion = result?.pitch;
  const review = result?.status === "review" || result?.status === "fail";
  const ambiguous = result?.status === "ambiguous";

  const keydown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (pitchQuestion) {
      const patterns = pitch.split(/[,\s]+/).filter(Boolean).map(Number);
      advance(await api.submitPitch(card.variant_id, patterns));
    } else if (review) {
      await nextFromReview();
    } else if (!ambiguous) {
      await submit();
    }
  };

  return <section className="study">
    <div className="study-top">
      <div className="mode">{card.mode.toUpperCase()} <span>{card.answer_language}</span></div>
      <div>{card.stage_label} · {card.remaining}/{card.total}</div>
      <button className="ghost" onClick={onExit}>Exit</button>
    </div>
    <div className="progress"><div style={{ width: `${100 * (1 - card.remaining / Math.max(card.total, 1))}%` }} /></div>
    <div className="study-center">
      <div className="question">{card.mode === "listening" ? "🔊 1회 재생" : card.question}</div>
      {pitchQuestion && <div className="pitch-panel">
        <small>{pitchQuestion.confidence} · {pitchQuestion.gate_enabled ? "graded" : "reference"}</small>
        <div className="morae">{pitchQuestion.morae.join(" | ") || pitchQuestion.reading}</div>
        <p>{pitchQuestion.kind === "lexical" ? "accent number" : `${pitchQuestion.phrase_count} phrase nuclei (공백 구분)`}</p>
      </div>}
      {review && <div className="review-card"><strong>{result?.canonical_answer}</strong>{result?.reading && <span>{result.reading}</span>}<p>{result?.message}</p></div>}
      {ambiguous && <div className="review-card"><p>의미 판정이 애매해. 이 답을 이 항목의 정답으로 기억할까?</p><div className="actions"><button onClick={async () => advance(await api.adjudicate(card.variant_id, answer, true))}>A · Accept</button><button className="secondary" onClick={async () => advance(await api.adjudicate(card.variant_id, answer, false))}>R · Reject</button></div></div>}
      <input
        ref={inputRef}
        className="answer-input"
        value={pitchQuestion ? pitch : answer}
        onChange={(e) => pitchQuestion ? setPitch(e.target.value) : handleInput(e.target.value)}
        onKeyDown={keydown}
        onCompositionStart={() => {
          composing.current = true;
          compositionStartedAt.current = performance.now();
          if (completionTimer.current) window.clearTimeout(completionTimer.current);
        }}
        onCompositionEnd={(e) => {
          const now = performance.now();
          composing.current = false;
          if (compositionStartedAt.current != null) imeCompositionMs.current += now - compositionStartedAt.current;
          compositionStartedAt.current = null;
          lastActivityAt.current = now;
          scheduleCompletionTimeout(e.currentTarget.value);
        }}
        placeholder={review ? "Enter → next" : pitchQuestion ? "pitch 입력" : "답 입력 · 모르면 빈 Enter"}
        disabled={ambiguous}
        autoComplete="off"
        spellCheck={false}
      />
      {result?.status === "stage_clear" && <div className="success">Stage clear · Enter로 다음 Stage</div>}
      {result?.status === "round_complete" && <div className="success">Round complete 🎉</div>}
    </div>
  </section>;
}

function speakFallback(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = 0.92;
  window.speechSynthesis.speak(utterance);
}

function StatsView({ deck, stats }: { deck: DeckSummary; stats: DeckStats[] }) {
  const pct = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  return <section className="content"><div className="section-heading"><div><h1>{deck.name} Statistics</h1><p>통계는 스케줄링에 영향을 주지 않아.</p></div></div>
    <div className="stats-grid">{stats.map((s) => <article className="stat-card" key={s.mode}><h2>{s.mode}</h2><dl><dt>Base</dt><dd>{pct(s.base_accuracy)}</dd><dt>Pitch</dt><dd>{pct(s.pitch_accuracy)}</dd><dt>Joint</dt><dd>{pct(s.joint_accuracy)}</dd><dt>Median recall</dt><dd>{s.median_recall_latency_ms == null ? "—" : `${s.median_recall_latency_ms} ms`}</dd><dt>Attempts</dt><dd>{s.attempts}</dd></dl></article>)}</div>
  </section>;
}

export default App;
