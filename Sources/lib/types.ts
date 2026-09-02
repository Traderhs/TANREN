export type StudyMode = "reading" | "listening" | "writing";

export interface DeckSummary {
  id: string;
  name: string;
  source_language: string;
  target_language: string;
  enabled_modes: StudyMode[];
  entry_count: number;
  current_stage: number;
  active_range?: string | null;
  study_ranges: StudyRange[];
  completed_stage_count: number;
  total_stage_count: number;
}

export interface StudyRange {
  /** Internal zero-based inclusive label, e.g. 0~49. Format before showing it to users. */
  label: string;
  /** Zero-based inclusive slice start. */
  start: number;
  /** Zero-based exclusive slice end. */
  end: number;
  cumulative: boolean;
}

export interface StageScheduleSummary {
  stage: number;
  study_range: StudyRange;
  completed: boolean;
  active: boolean;
}

export interface ImportResult {
  inserted: number;
  duplicates: number;
}

export interface StudyCard {
  entry_id: string;
  variant_id: string;
  stage: number;
  mode: StudyMode;
  question: string;
  answer_language: string;
  remaining: number;
  total: number;
  range_label: string;
  audio_path?: string | null;
  recall_timeout_ms: number;
  completion_idle_ms?: number | null;
  input_warning?: string | null;
}

export interface PitchQuestion {
  kind: "lexical" | "phrase";
  reading: string;
  morae: string[];
  phrase_count: number;
  allowed_patterns: number[][];
  confidence: "MANUAL" | "VERIFIED" | "CONSENSUS" | "PREDICTED";
  gate_enabled: boolean;
}

export interface SubmitResult {
  status: "pass" | "fail" | "ambiguous" | "pitch" | "review" | "stage_complete";
  message?: string;
  failure_type?: string | null;
  canonical_answer?: string | null;
  reading?: string | null;
  pitch?: PitchQuestion | null;
  card?: StudyCard | null;
}

export interface DeckStats {
  mode: StudyMode;
  base_accuracy: number | null;
  pitch_accuracy: number | null;
  joint_accuracy: number | null;
  median_recall_latency_ms: number | null;
  attempts: number;
}

export interface LibraryDeckStats {
  deck_id: string;
  deck_name: string;
  entry_count: number;
  current_stage: number;
  attempts: number;
  base_accuracy: number | null;
  joint_accuracy: number | null;
  median_recall_latency_ms: number | null;
  last_practiced_at: string | null;
}

export interface LibraryStats {
  deck_count: number;
  active_deck_count: number;
  entry_count: number;
  seen_entry_count: number;
  attempts: number;
  base_accuracy: number | null;
  pitch_accuracy: number | null;
  joint_accuracy: number | null;
  median_recall_latency_ms: number | null;
  study_time_ms: number;
  mode_stats: DeckStats[];
  deck_stats: LibraryDeckStats[];
  history: LibraryStatsPoint[];
}

export interface LibraryStatsPoint {
  date: string;
  attempts: number;
  seen_entry_count: number;
  base_accuracy: number | null;
  pitch_accuracy: number | null;
  median_recall_latency_ms: number | null;
  study_time_ms: number;
  modes: Partial<Record<StudyMode, LibraryStatsModePoint>>;
}

export interface LibraryStatsModePoint {
  attempts: number;
  seen_entry_count: number;
  base_accuracy: number | null;
  pitch_accuracy: number | null;
  median_recall_latency_ms: number | null;
  study_time_ms: number;
}

export interface EntryDraft {
  term: string;
  meanings: string[];
  reading?: string;
}

export interface EntryRecord extends EntryDraft {
  id: string;
}

export interface EntryListRecord extends EntryRecord {
  position: number;
  attempts: number;
}

export interface SemanticRuntimeStatus {
  phase: "starting" | "downloading" | "loading" | "ready" | "unavailable" | string;
  download_progress?: number | null;
  model_id: string;
  model_version: string;
  dimension: number;
  backend: string;
  gpu_requested: boolean;
  load_time_ms?: number | null;
  last_embedding_ms?: number | null;
  error?: string | null;
}

export interface VoicevoxRuntimeStatus {
  phase: "starting" | "downloading" | "loading" | "ready" | "unavailable" | string;
  download_progress?: number | null;
  engine_version: string;
  backend: string;
  error?: string | null;
}

export interface StorageSettings {
  selected_path?: string | null;
  active_path: string;
  default_path: string;
  restart_required: boolean;
}

export interface AudioSettings {
  auto_play: boolean;
  volume: number;
  playback_rate: number;
}
