mod db;
mod grading;
mod japanese;
mod model;
mod study;
mod timers;
mod windows_input;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use db::Database;
use grading::grade;
use japanese::JapaneseAnalyzer;
use model::{
    DeckStats, DeckSummary, EntryDraft, EntryRecord, FailureType, GradeDecision, PitchQuestion,
    StudyCard, StudyMode, SubmitResult, SubmitStatus, VariantKey,
};
use rand::random;
use study::StudySession;
use tauri::{Manager, State};
use windows_input::WindowsInputAdapter;

#[derive(Debug)]
enum Pending {
    Review,
    Ambiguous {
        variant: VariantKey,
        answer: String,
        recall_latency_ms: u64,
        typing_duration_ms: u64,
        interkey_gaps_ms: Vec<u64>,
        ime_composition_ms: u64,
        method: &'static str,
        score: Option<f64>,
    },
    Pitch {
        variant: VariantKey,
        question: PitchQuestion,
    },
}

#[derive(Default)]
struct Engine {
    session: Option<StudySession>,
    pending: Option<Pending>,
}

struct AppState {
    db: Database,
    analyzer: JapaneseAnalyzer,
    engine: Mutex<Engine>,
    input: Mutex<WindowsInputAdapter>,
    enrichment_running: Arc<AtomicBool>,
}

#[tauri::command]
fn list_decks(state: State<'_, AppState>) -> Result<Vec<DeckSummary>, String> {
    state.db.list_decks()
}

#[tauri::command]
fn create_deck(
    state: State<'_, AppState>,
    name: String,
    source_language: String,
    target_language: String,
) -> Result<DeckSummary, String> {
    if name.trim().is_empty() { return Err("deck name cannot be empty".into()); }
    state.db.create_deck(name.trim(), &source_language, &target_language)
}

#[tauri::command]
fn import_entries(state: State<'_, AppState>, deck_id: String, entries: Vec<EntryDraft>) -> Result<usize, String> {
    let deck = state.db.deck(&deck_id)?;
    let count = state.db.import_entries(&deck_id, &deck.target_language, &entries)?;
    start_enrichment_worker(
        state.db.clone(),
        state.analyzer.clone(),
        Arc::clone(&state.enrichment_running),
    );
    Ok(count)
}

#[tauri::command]
fn start_study(state: State<'_, AppState>, deck_id: String) -> Result<StudyCard, String> {
    let deck = state.db.deck(&deck_id)?;
    let entries = state.db.entries(&deck_id)?;
    if entries.is_empty() { return Err("deck has no entries".into()); }

    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    if engine.session.as_ref().is_some_and(|s| s.deck_id != deck_id) {
        return Err("another deck is already active; exit it first".into());
    }
    if engine.session.is_none() {
        let mut session = if let Some(mut persisted) = state.db.load_session(&deck_id)? {
            if let Some(current) = persisted.current.take() {
                persisted.queue.mark_fail(&current);
            }
            persisted
        } else {
            StudySession::new(
                deck_id.clone(), deck.current_round, &entries, &deck.enabled_modes,
                deck.increment_size, deck.checkpoint_size, random(),
            ).ok_or("could not create study session")?
        };
        session.current = None;
        state.db.save_session(&session)?;
        engine.session = Some(session);
        engine.pending = None;
        let mut input = state.input.lock().map_err(|_| "input adapter lock poisoned")?;
        let _ = input.remember_current();
    }
    next_card(&state, &mut engine, SubmitStatus::Pass)?.card.ok_or_else(|| "no card available".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn submit_answer(
    state: State<'_, AppState>,
    variant_id: String,
    answer: String,
    recall_latency_ms: u64,
    typing_duration_ms: u64,
    interkey_gaps_ms: Vec<u64>,
    ime_composition_ms: u64,
) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    if engine.pending.is_some() { return Err("current card is awaiting review, pitch, or adjudication".into()); }
    let session = engine.session.as_mut().ok_or("no active study session")?;
    let variant = session.current.clone().ok_or("no active card")?;
    if variant.id() != variant_id { return Err("stale study card submission".into()); }
    let deck = state.db.deck(&session.deck_id)?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let stage_label = session.stage().label();

    let answer_trimmed = answer.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
    if answer_trimmed.is_empty() {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "manual_unknown", FailureType::ManualUnknown, None);
    }
    if recall_latency_ms > deck.recall_timeout_ms {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "recall_timeout", FailureType::RecallTimeout, None);
    }

    let input_language = variant.mode.answer_language(&deck.source_language, &deck.target_language).to_string();
    let profile = state.db.typing_profile(&deck.id, &input_language, variant.mode)?;
    let max_gap = interkey_gaps_ms.iter().copied().max().unwrap_or(0);
    if profile.completion_timed_out(max_gap) {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "completion_timeout", FailureType::CompletionTimeout, None);
    }

    let (accepted, rejected) = state.db.aliases(&entry.id)?;
    let outcome = grade(variant.mode, &entry, &answer, &accepted, &rejected, deck.strict_orthography);
    match outcome.decision {
        GradeDecision::Fail => fail_base(
            &state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms,
            outcome.method, FailureType::WrongAnswer, outcome.score,
        ),
        GradeDecision::Ambiguous => {
            engine.pending = Some(Pending::Ambiguous {
                variant,
                answer,
                recall_latency_ms,
                typing_duration_ms,
                interkey_gaps_ms,
                ime_composition_ms,
                method: outcome.method,
                score: outcome.score,
            });
            Ok(SubmitResult {
                status: SubmitStatus::Ambiguous,
                message: Some("의미 판정이 애매해서 사용자 판정이 필요해.".into()),
                failure_type: None,
                canonical_answer: Some(entry.meanings.join(" / ")),
                reading: entry.reading,
                pitch: None,
                card: None,
            })
        }
        GradeDecision::Pass => {
            record_successful_typing(&state.db, &deck, &variant, &interkey_gaps_ms, typing_duration_ms, ime_composition_ms)?;
            let pitch = state.db.pitch_question(&entry.id, deck.pitch_policy == "include_predicted")?;
            state.db.insert_attempt(
                &entry.id, &deck.id, variant.mode, session.round, &stage_label, &answer, true, None,
                pitch.is_none(), outcome.method, outcome.score, recall_latency_ms, typing_duration_ms, None,
            )?;
            if let Some(question) = pitch {
                engine.pending = Some(Pending::Pitch { variant, question: question.clone() });
                Ok(SubmitResult {
                    status: SubmitStatus::Pitch, message: None, failure_type: None,
                    canonical_answer: Some(entry.meanings.join(" / ")), reading: entry.reading,
                    pitch: Some(question), card: None,
                })
            } else {
                session.queue.mark_pass(&variant);
                state.db.save_session(session)?;
                engine.pending = Some(Pending::Review);
                Ok(review_result(&entry, None, "정답"))
            }
        }
    }
}

#[tauri::command]
fn timeout_current(
    state: State<'_, AppState>,
    kind: String,
    answer: String,
    elapsed_ms: u64,
    typing_duration_ms: u64,
) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    if engine.pending.is_some() { return Err("current card already resolved".into()); }
    let session = engine.session.as_ref().ok_or("no active study session")?;
    let variant = session.current.clone().ok_or("no active card")?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let failure = match kind.as_str() {
        "recall" => FailureType::RecallTimeout,
        "completion" => FailureType::CompletionTimeout,
        _ => return Err("unknown timeout type".into()),
    };
    let method = if matches!(failure, FailureType::RecallTimeout) { "recall_timeout" } else { "completion_timeout" };
    fail_base(&state.db, &mut engine, variant, &entry, answer, elapsed_ms, typing_duration_ms, method, failure, None)
}

#[tauri::command]
fn adjudicate_answer(state: State<'_, AppState>, variant_id: String, answer: String, accept: bool) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    let pending = engine.pending.take().ok_or("no ambiguous grading is pending")?;
    let Pending::Ambiguous { variant, answer: pending_answer, recall_latency_ms, typing_duration_ms, interkey_gaps_ms, ime_composition_ms, method, score } = pending else {
        engine.pending = Some(pending);
        return Err("current state is not ambiguous grading".into());
    };
    if variant.id() != variant_id || answer != pending_answer { return Err("stale adjudication".into()); }
    let session = engine.session.as_mut().ok_or("no active study session")?;
    let deck = state.db.deck(&session.deck_id)?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    state.db.set_alias(&entry.id, &answer, accept)?;
    if !accept {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, method, FailureType::GradingRejected, score);
    }

    record_successful_typing(&state.db, &deck, &variant, &interkey_gaps_ms, typing_duration_ms, ime_composition_ms)?;
    let pitch = state.db.pitch_question(&entry.id, deck.pitch_policy == "include_predicted")?;
    state.db.insert_attempt(
        &entry.id, &deck.id, variant.mode, session.round, &session.stage().label(), &answer, true, None,
        pitch.is_none(), "manual_adjudication_accept", score, recall_latency_ms, typing_duration_ms, None,
    )?;
    if let Some(question) = pitch {
        engine.pending = Some(Pending::Pitch { variant, question: question.clone() });
        Ok(SubmitResult { status: SubmitStatus::Pitch, message: None, failure_type: None, canonical_answer: Some(entry.meanings.join(" / ")), reading: entry.reading, pitch: Some(question), card: None })
    } else {
        session.queue.mark_pass(&variant);
        state.db.save_session(session)?;
        engine.pending = Some(Pending::Review);
        Ok(review_result(&entry, None, "정답으로 기억했어"))
    }
}

#[tauri::command]
fn submit_pitch(state: State<'_, AppState>, variant_id: String, patterns: Vec<u8>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    let pending = engine.pending.take().ok_or("no pitch question is pending")?;
    let Pending::Pitch { variant, question } = pending else {
        engine.pending = Some(pending);
        return Err("current state is not pitch grading".into());
    };
    if variant.id() != variant_id { return Err("stale pitch submission".into()); }
    let session = engine.session.as_mut().ok_or("no active study session")?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let correct = question.allowed_patterns.iter().any(|p| p.as_slice() == patterns.as_slice());
    let failed_gate = question.gate_enabled && !correct;
    if failed_gate { session.queue.mark_fail(&variant); } else { session.queue.mark_pass(&variant); }
    state.db.update_attempt_pitch(
        &session.deck_id, &entry.id, variant.mode, correct, !failed_gate,
        failed_gate.then_some(FailureType::PitchWrong.as_str()),
    )?;
    state.db.save_session(session)?;
    engine.pending = Some(Pending::Review);
    Ok(review_result(
        &entry,
        failed_gate.then_some(FailureType::PitchWrong.as_str()),
        if correct { "Pitch 정답" } else if question.gate_enabled { "Pitch 오답 · 이 Variant는 다시 나와" } else { "Predicted pitch 참고값과 달라. Base PASS는 유지해" },
    ))
}

#[tauri::command]
fn continue_review(state: State<'_, AppState>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    match engine.pending.take() {
        Some(Pending::Review) => {}
        Some(other) => { engine.pending = Some(other); return Err("review is not ready to continue".into()); }
        None => return Err("no review is active".into()),
    }
    let session = engine.session.as_mut().ok_or("no active study session")?;
    if session.queue.remaining_count() == 0 {
        let deck = state.db.deck(&session.deck_id)?;
        let entries = state.db.entries(&session.deck_id)?;
        if session.advance_stage(&entries, &deck.enabled_modes, random()) {
            state.db.save_session(session)?;
            return next_card(&state, &mut engine, SubmitStatus::StageClear);
        }
        let deck_id = session.deck_id.clone();
        state.db.clear_session_and_advance_round(&deck_id)?;
        engine.session = None;
        let _ = state.input.lock().map_err(|_| "input adapter lock poisoned")?.restore();
        return Ok(SubmitResult::simple(SubmitStatus::RoundComplete));
    }
    next_card(&state, &mut engine, SubmitStatus::Pass)
}

#[tauri::command]
fn deck_stats(state: State<'_, AppState>, deck_id: String) -> Result<Vec<DeckStats>, String> {
    state.db.stats(&deck_id)
}

#[tauri::command]
fn exit_study(state: State<'_, AppState>) -> Result<(), String> {
    let mut engine = state.engine.lock().map_err(|_| "study engine lock poisoned")?;
    if let Some(session) = engine.session.as_mut() {
        if let Some(current) = session.current.take() { session.queue.mark_fail(&current); }
        state.db.save_session(session)?;
    }
    engine.session = None;
    engine.pending = None;
    state.input.lock().map_err(|_| "input adapter lock poisoned")?.restore()?;
    Ok(())
}

fn fail_base(
    db: &Database,
    engine: &mut Engine,
    variant: VariantKey,
    entry: &EntryRecord,
    answer: String,
    recall_latency_ms: u64,
    typing_duration_ms: u64,
    grading_method: &str,
    failure: FailureType,
    score: Option<f64>,
) -> Result<SubmitResult, String> {
    let session = engine.session.as_mut().ok_or("no active study session")?;
    let stage = session.stage().label();
    db.insert_attempt(
        &entry.id, &session.deck_id, variant.mode, session.round, &stage, &answer,
        false, None, false, grading_method, score, recall_latency_ms, typing_duration_ms, Some(failure.as_str()),
    )?;
    session.queue.mark_fail(&variant);
    db.save_session(session)?;
    engine.pending = Some(Pending::Review);
    Ok(review_result(entry, Some(failure.as_str()), "오답 · 정답을 확인하고 Enter"))
}

fn review_result(entry: &EntryRecord, failure: Option<&str>, message: &str) -> SubmitResult {
    SubmitResult {
        status: SubmitStatus::Review,
        message: Some(message.into()),
        failure_type: failure.map(String::from),
        canonical_answer: Some(format!("{}  ·  {}", entry.term, entry.meanings.join(" / "))),
        reading: entry.reading.clone(),
        pitch: None,
        card: None,
    }
}

fn next_card(state: &AppState, engine: &mut Engine, status: SubmitStatus) -> Result<SubmitResult, String> {
    let session = engine.session.as_mut().ok_or("no active study session")?;
    let deck = state.db.deck(&session.deck_id)?;
    let entries = state.db.entries(&session.deck_id)?;
    let variant = session.next_variant(10).ok_or("stage queue is empty")?;
    let entry = entries.iter().find(|e| e.id == variant.entry_id).ok_or("entry not found")?;
    let question = match variant.mode {
        StudyMode::Recognition => entry.term.clone(),
        StudyMode::Listening => entry.term.clone(),
        StudyMode::Production => entry.meanings.join(" / "),
    };
    let answer_language = variant.mode.answer_language(&deck.source_language, &deck.target_language).to_string();
    if let Ok(mut input) = state.input.lock() {
        if let Err(error) = input.activate_for_language(&answer_language) {
            eprintln!("TANREN input-profile warning: {error}");
        }
    }
    let profile = state.db.typing_profile(&deck.id, &answer_language, variant.mode)?;
    let card = StudyCard {
        entry_id: entry.id.clone(),
        variant_id: variant.id(),
        mode: variant.mode,
        question,
        answer_language,
        remaining: session.queue.remaining_count(),
        total: session.stage_total,
        stage_label: session.stage().label(),
        audio_path: state.db.audio_path(&entry.id)?,
        recall_timeout_ms: deck.recall_timeout_ms,
        completion_idle_ms: profile.allowed_idle_ms(),
    };
    state.db.save_session(session)?;
    engine.pending = None;
    Ok(SubmitResult { status, message: None, failure_type: None, canonical_answer: None, reading: None, pitch: None, card: Some(card) })
}

fn find_entry(db: &Database, deck_id: &str, entry_id: &str) -> Result<EntryRecord, String> {
    db.entries(deck_id)?.into_iter().find(|e| e.id == entry_id).ok_or_else(|| "entry not found".into())
}

fn record_successful_typing(db: &Database, deck: &model::DeckRecord, variant: &VariantKey, gaps: &[u64], duration_ms: u64, ime_ms: u64) -> Result<(), String> {
    let language = variant.mode.answer_language(&deck.source_language, &deck.target_language);
    let mut profile = db.typing_profile(&deck.id, language, variant.mode)?;
    profile.observe(gaps, duration_ms, ime_ms);
    db.update_typing_profile(&deck.id, language, variant.mode, &profile)
}

fn start_enrichment_worker(db: Database, analyzer: JapaneseAnalyzer, running: Arc<AtomicBool>) {
    if running.swap(true, Ordering::AcqRel) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let jobs = match db.queued_enrichment(24) {
                Ok(jobs) => jobs,
                Err(error) => { eprintln!("TANREN enrichment queue error: {error}"); break; }
            };
            if jobs.is_empty() { break; }
            for entry in jobs {
                match analyzer.analyze(&entry) {
                    Ok((analysis, audio)) => {
                        let audio_ref = audio.as_ref().map(|(k,p)|(k.as_str(),p.as_str()));
                        if let Err(error) = db.set_entry_analysis(
                            &entry.id,
                            analysis.reading.as_deref(),
                            &analysis.analysis_json(),
                            &analysis.provider,
                            &analysis.source,
                            &analysis.confidence,
                            analysis.model_version.as_deref(),
                            analysis.pitch_patterns.as_deref(),
                            &analysis.scope,
                            audio_ref,
                        ) {
                            let _ = db.fail_enrichment(&entry.id, &error);
                        }
                    }
                    Err(error) => { let _ = db.fail_enrichment(&entry.id, &error); }
                }
            }
        }
        running.store(false, Ordering::Release);
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let db = Database::open(app_data.join("tanren.db"))?;
            let analyzer = JapaneseAnalyzer::install(app.handle().clone(), &app_data)?;
            let enrichment_running = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                db: db.clone(),
                analyzer: analyzer.clone(),
                engine: Mutex::new(Engine::default()),
                input: Mutex::new(WindowsInputAdapter::default()),
                enrichment_running: Arc::clone(&enrichment_running),
            });
            start_enrichment_worker(db, analyzer, enrichment_running);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_decks,
            create_deck,
            import_entries,
            start_study,
            submit_answer,
            timeout_current,
            adjudicate_answer,
            submit_pitch,
            continue_review,
            deck_stats,
            exit_study,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TANREN");
}
