mod db;
mod grading;
mod japanese;
mod model;
mod semantic;
mod semantic_llama;
mod study;
mod timers;
mod voicevox;
mod windows_input;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{path::{Path, PathBuf}, process::Command};

use db::Database;
use grading::grade_form;
use japanese::JapaneseAnalyzer;
use model::{
    DeckStats, DeckSummary, EntryDraft, EntryRecord, FailureType, GradeDecision, ImportResult, LibraryStats,
    StudyCard, StudyMode, SubmitResult, SubmitStatus, VariantKey,
};
use rand::random;
use study::{PendingState, StudySession};
use semantic::{SemanticGrader, SemanticRuntimeStatus, SemanticThresholds};
use semantic_llama::LlamaCppEmbeddingBackend;
use serde::Serialize;
use tauri::{Manager, State};
use voicevox::{VoicevoxRuntime, VoicevoxRuntimeStatus};
use windows_input::WindowsInputAdapter;

#[derive(Default)]
struct Engine {
    session: Option<StudySession>,
}

struct AppState {
    db: Database,
    analyzer: JapaneseAnalyzer,
    semantic: Arc<SemanticGrader>,
    voicevox: Arc<VoicevoxRuntime>,
    semantic_home: PathBuf,
    default_semantic_home: PathBuf,
    engine: Mutex<Engine>,
    input: Mutex<WindowsInputAdapter>,
    enrichment_running: Arc<AtomicBool>,
}

const SEMANTIC_STORAGE_SETTING: &str = "semantic_storage_dir";

#[derive(Serialize)]
struct StorageSettings {
    selected_path: Option<String>,
    active_path: String,
    default_path: String,
    restart_required: bool,
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
    if name.trim().is_empty() { return Err("책 이름을 입력해주세요.".into()); }
    state.db.create_deck(name.trim(), &source_language, &target_language)
}

#[tauri::command]
fn import_entries(state: State<'_, AppState>, deck_id: String, entries: Vec<EntryDraft>) -> Result<ImportResult, String> {
    let deck = state.db.deck(&deck_id)?;
    let result = state.db.import_entries(&deck_id, &deck.target_language, &entries)?;
    start_enrichment_worker(
        state.db.clone(),
        state.analyzer.clone(),
        Arc::clone(&state.enrichment_running),
    );
    let candidates = state.db.entries(&deck_id)?.into_iter().flat_map(|entry| entry.meanings).collect();
    start_semantic_precompute(Arc::clone(&state.semantic), candidates);
    Ok(result)
}

fn deck_summary(db: &Database, deck_id: &str) -> Result<DeckSummary, String> {
    db.list_decks()?.into_iter().find(|deck| deck.id == deck_id).ok_or_else(|| "책을 찾지 못했어요.".into())
}

#[tauri::command]
fn update_deck(state: State<'_, AppState>, deck_id: String, name: String, enabled_modes: Vec<StudyMode>) -> Result<DeckSummary, String> {
    state.db.update_deck(&deck_id, &name, &enabled_modes)?;
    deck_summary(&state.db, &deck_id)
}

#[tauri::command]
fn delete_deck(state: State<'_, AppState>, deck_id: String) -> Result<(), String> {
    if state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?.session.as_ref().is_some_and(|session| session.deck_id == deck_id) {
        return Err("학습을 끝낸 뒤 삭제해주세요.".into());
    }
    state.db.delete_deck(&deck_id)
}

#[tauri::command]
fn export_deck(state: State<'_, AppState>, deck_id: String) -> Result<String, String> {
    state.db.export_deck(&deck_id)
}

#[tauri::command]
fn import_deck_export(state: State<'_, AppState>, payload: String) -> Result<DeckSummary, String> {
    let deck_id = state.db.import_deck_export(&payload)?;
    start_enrichment_worker(state.db.clone(), state.analyzer.clone(), Arc::clone(&state.enrichment_running));
    deck_summary(&state.db, &deck_id)
}

#[tauri::command]
fn start_study(state: State<'_, AppState>, deck_id: String, stage_index: Option<usize>) -> Result<SubmitResult, String> {
    let deck = state.db.deck(&deck_id)?;
    let entries = state.db.entries(&deck_id)?;
    if entries.is_empty() { return Err("먼저 단어를 추가해주세요.".into()); }

    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    if engine.session.as_ref().is_some_and(|s| s.deck_id != deck_id) {
        return Err("다른 책을 학습 중이에요. 먼저 종료해주세요.".into());
    }
    if let Some(stage_index) = stage_index {
        engine.session = Some(StudySession::new_at_stage(
            deck_id.clone(), deck.current_round, &entries, &deck.enabled_modes,
            deck.increment_size, deck.checkpoint_size, stage_index, random(),
        ).ok_or("이 학습 구간은 지금 시작할 수 없어요.")?);
    } else if engine.session.is_none() {
        let session = if let Some(persisted) = state.db.load_session(&deck_id)? {
            persisted
        } else {
            StudySession::new(
                deck_id.clone(), deck.current_round, &entries, &deck.enabled_modes,
                deck.increment_size, deck.checkpoint_size, random(),
            ).ok_or("학습을 시작하지 못했어요.")?
        };
        engine.session = Some(session);
        let mut input = state.input.lock().map_err(|_| "입력 설정을 불러오지 못했어요.")?;
        let _ = input.remember_current();
    }
    resume_session(&state, &mut engine)
}

#[tauri::command]
fn record_study_activity(state: State<'_, AppState>, deck_id: String, mode: Option<StudyMode>, duration_ms: u64) -> Result<(), String> {
    state.db.record_study_activity(&deck_id, mode, duration_ms)
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
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    if session.pending.is_some() { return Err("current card is awaiting review, pitch, or adjudication".into()); }
    let variant = session.current.clone().ok_or("no active card")?;
    if variant.id() != variant_id { return Err("stale study card submission".into()); }
    let deck = state.db.deck(&session.deck_id)?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let stage_label = session.stage().label();

    let answer_trimmed = answer.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
    if answer_trimmed.is_empty() {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "manual_unknown", FailureType::ManualUnknown, None);
    }
    if recall_latency_ms > deck.recall_timeout_by_mode.for_mode(variant.mode) {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "recall_timeout", FailureType::RecallTimeout, None);
    }

    let input_language = variant.mode.answer_language(&deck.source_language, &deck.target_language).to_string();
    let profile = state.db.typing_profile(&deck.id, &input_language, variant.mode)?;
    let max_gap = interkey_gaps_ms.iter().copied().max().unwrap_or(0);
    if profile.completion_timed_out(max_gap) {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, "completion_timeout", FailureType::CompletionTimeout, None);
    }

    let (accepted, rejected) = state.db.aliases(&entry.id)?;
    let outcome = match variant.mode {
        StudyMode::Reading => state.semantic.grade_reading(&entry, &answer, &accepted, &rejected),
        StudyMode::Listening | StudyMode::Writing => grade_form(&entry, &answer, deck.strict_orthography),
    };
    match outcome.decision {
        GradeDecision::Fail => fail_base(
            &state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms,
            outcome.method, FailureType::WrongAnswer, outcome.score,
        ),
        GradeDecision::Ambiguous => {
            session.pending = Some(PendingState::Ambiguous {
                variant,
                answer,
                recall_latency_ms,
                typing_duration_ms,
                interkey_gaps_ms,
                ime_composition_ms,
                method: outcome.method.into(),
                score: outcome.score,
            });
            state.db.save_session(session)?;
            Ok(SubmitResult {
                status: SubmitStatus::Ambiguous,
                message: Some("이 답은 직접 확인이 필요해요.".into()),
                failure_type: None,
                canonical_answer: Some(entry.meanings.join(" / ")),
                reading: entry.reading,
                pitch: None,
                card: None,
            })
        }
        GradeDecision::Pass => {
            record_successful_typing(&state.db, &deck, &variant, &answer, &interkey_gaps_ms, typing_duration_ms, ime_composition_ms)?;
            let pitch = state.db.pitch_question(&entry.id, deck.pitch_policy == "include_predicted")?;
            state.db.insert_attempt(
                &entry.id, &deck.id, variant.mode, session.round, &stage_label, &answer, true, None,
                pitch.is_none(), outcome.method, outcome.score, recall_latency_ms, typing_duration_ms, None,
            )?;
            if let Some(question) = pitch {
                session.pending = Some(PendingState::Pitch { variant, question: question.clone() });
                state.db.save_session(session)?;
                Ok(SubmitResult {
                    status: SubmitStatus::Pitch, message: None, failure_type: None,
                    canonical_answer: Some(entry.meanings.join(" / ")), reading: entry.reading,
                    pitch: Some(question), card: None,
                })
            } else {
                session.resolve_current(&variant, true)?;
                let result = review_result(&entry, None, "맞았어요.");
                session.pending = Some(PendingState::Review { variant, result: result.clone() });
                state.db.save_session(session)?;
                Ok(result)
            }
        }
    }
}

#[tauri::command]
fn timeout_current(
    state: State<'_, AppState>,
    variant_id: String,
    kind: String,
    answer: String,
    elapsed_ms: u64,
    typing_duration_ms: u64,
) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_ref().ok_or("진행 중인 학습이 없어요.")?;
    if session.pending.is_some() { return Err("current card already resolved".into()); }
    let variant = session.current.clone().ok_or("no active card")?;
    validate_timeout_variant(&variant, &variant_id)?;
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
fn adjudicate_answer(state: State<'_, AppState>, variant_id: String, accept: bool) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    let pending = ambiguous_for_adjudication(&session.pending, &variant_id)?;
    let PendingState::Ambiguous { variant, answer: pending_answer, recall_latency_ms, typing_duration_ms, interkey_gaps_ms, ime_composition_ms, method, score } = pending else {
        unreachable!();
    };
    let answer = pending_answer;
    let deck = state.db.deck(&session.deck_id)?;
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    state.db.set_alias(&entry.id, &answer, accept)?;
    start_semantic_precompute(Arc::clone(&state.semantic), vec![answer.clone()]);
    if !accept {
        return fail_base(&state.db, &mut engine, variant, &entry, answer, recall_latency_ms, typing_duration_ms, &method, FailureType::GradingRejected, score);
    }

    record_successful_typing(&state.db, &deck, &variant, &answer, &interkey_gaps_ms, typing_duration_ms, ime_composition_ms)?;
    let pitch = state.db.pitch_question(&entry.id, deck.pitch_policy == "include_predicted")?;
    state.db.insert_attempt(
        &entry.id, &deck.id, variant.mode, session.round, &session.stage().label(), &answer, true, None,
        pitch.is_none(), "manual_adjudication_accept", score, recall_latency_ms, typing_duration_ms, None,
    )?;
    if let Some(question) = pitch {
        session.pending = Some(PendingState::Pitch { variant, question: question.clone() });
        state.db.save_session(session)?;
        Ok(SubmitResult { status: SubmitStatus::Pitch, message: None, failure_type: None, canonical_answer: Some(entry.meanings.join(" / ")), reading: entry.reading, pitch: Some(question), card: None })
    } else {
        session.resolve_current(&variant, true)?;
        let result = review_result(&entry, None, "정답으로 기억했어요.");
        session.pending = Some(PendingState::Review { variant, result: result.clone() });
        state.db.save_session(session)?;
        Ok(result)
    }
}

fn ambiguous_for_adjudication(pending: &Option<PendingState>, variant_id: &str) -> Result<PendingState, String> {
    let value = pending.clone().ok_or("no ambiguous grading is pending")?;
    match &value {
        PendingState::Ambiguous { variant, .. } if variant.id() == variant_id => Ok(value),
        PendingState::Ambiguous { .. } => Err("stale adjudication".into()),
        _ => Err("current state is not ambiguous grading".into()),
    }
}

#[tauri::command]
fn submit_pitch(state: State<'_, AppState>, variant_id: String, patterns: Vec<u8>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    let pending = session.pending.clone().ok_or("no pitch question is pending")?;
    let PendingState::Pitch { variant, question } = pending else {
        return Err("current state is not pitch grading".into());
    };
    if variant.id() != variant_id {
        return Err("stale pitch submission".into());
    }
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let (correct, failed_gate) = grade_pitch_contour(&question, &patterns);
    session.resolve_current(&variant, !failed_gate)?;
    state.db.update_attempt_pitch(
        &session.deck_id, &entry.id, variant.mode, correct, !failed_gate,
        failed_gate.then_some(FailureType::PitchWrong.as_str()),
    )?;
    let result = review_result(
        &entry,
        failed_gate.then_some(FailureType::PitchWrong.as_str()),
        if correct { "피치도 맞았어요." } else if question.gate_enabled { "피치가 달라요. 이 문제는 다시 나와요." } else { "참고 피치와 달라요. 정답 처리는 그대로예요." },
    );
    session.pending = Some(PendingState::Review { variant, result: result.clone() });
    state.db.save_session(session)?;
    Ok(result)
}

fn grade_pitch_contour(question: &model::PitchQuestion, contour: &[u8]) -> (bool, bool) {
    let correct = question.allowed_patterns.iter().any(|allowed| allowed.as_slice() == contour);
    (correct, question.gate_enabled && !correct)
}

#[tauri::command]
fn continue_review(state: State<'_, AppState>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    match session.pending.take() {
        Some(PendingState::Review { .. }) => {}
        Some(other) => { session.pending = Some(other); return Err("review is not ready to continue".into()); }
        None => return Err("no review is active".into()),
    }
    if session.queue.remaining_count() == 0 {
        let deck = state.db.deck(&session.deck_id)?;
        let entries = state.db.entries(&session.deck_id)?;
        let completed_stage_label = session.stage().label();
        state.db.mark_stage_completed(&session.deck_id, &completed_stage_label, session.round)?;
        if session.advance_stage(&entries, &deck.enabled_modes, random()) {
            session.pending = Some(PendingState::StageTransition);
            state.db.save_session(session)?;
            return Ok(SubmitResult::simple(SubmitStatus::StageClear));
        }
        let deck_id = session.deck_id.clone();
        state.db.clear_session_and_advance_round(&deck_id)?;
        engine.session = None;
        let _ = state.input.lock().map_err(|_| "입력 설정을 불러오지 못했어요.")?.restore();
        return Ok(SubmitResult::simple(SubmitStatus::RoundComplete));
    }
    next_card(&state, &mut engine, SubmitStatus::Pass)
}

#[tauri::command]
fn continue_stage(state: State<'_, AppState>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    match session.pending.take() {
        Some(PendingState::StageTransition) => next_card(&state, &mut engine, SubmitStatus::Pass),
        Some(other) => { session.pending = Some(other); Err("아직 다음 구간으로 넘어갈 수 없어요.".into()) }
        None => Err("이어갈 구간이 없어요.".into()),
    }
}

#[tauri::command]
fn deck_stats(state: State<'_, AppState>, deck_id: String) -> Result<Vec<DeckStats>, String> {
    state.db.stats(&deck_id)
}

#[tauri::command]
fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    state.db.library_stats()
}

#[tauri::command]
fn semantic_status(state: State<'_, AppState>) -> SemanticRuntimeStatus {
    state.semantic.status()
}

#[tauri::command]
fn voicevox_status(state: State<'_, AppState>) -> VoicevoxRuntimeStatus {
    state.voicevox.status()
}

#[tauri::command]
fn storage_settings(state: State<'_, AppState>) -> Result<StorageSettings, String> {
    storage_settings_snapshot(&state)
}

#[tauri::command]
fn pick_storage_directory() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let script = r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $shell = New-Object -ComObject Shell.Application; $folder = $shell.BrowseForFolder(0, 'TANREN semantic data folder', 0, 0); if ($folder) { $folder.Self.Path }"#;
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .map_err(|e| format!("folder picker could not start: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let path = String::from_utf8(output.stdout).map_err(|e| format!("folder picker returned invalid UTF-8: {e}"))?;
        let path = path.trim();
        return Ok((!path.is_empty()).then(|| path.to_string()));
    }
    #[cfg(not(windows))]
    {
        Err("folder picker is currently supported on Windows only".into())
    }
}

#[tauri::command]
fn set_storage_directory(state: State<'_, AppState>, path: Option<String>) -> Result<StorageSettings, String> {
    let selected = path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if let Some(value) = selected {
        let candidate = Path::new(value);
        if !candidate.is_absolute() { return Err("storage folder must be an absolute path".into()); }
        std::fs::create_dir_all(candidate).map_err(|e| format!("storage folder is not writable: {e}"))?;
    }
    state.db.set_setting(SEMANTIC_STORAGE_SETTING, selected)?;
    storage_settings_snapshot(&state)
}

#[tauri::command]
fn exit_study(state: State<'_, AppState>) -> Result<(), String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    if let Some(session) = engine.session.as_mut() {
        session.recover_interrupted_card();
        state.db.save_session(session)?;
    }
    engine.session = None;
    state.input.lock().map_err(|_| "입력 설정을 불러오지 못했어요.")?.restore()?;
    Ok(())
}

#[tauri::command]
fn activate_input_profile(window: tauri::WebviewWindow, state: State<'_, AppState>, language: String) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| format!("could not resolve TANREN window: {e}"))?;
        return state.input.lock().map_err(|_| "input adapter lock poisoned")?.activate_for_language(&language, hwnd);
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        state.input.lock().map_err(|_| "input adapter lock poisoned")?.activate_for_language(&language, ())
    }
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
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    let stage = session.stage().label();
    db.insert_attempt(
        &entry.id, &session.deck_id, variant.mode, session.round, &stage, &answer,
        false, None, false, grading_method, score, recall_latency_ms, typing_duration_ms, Some(failure.as_str()),
    )?;
    session.resolve_current(&variant, false)?;
    let result = review_result(entry, Some(failure.as_str()), "정답을 확인하고 Enter를 눌러주세요.");
    session.pending = Some(PendingState::Review { variant, result: result.clone() });
    db.save_session(session)?;
    Ok(result)
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
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    if session.current.is_some() { return Err("an unresolved active card already exists".into()); }
    let variant = session.next_variant(10).ok_or("stage queue is empty")?;
    session.pending = None;
    let card = build_card(state, session, &variant)?;
    state.db.save_session(session)?;
    Ok(SubmitResult { status, message: None, failure_type: None, canonical_answer: None, reading: None, pitch: None, card: Some(card) })
}

fn build_card(state: &AppState, session: &StudySession, variant: &VariantKey) -> Result<StudyCard, String> {
    let deck = state.db.deck(&session.deck_id)?;
    let entries = state.db.entries(&session.deck_id)?;
    let entry = entries.iter().find(|e| e.id == variant.entry_id).ok_or("단어를 찾지 못했어요.")?;
    let question = match variant.mode {
        StudyMode::Reading => entry.term.clone(),
        StudyMode::Listening => entry.term.clone(),
        StudyMode::Writing => entry.meanings.join(" / "),
    };
    let answer_language = variant.mode.answer_language(&deck.source_language, &deck.target_language).to_string();
    let profile = state.db.typing_profile(&deck.id, &answer_language, variant.mode)?;
    let audio_path = state.db.next_audio_path(&entry.id)?;
    if matches!(variant.mode, StudyMode::Listening) && audio_path.is_none() {
        return Err("아직 음성이 준비되지 않았어요. 잠시 후 다시 시도해주세요.".into());
    }
    Ok(StudyCard {
        entry_id: entry.id.clone(),
        variant_id: variant.id(),
        mode: variant.mode,
        question,
        answer_language,
        remaining: session.queue.remaining_count(),
        total: session.stage_total,
        stage_label: session.stage().label(),
        audio_path,
        recall_timeout_ms: deck.recall_timeout_by_mode.for_mode(variant.mode),
        completion_idle_ms: deck.adaptive_completion_timer_enabled.then(|| profile.allowed_idle_ms()).flatten(),
        input_warning: None,
    })
}

fn resume_session(state: &AppState, engine: &mut Engine) -> Result<SubmitResult, String> {
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    match session.pending.clone() {
        Some(PendingState::StageTransition) => Ok(SubmitResult::simple(SubmitStatus::StageClear)),
        Some(PendingState::Ambiguous { variant, .. }) => {
            let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
            let card = build_card(state, session, &variant)?;
            Ok(SubmitResult {
                status: SubmitStatus::Ambiguous,
                message: Some("이 답은 직접 확인이 필요해요.".into()),
                failure_type: None,
                canonical_answer: Some(entry.meanings.join(" / ")),
                reading: entry.reading,
                pitch: None,
                card: Some(card),
            })
        }
        Some(PendingState::Pitch { variant, question }) => {
            let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
            let card = build_card(state, session, &variant)?;
            Ok(SubmitResult {
                status: SubmitStatus::Pitch,
                message: None,
                failure_type: None,
                canonical_answer: Some(entry.meanings.join(" / ")),
                reading: entry.reading,
                pitch: Some(question),
                card: Some(card),
            })
        }
        Some(PendingState::Review { variant, mut result }) => {
            result.card = Some(build_card(state, session, &variant)?);
            Ok(result)
        }
        None => {
            if let Some(variant) = session.current.clone() {
                let card = build_card(state, session, &variant)?;
                Ok(SubmitResult { status: SubmitStatus::Pass, message: None, failure_type: None, canonical_answer: None, reading: None, pitch: None, card: Some(card) })
            } else {
                next_card(state, engine, SubmitStatus::Pass)
            }
        }
    }
}

fn find_entry(db: &Database, deck_id: &str, entry_id: &str) -> Result<EntryRecord, String> {
    db.entries(deck_id)?.into_iter().find(|e| e.id == entry_id).ok_or_else(|| "단어를 찾지 못했어요.".into())
}

fn record_successful_typing(db: &Database, deck: &model::DeckRecord, variant: &VariantKey, answer: &str, gaps: &[u64], duration_ms: u64, ime_ms: u64) -> Result<(), String> {
    let language = variant.mode.answer_language(&deck.source_language, &deck.target_language);
    let mut profile = db.typing_profile(&deck.id, language, variant.mode)?;
    profile.observe(gaps, duration_ms, ime_ms, answer.chars().filter(|c| !c.is_whitespace()).count());
    db.update_typing_profile(&deck.id, language, variant.mode, &profile)
}

fn validate_timeout_variant(current: &VariantKey, variant_id: &str) -> Result<(), String> {
    if current.id() == variant_id { Ok(()) } else { Err("stale study card timeout".into()) }
}

fn start_enrichment_worker(db: Database, analyzer: JapaneseAnalyzer, running: Arc<AtomicBool>) {
    if running.swap(true, Ordering::AcqRel) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            match analyzer.audio_runtime_phase().as_str() {
                "ready" => {}
                "unavailable" => break,
                _ => {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    continue;
                }
            }
            let jobs = match db.queued_enrichment(24) {
                Ok(jobs) => jobs,
                Err(error) => { eprintln!("TANREN enrichment queue error: {error}"); break; }
            };
            if jobs.is_empty() { break; }
            for entry in jobs {
                match analyzer.analyze(&entry) {
                    Ok((analysis, audio)) => {
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
                            &audio,
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

fn start_semantic_precompute(semantic: Arc<SemanticGrader>, candidates: Vec<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..600 {
            if semantic.status().phase == "ready" {
                let _ = semantic.precompute_documents(&candidates);
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

fn configured_semantic_home(db: &Database, app_data: &Path) -> Result<PathBuf, String> {
    if let Some(path) = db.setting(SEMANTIC_STORAGE_SETTING)?.filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(std::env::var_os("TANREN_SEMANTIC_HOME").map(PathBuf::from).unwrap_or_else(|| app_data.join("semantic")))
}

fn storage_settings_snapshot(state: &AppState) -> Result<StorageSettings, String> {
    let selected = state.db.setting(SEMANTIC_STORAGE_SETTING)?.filter(|value| !value.trim().is_empty());
    let requested = selected.as_ref().map(PathBuf::from)
        .or_else(|| std::env::var_os("TANREN_SEMANTIC_HOME").map(PathBuf::from))
        .unwrap_or_else(|| state.default_semantic_home.clone());
    Ok(StorageSettings {
        selected_path: selected,
        active_path: state.semantic_home.to_string_lossy().to_string(),
        default_path: state.default_semantic_home.to_string_lossy().to_string(),
        restart_required: requested != state.semantic_home,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut input) = state.input.lock() {
                        let _ = input.restore();
                    }
                }
            }
        })
        .setup(|app| {
            let app_data = std::env::var_os("TANREN_APP_DATA_HOME").map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir().map_err(|e| e.to_string())?);
            let db = Database::open(app_data.join("tanren.db"))?;
            let default_semantic_home = app_data.join("semantic");
            let semantic_home = configured_semantic_home(&db, &app_data)?;
            let voicevox = VoicevoxRuntime::install(semantic_home.join("voicevox"));
            let analyzer = JapaneseAnalyzer::install(app.handle().clone(), &app_data, app_data.join("audio"), Arc::clone(&voicevox))?;
            let semantic_backend = LlamaCppEmbeddingBackend::install(semantic_home.clone());
            let semantic = Arc::new(SemanticGrader::new(semantic_backend, db.clone(), SemanticThresholds::configured()));
            let enrichment_running = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                db: db.clone(),
                analyzer: analyzer.clone(),
                semantic: Arc::clone(&semantic),
                voicevox,
                semantic_home,
                default_semantic_home,
                engine: Mutex::new(Engine::default()),
                input: Mutex::new(WindowsInputAdapter::default()),
                enrichment_running: Arc::clone(&enrichment_running),
            });
            start_enrichment_worker(db, analyzer, enrichment_running);
            if let Ok(candidates) = app.state::<AppState>().db.semantic_candidates() {
                start_semantic_precompute(semantic, candidates);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_decks,
            create_deck,
            import_entries,
            update_deck,
            delete_deck,
            export_deck,
            import_deck_export,
            start_study,
            record_study_activity,
            submit_answer,
            timeout_current,
            adjudicate_answer,
            submit_pitch,
            continue_review,
            continue_stage,
            deck_stats,
            library_stats,
            semantic_status,
            voicevox_status,
            storage_settings,
            pick_storage_directory,
            set_storage_directory,
            activate_input_profile,
            exit_study,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TANREN");
}

#[cfg(test)]
mod state_tests {
    use super::*;

    fn ambiguous(answer: &str) -> PendingState {
        PendingState::Ambiguous {
            variant: VariantKey { entry_id: "entry".into(), mode: StudyMode::Reading },
            answer: answer.into(),
            recall_latency_ms: 100,
            typing_duration_ms: 200,
            interkey_gaps_ms: vec![50],
            ime_composition_ms: 0,
            method: "semantic".into(),
            score: Some(0.5),
        }
    }

    #[test]
    fn ambiguous_accept_and_reject_use_backend_pending_answer() {
        for accept in [true, false] {
            let pending = Some(ambiguous("실제 제출 답"));
            let taken = ambiguous_for_adjudication(&pending, "entry:reading").unwrap();
            let PendingState::Ambiguous { answer, .. } = taken else { unreachable!() };
            assert_eq!(answer, "실제 제출 답", "accept={accept}");
            assert!(matches!(pending, Some(PendingState::Ambiguous { .. })));
        }
    }

    #[test]
    fn stale_adjudication_does_not_discard_pending_answer() {
        let pending = Some(ambiguous("보존할 답"));
        assert_eq!(ambiguous_for_adjudication(&pending, "other:reading").unwrap_err(), "stale adjudication");
        assert!(matches!(pending, Some(PendingState::Ambiguous { ref answer, .. }) if answer == "보존할 답"));
    }

    #[test]
    fn stale_timeout_cannot_resolve_the_next_variant() {
        let current = VariantKey { entry_id: "next".into(), mode: StudyMode::Listening };
        assert_eq!(validate_timeout_variant(&current, "previous:listening").unwrap_err(), "stale study card timeout");
        assert!(validate_timeout_variant(&current, "next:listening").is_ok());
    }

    #[test]
    fn pitch_grading_is_exact_and_accepts_any_allowed_contour() {
        let question = model::PitchQuestion {
            kind: "lexical".into(),
            reading: "みすえる".into(),
            morae: vec!["み".into(), "す".into(), "え".into(), "る".into()],
            phrase_count: 1,
            allowed_patterns: vec![vec![0, 1, 1, 0], vec![0, 1, 1, 1]],
            confidence: model::PitchConfidence::Verified,
            gate_enabled: true,
        };
        assert_eq!(grade_pitch_contour(&question, &[0, 1, 1, 0]), (true, false));
        assert_eq!(grade_pitch_contour(&question, &[0, 1, 1, 1]), (true, false));
        assert_eq!(grade_pitch_contour(&question, &[0, 1, 0, 0]), (false, true));
        assert_eq!(grade_pitch_contour(&question, &[0, 1, 1]), (false, true));
    }

    #[test]
    fn predicted_reference_only_pitch_cannot_fail_the_base_answer() {
        let question = model::PitchQuestion {
            kind: "lexical".into(),
            reading: "よそく".into(),
            morae: vec!["よ".into(), "そ".into(), "く".into()],
            phrase_count: 1,
            allowed_patterns: vec![vec![0, 1, 0]],
            confidence: model::PitchConfidence::Predicted,
            gate_enabled: false,
        };
        assert_eq!(grade_pitch_contour(&question, &[1, 0, 0]), (false, false));
    }
}
