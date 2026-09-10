import { api } from '../../Sources/lib/api';
// Native window services are not available in the isolated browser fixture.
(window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, invoke: async () => false, transformCallback: () => 1, unregisterCallback: () => {} };
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

const ranges = Array.from({ length: 202 }, (_, i) => ({ label: i === 201 ? '0~9150' : `${i * 45}~${i * 45 + 44}`, start: i === 201 ? 0 : i * 45, end: i === 201 ? 9151 : i * 45 + 45, cumulative: i === 201 }));
api.listDecks = async () => [{ id: 'scroll-review', name: '스크롤 검증', source_language: 'ko-KR', target_language: 'ja-JP', enabled_modes: ['reading', 'listening', 'writing'], entry_count: 9151, current_stage: 1, study_ranges: ranges, completed_stage_count: 0, total_stage_count: 202 }];
api.listEntries = async () => [];
api.stageSchedules = async (_, stages) => stages.map(stage => ({ stage, study_range: ranges[stage - 1], completed: false, active: stage === 1, clear_times_ms: [], clear_cycles: [] }));
api.libraryStats = async () => ({ deck_count: 0, entry_count: 0, seen_entry_count: 0, attempts: 0, base_accuracy: null, pitch_accuracy: null, joint_accuracy: null, median_recall_latency_ms: null, study_time_ms: 0, history: [] });
api.storageSettings = async () => ({ active_path: 'review', default_path: 'review', restart_required: false });
api.audioSettings = async () => ({ volume: 0, playback_rate: 1, effect_volume: 0 });
api.startupRuntimeProgress = async () => ({ semantic: { phase: 'unavailable', model_id: '', model_version: '', dimension: 0, backend: '', gpu_requested: false }, voicevox: { phase: 'unavailable', engine_version: '', backend: '' }, language_phase: 'unavailable', language_download_progress: 100, language_load_progress: 100, input_download_progress: 100, language_sync_phase: 'done', input_sync_phase: 'done', preflight_done: true });
api.startupDependencyPreflight = async () => {};
import('../../Sources/main');
