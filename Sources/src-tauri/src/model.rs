use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum StudyMode {
    Recognition,
    Listening,
    Production,
}

impl StudyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recognition => "recognition",
            Self::Listening => "listening",
            Self::Production => "production",
        }
    }

    pub fn answer_language<'a>(self, source: &'a str, target: &'a str) -> &'a str {
        match self {
            Self::Recognition => source,
            Self::Listening | Self::Production => target,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct RecallTimeoutByMode {
    pub recognition: u64,
    pub listening: u64,
    pub production: u64,
}

impl Default for RecallTimeoutByMode {
    fn default() -> Self {
        Self { recognition: 3_000, listening: 3_000, production: 3_000 }
    }
}

impl RecallTimeoutByMode {
    pub fn for_mode(&self, mode: StudyMode) -> u64 {
        match mode {
            StudyMode::Recognition => self.recognition,
            StudyMode::Listening => self.listening,
            StudyMode::Production => self.production,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckSummary {
    pub id: String,
    pub name: String,
    pub source_language: String,
    pub target_language: String,
    pub enabled_modes: Vec<StudyMode>,
    pub entry_count: usize,
    pub current_round: u32,
    pub active_stage: Option<String>,
    pub study_ranges: Vec<StudyRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudyRange {
    pub stage_index: usize,
    pub label: String,
    pub start: usize,
    pub end: usize,
    pub cumulative: bool,
}

#[derive(Debug, Clone)]
pub struct DeckRecord {
    pub id: String,
    pub name: String,
    pub source_language: String,
    pub target_language: String,
    pub enabled_modes: Vec<StudyMode>,
    pub increment_size: usize,
    pub checkpoint_size: usize,
    pub recall_timeout_by_mode: RecallTimeoutByMode,
    pub adaptive_completion_timer_enabled: bool,
    pub pitch_policy: String,
    pub strict_orthography: bool,
    pub current_round: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryDraft {
    pub term: String,
    pub meanings: Vec<String>,
    pub reading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportResult {
    pub inserted: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone)]
pub struct EntryRecord {
    pub id: String,
    pub term: String,
    pub meanings: Vec<String>,
    pub reading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioAssetDraft {
    pub cache_key: String,
    pub path: String,
    pub provider: String,
    pub voice_profile: String,
    pub age_band: String,
    pub gender_presentation: String,
    pub speaker_id: Option<i64>,
    pub speaker_name: Option<String>,
    pub accent_type: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct VariantKey {
    pub entry_id: String,
    pub mode: StudyMode,
}

impl VariantKey {
    pub fn id(&self) -> String {
        format!("{}:{}", self.entry_id, self.mode.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum StageKind {
    Expanding { start: usize, end: usize },
    Cumulative { end: usize },
}

impl StageKind {
    pub fn label(&self) -> String {
        match self {
            Self::Expanding { start, end } => format!("{}~{}", start, end),
            Self::Cumulative { end } => format!("0~{} · cumulative", end),
        }
    }

    pub fn range(&self) -> (usize, usize) {
        match self {
            Self::Expanding { start, end } => (*start, *end),
            Self::Cumulative { end } => (0, *end),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyCard {
    pub entry_id: String,
    pub variant_id: String,
    pub mode: StudyMode,
    pub question: String,
    pub answer_language: String,
    pub remaining: usize,
    pub total: usize,
    pub stage_label: String,
    pub audio_path: Option<String>,
    pub recall_timeout_ms: u64,
    pub completion_idle_ms: Option<u64>,
    pub input_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PitchConfidence {
    Manual,
    Verified,
    Consensus,
    Predicted,
}

impl PitchConfidence {
    pub fn gates_by_default(&self) -> bool {
        !matches!(self, Self::Predicted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitchQuestion {
    pub kind: String,
    pub reading: String,
    pub morae: Vec<String>,
    pub phrase_count: usize,
    pub allowed_patterns: Vec<Vec<u8>>,
    pub confidence: PitchConfidence,
    pub gate_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitStatus {
    Pass,
    Fail,
    Ambiguous,
    Pitch,
    Review,
    StageClear,
    RoundComplete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitResult {
    pub status: SubmitStatus,
    pub message: Option<String>,
    pub failure_type: Option<String>,
    pub canonical_answer: Option<String>,
    pub reading: Option<String>,
    pub pitch: Option<PitchQuestion>,
    pub card: Option<StudyCard>,
}

impl SubmitResult {
    pub fn simple(status: SubmitStatus) -> Self {
        Self {
            status,
            message: None,
            failure_type: None,
            canonical_answer: None,
            reading: None,
            pitch: None,
            card: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckStats {
    pub mode: StudyMode,
    pub base_accuracy: Option<f64>,
    pub pitch_accuracy: Option<f64>,
    pub joint_accuracy: Option<f64>,
    pub median_recall_latency_ms: Option<u64>,
    pub attempts: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradeDecision {
    Pass,
    Fail,
    Ambiguous,
}

#[derive(Debug, Clone)]
pub struct GradeOutcome {
    pub decision: GradeDecision,
    pub method: &'static str,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureType {
    ManualUnknown,
    RecallTimeout,
    CompletionTimeout,
    WrongAnswer,
    PitchWrong,
    GradingRejected,
}

impl FailureType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ManualUnknown => "MANUAL_UNKNOWN",
            Self::RecallTimeout => "RECALL_TIMEOUT",
            Self::CompletionTimeout => "COMPLETION_TIMEOUT",
            Self::WrongAnswer => "WRONG_ANSWER",
            Self::PitchWrong => "PITCH_WRONG",
            Self::GradingRejected => "GRADING_REJECTED",
        }
    }
}
