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
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::{path::{Path, PathBuf}, process::Command};

use db::Database;
use grading::grade_form;
use japanese::{JapaneseAnalyzer, VOICE_AUDIO_REVISION};
use model::{
    DeckSummary, EntryDraft, EntryListRecord, EntryRecord, FailureType, GradeDecision, LibraryStats,
    PitchQuestion, StageScheduleSummary, StudyCard, StudyMode, SubmitResult, SubmitStatus, VariantKey,
};
use rand::random;
use study::{PendingState, StudySession};
use semantic::{SemanticGrader, SemanticRuntimeStatus, SemanticThresholds};
use semantic_llama::LlamaCppEmbeddingBackend;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
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
    startup_preflight_started: Arc<AtomicBool>,
    startup_preflight_done: Arc<AtomicBool>,
    startup_language_download_progress: Arc<AtomicU8>,
    startup_language_load_progress: Arc<AtomicU8>,
    startup_input_download_progress: Arc<AtomicU8>,
    startup_language_sync_phase: Arc<AtomicU8>,
    startup_input_sync_phase: Arc<AtomicU8>,
}

const SEMANTIC_STORAGE_SETTING: &str = "semantic_storage_dir";
const AUDIO_VOLUME_SETTING: &str = "audio_volume";
const AUDIO_PLAYBACK_RATE_SETTING: &str = "audio_playback_rate";

#[derive(Serialize)]
struct StorageSettings {
    selected_path: Option<String>,
    active_path: String,
    default_path: String,
    restart_required: bool,
}

#[derive(Serialize)]
struct AudioSettings {
    volume: f64,
    playback_rate: f64,
}

#[derive(Clone, Serialize)]
struct StartupRuntimeProgress {
    semantic: SemanticRuntimeStatus,
    voicevox: VoicevoxRuntimeStatus,
    language_phase: String,
    language_download_progress: u8,
    language_load_progress: u8,
    input_download_progress: u8,
    language_sync_phase: String,
    input_sync_phase: String,
    preflight_done: bool,
}

#[derive(Serialize)]
struct ImportEntriesResult {
    inserted: usize,
    duplicates: usize,
    entry_ids: Vec<String>,
}

#[derive(Serialize)]
struct EnrichmentProgress {
    total: usize,
    completed: usize,
    failed: usize,
    pending: usize,
    last_error: Option<String>,
    runtime_phase: String,
}

#[derive(Serialize)]
struct EntryDetails {
    entry: EntryRecord,
    pitch: Option<PitchQuestion>,
    audio_path: Option<String>,
}

#[tauri::command]
fn list_decks(state: State<'_, AppState>) -> Result<Vec<DeckSummary>, String> {
    state.db.list_decks()
}

#[tauri::command]
fn list_entries(state: State<'_, AppState>, deck_id: String) -> Result<Vec<EntryListRecord>, String> {
    state.db.entry_list(&deck_id)
}

#[tauri::command]
fn entry_details(state: State<'_, AppState>, deck_id: String, entry_id: String) -> Result<EntryDetails, String> {
    let entry = find_entry(&state.db, &deck_id, &entry_id)?;
    let pitch = state.db.pitch_question(&entry_id, true)?;
    let audio_path = state.db.first_audio_path(&entry_id)?;
    Ok(EntryDetails { entry, pitch, audio_path })
}

#[tauri::command]
fn stage_schedule(state: State<'_, AppState>, deck_id: String, stage: u32) -> Result<StageScheduleSummary, String> {
    state.db.stage_schedule_summary(&deck_id, stage)
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
fn import_entries(state: State<'_, AppState>, deck_id: String, entries: Vec<EntryDraft>) -> Result<ImportEntriesResult, String> {
    let deck = state.db.deck(&deck_id)?;
    let (result, entry_ids) = state.db.import_entries_tracked(&deck_id, &deck.target_language, &entries)?;
    start_enrichment_worker(
        state.db.clone(),
        state.analyzer.clone(),
        Arc::clone(&state.enrichment_running),
    );
    let candidates = state.db.entries(&deck_id)?.into_iter().flat_map(|entry| entry.meanings).collect();
    start_semantic_precompute(Arc::clone(&state.semantic), candidates);
    Ok(ImportEntriesResult { inserted: result.inserted, duplicates: result.duplicates, entry_ids })
}

#[tauri::command]
fn enrichment_progress(state: State<'_, AppState>, entry_ids: Vec<String>) -> Result<EnrichmentProgress, String> {
    start_enrichment_worker(
        state.db.clone(),
        state.analyzer.clone(),
        Arc::clone(&state.enrichment_running),
    );
    let (total, completed, failed, last_error) = state.db.enrichment_progress(&entry_ids)?;
    Ok(EnrichmentProgress {
        total,
        completed,
        failed,
        pending: total.saturating_sub(completed + failed),
        last_error,
        runtime_phase: state.analyzer.audio_runtime_phase(),
    })
}

#[tauri::command]
fn update_entry(state: State<'_, AppState>, deck_id: String, entry_id: String, entry: EntryDraft) -> Result<bool, String> {
    let pronunciation_changed = state.db.update_entry(&deck_id, &entry_id, &entry)?;
    if pronunciation_changed {
        state.analyzer.invalidate_audio(&entry_id)?;
        start_enrichment_worker(
            state.db.clone(),
            state.analyzer.clone(),
            Arc::clone(&state.enrichment_running),
        );
    }
    start_semantic_precompute(Arc::clone(&state.semantic), entry.meanings.clone());
    Ok(pronunciation_changed)
}

#[tauri::command]
fn delete_entry(state: State<'_, AppState>, deck_id: String, entry_id: String) -> Result<(), String> {
    if state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?.session.as_ref().is_some_and(|session| session.deck_id == deck_id) {
        return Err("학습을 끝낸 뒤 삭제해주세요.".into());
    }
    state.db.delete_entry(&deck_id, &entry_id)
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
fn start_study(state: State<'_, AppState>, deck_id: String, stage: Option<u32>) -> Result<SubmitResult, String> {
    let deck = state.db.deck(&deck_id)?;
    let entries = state.db.entries(&deck_id)?;
    if entries.is_empty() { return Err("먼저 표현을 추가해주세요.".into()); }
    let selected_stage = stage.unwrap_or(deck.current_stage);
    let slots = state.db.ensure_stage_schedule(&deck_id, selected_stage, &entries)?;

    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let stale_session = if let Some(session) = engine.session.as_ref() {
        state.db.load_session(&session.deck_id, session.stage)?.is_none()
    } else {
        false
    };
    if stale_session {
        engine.session = None;
    }
    if engine.session.as_ref().is_some_and(|session| session.deck_id != deck_id || session.stage != selected_stage) {
        return Err("다른 책이나 단계를 학습 중이에요. 먼저 종료해주세요.".into());
    }
    if engine.session.is_none() {
        let mut session = if let Some(persisted) = state.db.load_session(&deck_id, selected_stage)? {
            persisted
        } else {
            StudySession::new_for_stage_with_slots(
                deck_id.clone(), selected_stage, slots, &entries, &deck.enabled_modes,
                deck.increment_size, deck.checkpoint_size, random(),
            ).ok_or("이 단계는 지금 시작할 수 없어요.")?
        };
        if let Some(variant) = match session.pending.as_ref() {
            Some(PendingState::Pitch { variant, .. }) | Some(PendingState::PitchCorrection { variant, .. }) => Some(variant.clone()),
            _ => None,
        } {
            state.db.discard_pending_pitch_attempt(&session.deck_id, session.stage, &variant.entry_id, variant.mode)?;
            session.recover_interrupted_card();
            state.db.save_session(&session)?;
        }
        session.sync_entries(&entries, &deck.enabled_modes);
        engine.session = Some(session);
        let mut input = state.input.lock().map_err(|_| "입력 설정을 불러오지 못했어요.")?;
        let _ = input.remember_current();
    }
    let result = resume_session(&state, &mut engine)?;
    state.db.select_stage(&deck_id, selected_stage)?;
    Ok(result)
}

#[tauri::command]
fn record_study_activity(state: State<'_, AppState>, deck_id: String, mode: Option<StudyMode>, duration_ms: u64) -> Result<(), String> {
    state.db.record_study_activity(&deck_id, mode, duration_ms)?;
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    if let Some(session) = engine.session.as_mut().filter(|session| session.deck_id == deck_id) {
        session.active_duration_ms = session.active_duration_ms.saturating_add(duration_ms);
        state.db.save_session(session)?;
    }
    Ok(())
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
    let range_label = session.range().label.clone();

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
                message: Some("이 답은 직접 판정이 필요해요.".into()),
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
                &entry.id, &deck.id, variant.mode, session.stage, &range_label, &answer, true, None,
                pitch.is_none(), outcome.method, outcome.score, recall_latency_ms, typing_duration_ms, None,
            )?;
            if let Some(question) = pitch {
                session.pending = Some(PendingState::Pitch { variant, question: question.clone() });
                state.db.save_session(session)?;
                Ok(SubmitResult {
                    status: SubmitStatus::Pitch, message: None, failure_type: None,
                    canonical_answer: Some(entry.term.clone()), reading: entry.reading,
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
        &entry.id, &deck.id, variant.mode, session.stage, &session.range().label, &answer, true, None,
        pitch.is_none(), "manual_adjudication_accept", score, recall_latency_ms, typing_duration_ms, None,
    )?;
    if let Some(question) = pitch {
        session.pending = Some(PendingState::Pitch { variant, question: question.clone() });
        state.db.save_session(session)?;
        Ok(SubmitResult { status: SubmitStatus::Pitch, message: None, failure_type: None, canonical_answer: Some(entry.term.clone()), reading: entry.reading, pitch: Some(question), card: None })
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
    let (variant, question, correction_failure) = match pending {
        PendingState::Pitch { variant, question } => (variant, question, None),
        PendingState::PitchCorrection { variant, question, failure } => (variant, question, Some(failure)),
        _ => return Err("current state is not pitch grading".into()),
    };
    if variant.id() != variant_id {
        return Err("stale pitch submission".into());
    }
    let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
    let (correct, failed_gate) = grade_pitch_contour(&question, &patterns);

    if let Some(failure) = correction_failure {
        session.resolve_current(&variant, false)?;
        let result = review_result(
            &entry,
            Some(&failure),
            "오답이에요. 방금 피치는 연습용이며 피치 정확도에 포함되지 않아요.",
        );
        session.pending = Some(PendingState::Review { variant, result: result.clone() });
        state.db.save_session(session)?;
        return Ok(result);
    }

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
    let reviewed_variant = match session.pending.take() {
        Some(PendingState::Review { variant, .. }) => variant,
        Some(other) => { session.pending = Some(other); return Err("review is not ready to continue".into()); }
        None => return Err("no review is active".into()),
    };
    if session.queue.remaining_count() == 0 {
        return complete_current_stage(&state, &mut engine);
    }
    if session.queue.current_cycle_complete() {
        let cycle = session.queue.complete_cycle();
        let card = build_card(&state, session, &reviewed_variant)?;
        session.pending = Some(PendingState::CycleComplete { variant: reviewed_variant });
        state.db.save_session(session)?;
        return Ok(SubmitResult {
            status: SubmitStatus::CycleComplete,
            message: Some(format!("{}바퀴 돌았어요", cycle)),
            failure_type: None,
            canonical_answer: None,
            reading: None,
            pitch: None,
            card: Some(card),
        });
    }
    next_card(&state, &mut engine, SubmitStatus::Pass)
}

#[tauri::command]
fn continue_cycle(state: State<'_, AppState>) -> Result<SubmitResult, String> {
    let mut engine = state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?;
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    match session.pending.take() {
        Some(PendingState::CycleComplete { .. }) => {}
        Some(other) => { session.pending = Some(other); return Err("cycle is not ready to continue".into()); }
        None => return Err("no completed cycle is waiting".into()),
    }
    if session.queue.remaining_count() == 0 {
        return complete_current_stage(&state, &mut engine);
    }
    next_card(&state, &mut engine, SubmitStatus::Pass)
}

#[tauri::command]
fn library_stats(state: State<'_, AppState>, deck_id: Option<String>) -> Result<LibraryStats, String> {
    state.db.library_stats(deck_id.as_deref())
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
fn japanese_runtime_phase(state: State<'_, AppState>) -> String {
    state.analyzer.runtime_phase()
}

fn startup_runtime_progress_snapshot(state: &AppState) -> StartupRuntimeProgress {
    StartupRuntimeProgress {
        semantic: state.semantic.status(),
        voicevox: state.voicevox.status(),
        language_phase: state.analyzer.runtime_phase(),
        language_download_progress: state.startup_language_download_progress.load(Ordering::Acquire),
        language_load_progress: state.startup_language_load_progress.load(Ordering::Acquire),
        input_download_progress: state.startup_input_download_progress.load(Ordering::Acquire),
        language_sync_phase: sync_phase_label(state.startup_language_sync_phase.load(Ordering::Acquire)).into(),
        input_sync_phase: sync_phase_label(state.startup_input_sync_phase.load(Ordering::Acquire)).into(),
        preflight_done: state.startup_preflight_done.load(Ordering::Acquire),
    }
}

fn sync_phase_label(value: u8) -> &'static str {
    match value {
        1 => "downloading",
        2 => "done",
        _ => "checking",
    }
}

#[tauri::command]
fn startup_runtime_progress(state: State<'_, AppState>) -> StartupRuntimeProgress {
    startup_runtime_progress_snapshot(&state)
}

#[cfg(debug_assertions)]
fn observed_hechima_progress(sources: &Path, floor: u8) -> u8 {
    let vendor = sources.join("public").join("vendor");
    let expected_paths = [
        vendor.join("hechima").join("hechima.js"),
        vendor.join("hechima").join("hechima-worker.js"),
        vendor.join("hechima").join("hechima.d.ts"),
        vendor.join("hechima-wasm").join("hechima-wasm.js"),
        vendor.join("hechima-wasm").join("hechima-wasm.wasm"),
        vendor.join("hechima-wasm").join("mozc.data"),
        vendor.join("hechima-wasm").join("BUILD_INFO.txt"),
        vendor.join("hechima-notices").join("LICENSE"),
        vendor.join("hechima-notices").join("THIRD_PARTY_NOTICES.md"),
        vendor.join("hechima-notices").join("VENDOR.md"),
    ];
    let expected = expected_paths.iter().filter_map(|path| std::fs::metadata(path).ok().map(|value| value.len())).sum::<u64>();
    if expected == 0 { return floor; }
    let temp = std::env::temp_dir();
    let Some(root) = std::fs::read_dir(temp).ok().and_then(|entries| {
        entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let name = path.file_name()?.to_str()?;
                if !path.is_dir() || !name.starts_with("tanren-hechima-") { return None; }
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, path))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path)
    }) else {
        return floor;
    };
    fn tree_size(root: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(root) else { return 0; };
        entries.flatten().map(|entry| {
            let path = entry.path();
            if path.is_dir() { tree_size(&path) } else { entry.metadata().ok().map(|value| value.len()).unwrap_or(0) }
        }).sum()
    }
    let downloaded = tree_size(&root).min(expected);
    let observed = 8 + ((downloaded.saturating_mul(82)) / expected) as u8;
    floor.max(observed.min(90))
}

#[cfg(debug_assertions)]
fn observed_sidecar_progress(sources: &Path, floor: u8) -> u8 {
    let Some(root) = sources.parent() else { return floor; };
    let cache = root.join("Results").join("python-sidecar-cache").join("unidic");
    let Ok(entries) = std::fs::read_dir(&cache) else { return floor; };
    let mut expected = 0u64;
    let mut partial = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue; };
        let size = entry.metadata().ok().map(|value| value.len()).unwrap_or(0);
        if name.ends_with(".zip") { expected = expected.max(size); }
        if name.ends_with(".zip.partial") { partial = partial.max(size); }
    }
    if expected == 0 || partial == 0 { return floor; }
    let observed = 48 + ((partial.min(expected).saturating_mul(12)) / expected) as u8;
    floor.max(observed.min(60))
}

#[cfg(debug_assertions)]
fn run_dev_dependency_sync(script_name: &str, progress: &AtomicU8, phase: &AtomicU8) -> Result<(), String> {
    let sources = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "TANREN source directory could not be resolved".to_string())?
        .to_path_buf();
    let script = sources.join("tools").join(script_name);
    let progress_file = std::env::temp_dir().join(format!(
        "tanren-{}-{}-progress",
        std::process::id(),
        script_name.replace('.', "-")
    ));
    let phase_file = std::env::temp_dir().join(format!(
        "tanren-{}-{}-phase",
        std::process::id(),
        script_name.replace('.', "-")
    ));
    let _ = std::fs::remove_file(&progress_file);
    let _ = std::fs::remove_file(&phase_file);
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .env("TANREN_PROGRESS_FILE", &progress_file)
        .env("TANREN_PHASE_FILE", &phase_file)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{script_name} could not start: {error}"))?;
    let status = loop {
        let mut observed = progress.load(Ordering::Acquire);
        if let Ok(value) = std::fs::read_to_string(&progress_file) {
            if let Ok(value) = value.trim().parse::<u8>() {
                observed = observed.max(value.min(100));
            }
        }
        if let Ok(value) = std::fs::read_to_string(&phase_file) {
            let code = match value.trim() {
                "downloading" => 1,
                "done" => 2,
                _ => 0,
            };
            phase.store(code, Ordering::Release);
        }
        observed = match script_name {
            "sync_hechima.ps1" => observed_hechima_progress(&sources, observed),
            "sync_sidecar.ps1" => observed_sidecar_progress(&sources, observed),
            _ => observed,
        };
        progress.store(observed, Ordering::Release);
        if let Some(status) = child.try_wait().map_err(|error| format!("{script_name} wait failed: {error}"))? {
            break status;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let _ = std::fs::remove_file(&progress_file);
    let _ = std::fs::remove_file(&phase_file);
    if status.success() {
        progress.store(100, Ordering::Release);
        phase.store(2, Ordering::Release);
        Ok(())
    } else {
        Err(format!("{script_name} failed with {status}"))
    }
}

#[tauri::command]
async fn startup_dependency_preflight(state: State<'_, AppState>) -> Result<(), String> {
    let analyzer = state.analyzer.clone();
    let db = state.db.clone();
    let enrichment_running = Arc::clone(&state.enrichment_running);
    let started = Arc::clone(&state.startup_preflight_started);
    let done = Arc::clone(&state.startup_preflight_done);
    let language_download_progress = Arc::clone(&state.startup_language_download_progress);
    let language_load_progress = Arc::clone(&state.startup_language_load_progress);
    let input_download_progress = Arc::clone(&state.startup_input_download_progress);
    let language_sync_phase = Arc::clone(&state.startup_language_sync_phase);
    let input_sync_phase = Arc::clone(&state.startup_input_sync_phase);

    if started.swap(true, Ordering::AcqRel) {
        tauri::async_runtime::spawn_blocking(move || {
            while !done.load(Ordering::Acquire) {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
        .await
        .map_err(|error| format!("startup preflight wait failed: {error}"))?;
        return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(debug_assertions)]
        {
            if let Err(error) = run_dev_dependency_sync("sync_sidecar.ps1", &language_download_progress, &language_sync_phase) {
                eprintln!("TANREN language dependency sync skipped: {error}");
                language_download_progress.store(100, Ordering::Release);
                language_sync_phase.store(2, Ordering::Release);
            }
            if let Err(error) = run_dev_dependency_sync("sync_hechima.ps1", &input_download_progress, &input_sync_phase) {
                eprintln!("TANREN input dependency sync skipped: {error}");
                input_download_progress.store(100, Ordering::Release);
                input_sync_phase.store(2, Ordering::Release);
            }
        }
        #[cfg(not(debug_assertions))]
        {
            language_download_progress.store(100, Ordering::Release);
            input_download_progress.store(100, Ordering::Release);
            language_sync_phase.store(2, Ordering::Release);
            input_sync_phase.store(2, Ordering::Release);
        }

        language_load_progress.store(1, Ordering::Release);
        let language_load_monitor = Arc::new(AtomicBool::new(false));
        let language_load_monitor_done = Arc::clone(&language_load_monitor);
        let language_load_monitor_progress = Arc::clone(&language_load_progress);
        let language_load_thread = std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while !language_load_monitor_done.load(Ordering::Acquire) {
                let elapsed = started.elapsed().as_millis() as u64;
                let estimated = 1 + ((elapsed.saturating_mul(94)) / 3_000).min(94) as u8;
                language_load_monitor_progress.fetch_max(estimated, Ordering::AcqRel);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });
        if let Err(error) = analyzer.warm() {
            eprintln!("TANREN language sidecar warm-up failed: {error}");
        }
        language_load_monitor.store(true, Ordering::Release);
        let _ = language_load_thread.join();
        language_load_progress.store(100, Ordering::Release);
        start_enrichment_worker(db, analyzer, enrichment_running);
        done.store(true, Ordering::Release);
    })
    .await
    .map_err(|error| format!("startup preflight failed: {error}"))?;
    Ok(())
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
fn audio_settings(state: State<'_, AppState>) -> Result<AudioSettings, String> {
    audio_settings_snapshot(&state)
}

#[tauri::command]
fn set_audio_settings(state: State<'_, AppState>, volume: f64, playback_rate: f64) -> Result<AudioSettings, String> {
    let volume = volume.clamp(0.0, 1.0);
    let playback_rate = playback_rate.clamp(0.5, 2.0);
    state.db.set_setting(AUDIO_VOLUME_SETTING, Some(&volume.to_string()))?;
    state.db.set_setting(AUDIO_PLAYBACK_RATE_SETTING, Some(&playback_rate.to_string()))?;
    audio_settings_snapshot(&state)
}

#[tauri::command]
fn export_backup(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(path) = pick_backup_file(true)? else { return Ok(None); };
    state.db.export_backup(&path)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn import_backup(state: State<'_, AppState>) -> Result<bool, String> {
    let Some(path) = pick_backup_file(false)? else { return Ok(false); };
    state.engine.lock().map_err(|_| "학습 상태를 불러오지 못했어요.")?.session = None;
    state.db.import_backup(&path)?;
    Ok(true)
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
    if language == "ja-JP" {
        // Japanese input is handled entirely by TANREN's bundled Mozc WASM IME.
        // Never require or switch the host OS Japanese input profile.
        return Ok(None);
    }
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
    let stage = session.range().label.clone();
    db.insert_attempt(
        &entry.id, &session.deck_id, variant.mode, session.stage, &stage, &answer,
        false, None, false, grading_method, score, recall_latency_ms, typing_duration_ms, Some(failure.as_str()),
    )?;
    let deck = db.deck(&session.deck_id)?;
    if let Some(question) = db.pitch_question(&entry.id, deck.pitch_policy == "include_predicted")? {
        session.pending = Some(PendingState::PitchCorrection {
            variant,
            question: question.clone(),
            failure: failure.as_str().to_string(),
        });
        db.save_session(session)?;
        return Ok(SubmitResult {
            status: SubmitStatus::Pitch,
            message: None,
            failure_type: Some(failure.as_str().to_string()),
            canonical_answer: Some(entry.term.clone()),
            reading: entry.reading.clone(),
            pitch: Some(question),
            card: None,
        });
    }
    session.resolve_current(&variant, false)?;
    let result = review_result(entry, Some(failure.as_str()), "정답을 보고 다음 문제로 넘어가세요.");
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

fn complete_current_stage(state: &AppState, engine: &mut Engine) -> Result<SubmitResult, String> {
    let (deck_id, stage, duration_ms, cycles) = {
        let session = engine.session.as_ref().ok_or("진행 중인 학습이 없어요.")?;
        (session.deck_id.clone(), session.stage, session.active_duration_ms, session.queue.completed_cycles as u32 + 1)
    };
    state.db.mark_stage_completed(&deck_id, stage, duration_ms, cycles)?;
    state.db.clear_stage_session(&deck_id, stage)?;
    engine.session = None;
    let _ = state.input.lock().map_err(|_| "입력 설정을 불러오지 못했어요.")?.restore();
    Ok(SubmitResult::simple(SubmitStatus::StageComplete))
}

fn build_card(state: &AppState, session: &StudySession, variant: &VariantKey) -> Result<StudyCard, String> {
    let deck = state.db.deck(&session.deck_id)?;
    let entries = state.db.entries(&session.deck_id)?;
    let entry = entries.iter().find(|e| e.id == variant.entry_id).ok_or("표현을 찾지 못했어요.")?;
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
        stage: session.stage,
        active_duration_ms: session.active_duration_ms,
        mode: variant.mode,
        question,
        answer_language,
        remaining: session.queue.remaining_count(),
        total: session.range_total,
        range_label: session.range().label.clone(),
        audio_path,
        recall_timeout_ms: deck.recall_timeout_by_mode.for_mode(variant.mode),
        completion_idle_ms: deck.adaptive_completion_timer_enabled.then(|| profile.allowed_idle_ms()).flatten(),
        input_warning: None,
    })
}

fn resume_session(state: &AppState, engine: &mut Engine) -> Result<SubmitResult, String> {
    let should_complete_empty_stage = engine.session.as_ref().is_some_and(|session| {
        session.pending.is_none() && session.current.is_none() && session.queue.remaining_count() == 0
    });
    if should_complete_empty_stage {
        return complete_current_stage(state, engine);
    }
    let session = engine.session.as_mut().ok_or("진행 중인 학습이 없어요.")?;
    match session.pending.clone() {
        Some(PendingState::Ambiguous { variant, .. }) => {
            let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
            let card = build_card(state, session, &variant)?;
            Ok(SubmitResult {
                status: SubmitStatus::Ambiguous,
                message: Some("이 답은 직접 판정이 필요해요.".into()),
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
                canonical_answer: Some(entry.term.clone()),
                reading: entry.reading,
                pitch: Some(question),
                card: Some(card),
            })
        }
        Some(PendingState::PitchCorrection { variant, question, failure }) => {
            let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
            let card = build_card(state, session, &variant)?;
            Ok(SubmitResult {
                status: SubmitStatus::Pitch,
                message: None,
                failure_type: Some(failure),
                canonical_answer: Some(entry.term.clone()),
                reading: entry.reading,
                pitch: Some(question),
                card: Some(card),
            })
        }
        Some(PendingState::CycleComplete { variant }) => {
            let cycle = session.queue.completed_cycles;
            let card = build_card(state, session, &variant)?;
            Ok(SubmitResult {
                status: SubmitStatus::CycleComplete,
                message: Some(format!("{}바퀴 돌았어요", cycle)),
                failure_type: None,
                canonical_answer: None,
                reading: None,
                pitch: None,
                card: Some(card),
            })
        }
        Some(PendingState::Review { variant, mut result }) => {
            let entry = find_entry(&state.db, &session.deck_id, &variant.entry_id)?;
            result.canonical_answer = Some(format!("{}  ·  {}", entry.term, entry.meanings.join(" / ")));
            result.reading = entry.reading;
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
    db.entries(deck_id)?.into_iter().find(|e| e.id == entry_id).ok_or_else(|| "표현을 찾지 못했어요.".into())
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
        let mut audio_warm_attempted = false;
        let mut drained = false;
        loop {
            match analyzer.audio_runtime_phase().as_str() {
                "ready" => {
                    if !audio_warm_attempted {
                        audio_warm_attempted = true;
                        if let Err(error) = analyzer.warm_audio() {
                            eprintln!("TANREN VOICEVOX warm-up failed: {error}");
                        }
                    }
                }
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
            if jobs.is_empty() {
                drained = true;
                break;
            }
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
        if drained {
            match db.queued_enrichment(1) {
                Ok(jobs) if !jobs.is_empty() => {
                    start_enrichment_worker(db, analyzer, running);
                }
                Ok(_) => {}
                Err(error) => eprintln!("TANREN enrichment queue handoff error: {error}"),
            }
        }
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

fn default_runtime_home() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("TANREN executable path could not be resolved: {error}"))?;
    let install_dir = executable
        .parent()
        .ok_or_else(|| "TANREN install directory could not be resolved".to_string())?;
    Ok(install_dir.join("Runtime"))
}

fn configured_semantic_home(db: &Database, default_home: &Path) -> Result<PathBuf, String> {
    if let Some(path) = db.setting(SEMANTIC_STORAGE_SETTING)?.filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(std::env::var_os("TANREN_SEMANTIC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| default_home.to_path_buf()))
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

fn audio_settings_snapshot(state: &AppState) -> Result<AudioSettings, String> {
    let volume = state.db.setting(AUDIO_VOLUME_SETTING)?
        .and_then(|value| value.parse::<f64>().ok()).unwrap_or(1.0).clamp(0.0, 1.0);
    let playback_rate = state.db.setting(AUDIO_PLAYBACK_RATE_SETTING)?
        .and_then(|value| value.parse::<f64>().ok()).unwrap_or(1.0).clamp(0.5, 2.0);
    Ok(AudioSettings { volume, playback_rate })
}

fn pick_backup_file(save: bool) -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        let dialog = if save { "SaveFileDialog" } else { "OpenFileDialog" };
        let action = if save {
            "$dialog.FileName = 'TANREN-backup.tanren'; $dialog.DefaultExt = 'tanren'; $dialog.AddExtension = $true; $dialog.OverwritePrompt = $true;"
        } else {
            "$dialog.CheckFileExists = $true;"
        };
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $dialog = New-Object System.Windows.Forms.{dialog}; $dialog.Filter = 'TANREN 백업 (*.tanren)|*.tanren|모든 파일 (*.*)|*.*'; {action} if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ $dialog.FileName }}"
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", &script])
            .output()
            .map_err(|e| format!("파일 선택기를 열 수 없어요: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let path = String::from_utf8(output.stdout).map_err(|e| format!("파일 경로를 읽을 수 없어요: {e}"))?;
        let path = path.trim();
        return Ok((!path.is_empty()).then(|| PathBuf::from(path)));
    }
    #[cfg(not(windows))]
    {
        let _ = save;
        Err("백업 파일 선택은 현재 Windows에서만 지원해요.".into())
    }
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
            db.requeue_failed_enrichment()?;
            db.requeue_incomplete_lexical_enrichment()?;
            db.requeue_voice_audio_revision(VOICE_AUDIO_REVISION)?;
            let default_semantic_home = default_runtime_home()?;
            let semantic_home = configured_semantic_home(&db, &default_semantic_home)?;
            std::fs::create_dir_all(&semantic_home).map_err(|e| e.to_string())?;
            let voicevox_home = semantic_home.join("voicevox");
            let voicevox = VoicevoxRuntime::install(voicevox_home);
            let audio_dir = semantic_home.join("audio");
            app.asset_protocol_scope().allow_directory(&audio_dir, true).map_err(|e| e.to_string())?;
            let analyzer = JapaneseAnalyzer::install(app.handle().clone(), &app_data, audio_dir, Arc::clone(&voicevox))?;
            let semantic_backend = LlamaCppEmbeddingBackend::install(semantic_home.clone());
            let semantic = Arc::new(SemanticGrader::new(semantic_backend, db.clone(), SemanticThresholds::configured()));
            let enrichment_running = Arc::new(AtomicBool::new(false));
            let startup_preflight_started = Arc::new(AtomicBool::new(false));
            let startup_preflight_done = Arc::new(AtomicBool::new(false));
            let startup_language_download_progress = Arc::new(AtomicU8::new(0));
            let startup_language_load_progress = Arc::new(AtomicU8::new(0));
            let startup_input_download_progress = Arc::new(AtomicU8::new(0));
            let startup_language_sync_phase = Arc::new(AtomicU8::new(0));
            let startup_input_sync_phase = Arc::new(AtomicU8::new(0));
            let monitor_semantic = Arc::clone(&semantic);
            let monitor_voicevox = Arc::clone(&voicevox);
            let monitor_analyzer = analyzer.clone();
            let monitor_preflight_done = Arc::clone(&startup_preflight_done);
            let monitor_language_download = Arc::clone(&startup_language_download_progress);
            let monitor_language_load = Arc::clone(&startup_language_load_progress);
            let monitor_input_download = Arc::clone(&startup_input_download_progress);
            let monitor_language_sync_phase = Arc::clone(&startup_language_sync_phase);
            let monitor_input_sync_phase = Arc::clone(&startup_input_sync_phase);
            let monitor_app = app.handle().clone();
            app.manage(AppState {
                db: db.clone(),
                analyzer: analyzer.clone(),
                semantic: Arc::clone(&semantic),
                voicevox: Arc::clone(&voicevox),
                semantic_home,
                default_semantic_home,
                engine: Mutex::new(Engine::default()),
                input: Mutex::new(WindowsInputAdapter::default()),
                enrichment_running: Arc::clone(&enrichment_running),
                startup_preflight_started,
                startup_preflight_done,
                startup_language_download_progress,
                startup_language_load_progress,
                startup_input_download_progress,
                startup_language_sync_phase,
                startup_input_sync_phase,
            });
            std::thread::spawn(move || {
                loop {
                    let semantic_status = monitor_semantic.status();
                    let voicevox_status = monitor_voicevox.status();
                    let preflight_done = monitor_preflight_done.load(Ordering::Acquire);
                    let snapshot = StartupRuntimeProgress {
                        semantic: semantic_status.clone(),
                        voicevox: voicevox_status.clone(),
                        language_phase: monitor_analyzer.runtime_phase(),
                        language_download_progress: monitor_language_download.load(Ordering::Acquire),
                        language_load_progress: monitor_language_load.load(Ordering::Acquire),
                        input_download_progress: monitor_input_download.load(Ordering::Acquire),
                        language_sync_phase: sync_phase_label(monitor_language_sync_phase.load(Ordering::Acquire)).into(),
                        input_sync_phase: sync_phase_label(monitor_input_sync_phase.load(Ordering::Acquire)).into(),
                        preflight_done,
                    };
                    let _ = monitor_app.emit("runtime-progress", snapshot);
                    let semantic_terminal = !matches!(semantic_status.phase.as_str(), "starting" | "downloading" | "loading");
                    let voicevox_terminal = !matches!(voicevox_status.phase.as_str(), "starting" | "downloading" | "loading");
                    if preflight_done && semantic_terminal && voicevox_terminal {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            if let Ok(candidates) = app.state::<AppState>().db.semantic_candidates() {
                start_semantic_precompute(semantic, candidates);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_decks,
            list_entries,
            entry_details,
            stage_schedule,
            create_deck,
            import_entries,
            enrichment_progress,
            update_entry,
            delete_entry,
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
            continue_cycle,
            library_stats,
            semantic_status,
            voicevox_status,
            japanese_runtime_phase,
            startup_runtime_progress,
            startup_dependency_preflight,
            storage_settings,
            pick_storage_directory,
            set_storage_directory,
            audio_settings,
            set_audio_settings,
            export_backup,
            import_backup,
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
