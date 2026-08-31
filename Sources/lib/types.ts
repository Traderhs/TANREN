export type StudyMode = "recognition" | "listening" | "production";

export interface DeckSummary {
  id: string;
  name: string;
  source_language: string;
  target_language: string;
  enabled_modes: StudyMode[];
  entry_count: number;
  current_round: number;
  active_stage?: string | null;
}

export interface StudyCard {
  entry_id: string;
  variant_id: string;
  mode: StudyMode;
  question: string;
  answer_language: string;
  remaining: number;
  total: number;
  stage_label: string;
  audio_path?: string | null;
  recall_timeout_ms: number;
  completion_idle_ms?: number | null;
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
  status: "pass" | "fail" | "ambiguous" | "pitch" | "review" | "stage_clear" | "round_complete";
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

export interface EntryDraft {
  term: string;
  meanings: string[];
  reading?: string;
}
