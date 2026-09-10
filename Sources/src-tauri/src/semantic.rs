use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

use serde::Serialize;

use crate::{
    db::Database,
    grading::{grade_reading_deterministic, normalize_generic, split_reading_answer},
    model::{EntryRecord, GradeDecision, GradeOutcome, MeaningGrade},
};

const QUERY_INSTRUCTION: &str = "Instruct: 한국어 학습 답변과 사전의 한국어 의미가 같은 뜻인지 검색하세요.\nQuery: ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendIdentity {
    pub model_id: String,
    pub model_version: String,
    pub dimension: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticRuntimeStatus {
    pub phase: String,
    pub download_progress: Option<u8>,
    pub load_progress: Option<u8>,
    pub model_id: String,
    pub model_version: String,
    pub dimension: usize,
    pub backend: String,
    pub gpu_requested: bool,
    pub load_time_ms: Option<u64>,
    pub last_embedding_ms: Option<u64>,
    pub error: Option<String>,
}

pub trait EmbeddingBackend: Send + Sync {
    fn identity(&self) -> BackendIdentity;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    fn status(&self) -> SemanticRuntimeStatus;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RelationEvidence {
    pub entailment: f64,
    pub contradiction: f64,
}

#[derive(Debug, Clone)]
pub struct RelationRuntimeStatus {
    pub phase: String,
    pub load_progress: Option<u8>,
    pub error: Option<String>,
}

pub trait SemanticRelationBackend: Send + Sync {
    fn relations(&self, pairs: &[(String, String)]) -> Result<Vec<RelationEvidence>, String>;
    fn status(&self) -> RelationRuntimeStatus;
}

#[derive(Debug, Clone)]
pub struct MeaningAdjudication {
    pub canonical_answer: String,
    pub submitted_answer: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SemanticThresholds {
    pub pass: f64,
    pub fail: f64,
    pub minimum_margin: f64,
    pub context_pass: f64,
    pub context_support: f64,
    pub context_rescue_floor: f64,
    pub descriptive_plain_relatedness: f64,
    pub descriptive_source_relatedness: f64,
    pub entailment_pass: f64,
    pub contradiction_block: f64,
    pub contradiction_fail: f64,
}

impl Default for SemanticThresholds {
    fn default() -> Self {
        Self {
            pass: 0.74,
            fail: 0.45,
            minimum_margin: 0.08,
            context_pass: 0.90,
            context_support: 0.80,
            context_rescue_floor: 0.30,
            descriptive_plain_relatedness: 0.62,
            descriptive_source_relatedness: 0.65,
            entailment_pass: 0.70,
            contradiction_block: 0.08,
            contradiction_fail: 0.50,
        }
    }
}

impl SemanticThresholds {
    pub fn configured() -> Self {
        let defaults = Self::default();
        Self {
            pass: threshold_from_env("TANREN_SEMANTIC_PASS_THRESHOLD", defaults.pass),
            fail: threshold_from_env("TANREN_SEMANTIC_FAIL_THRESHOLD", defaults.fail),
            minimum_margin: threshold_from_env("TANREN_SEMANTIC_MINIMUM_MARGIN", defaults.minimum_margin),
            context_pass: threshold_from_env("TANREN_SEMANTIC_CONTEXT_PASS_THRESHOLD", defaults.context_pass),
            context_support: threshold_from_env("TANREN_SEMANTIC_CONTEXT_SUPPORT_THRESHOLD", defaults.context_support),
            context_rescue_floor: threshold_from_env("TANREN_SEMANTIC_CONTEXT_RESCUE_FLOOR", defaults.context_rescue_floor),
            descriptive_plain_relatedness: threshold_from_env("TANREN_SEMANTIC_DESCRIPTIVE_PLAIN_RELATEDNESS", defaults.descriptive_plain_relatedness),
            descriptive_source_relatedness: threshold_from_env("TANREN_SEMANTIC_DESCRIPTIVE_SOURCE_RELATEDNESS", defaults.descriptive_source_relatedness),
            entailment_pass: threshold_from_env("TANREN_SEMANTIC_ENTAILMENT_PASS", defaults.entailment_pass),
            contradiction_block: threshold_from_env("TANREN_SEMANTIC_CONTRADICTION_BLOCK", defaults.contradiction_block),
            contradiction_fail: threshold_from_env("TANREN_SEMANTIC_CONTRADICTION_FAIL", defaults.contradiction_fail),
        }
    }
}

#[derive(Clone, Eq)]
struct CacheKey {
    normalized_text: String,
    purpose: &'static str,
    model_id: String,
    model_version: String,
    dimension: usize,
}

impl PartialEq for CacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.normalized_text == other.normalized_text
            && self.purpose == other.purpose
            && self.model_id == other.model_id
            && self.model_version == other.model_version
            && self.dimension == other.dimension
    }
}

impl Hash for CacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.normalized_text.hash(state);
        self.purpose.hash(state);
        self.model_id.hash(state);
        self.model_version.hash(state);
        self.dimension.hash(state);
    }
}

pub struct SemanticGrader {
    backend: Arc<dyn EmbeddingBackend>,
    relation_backend: Arc<dyn SemanticRelationBackend>,
    db: Database,
    thresholds: SemanticThresholds,
    memory_cache: Mutex<HashMap<CacheKey, Vec<f32>>>,
}

impl SemanticGrader {
    pub fn new(
        backend: Arc<dyn EmbeddingBackend>,
        relation_backend: Arc<dyn SemanticRelationBackend>,
        db: Database,
        thresholds: SemanticThresholds,
    ) -> Self {
        Self { backend, relation_backend, db, thresholds, memory_cache: Mutex::new(HashMap::new()) }
    }

    pub fn status(&self) -> SemanticRuntimeStatus {
        let mut status = self.backend.status();
        let relation = self.relation_backend.status();
        if status.phase == "ready" && relation.phase != "ready" {
            status.phase = relation.phase;
            status.load_progress = relation.load_progress;
            status.error = relation.error;
        }
        status
    }

    pub fn grade_reading(&self, entry: &EntryRecord, answer: &str, accepted: &[String], rejected: &[String], answer_language: &str, expression_language: &str) -> GradeOutcome {
        self.grade_reading_with_adjudications(entry, answer, accepted, rejected, answer_language, expression_language).0
    }

    pub fn grade_reading_with_adjudications(&self, entry: &EntryRecord, answer: &str, accepted: &[String], rejected: &[String], answer_language: &str, expression_language: &str) -> (GradeOutcome, Vec<MeaningAdjudication>) {
        if let Some(outcome) = grade_reading_deterministic(entry, answer, accepted, rejected) {
            return (outcome, Vec::new());
        }

        if entry.meanings.len() > 1 {
            return self.grade_multiple_meanings(entry, answer, answer_language, expression_language);
        }

        (self.grade_single_meaning(entry, answer, accepted, rejected, answer_language, expression_language), Vec::new())
    }

    pub fn grade_overfilled_meanings(&self, entry: &EntryRecord, answer: &str, answer_language: &str, expression_language: &str) -> Option<Vec<MeaningGrade>> {
        let answers = split_overfilled_meaning_answer(entry, answer)?;
        let passes = answers.iter().map(|answer| {
            entry.meanings.iter().map(|meaning| {
                let mut pair_entry = entry.clone();
                pair_entry.meanings = vec![meaning.clone()];
                self.grade_reading(&pair_entry, answer, &[], &[], answer_language, expression_language).decision == GradeDecision::Pass
            }).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        let matched = maximum_pass_matching(&passes);
        Some(answers.into_iter().enumerate().map(|(index, submitted_answer)| MeaningGrade {
            submitted_answer,
            correct: matched[index],
        }).collect())
    }

    fn grade_single_meaning(&self, entry: &EntryRecord, answer: &str, accepted: &[String], rejected: &[String], answer_language: &str, expression_language: &str) -> GradeOutcome {

        let normalized_answer = normalize_generic(answer);
        if normalized_answer.chars().count() < 2 {
            return GradeOutcome { decision: GradeDecision::Fail, method: "semantic_degenerate", score: Some(0.0) };
        }

        let positives = normalized_unique(entry.meanings.iter().chain(accepted.iter()));
        if positives.is_empty() {
            return GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_no_positive", score: None };
        }
        if positives.iter().any(|value| contains_hangul(value)) && !contains_hangul(&normalized_answer) {
            return GradeOutcome { decision: GradeDecision::Fail, method: "semantic_wrong_language", score: Some(0.0) };
        }
        let negatives = normalized_unique(rejected.iter());

        let answer_embedding = match self.embeddings(&[("query", normalized_answer.clone())]) {
            Ok(mut values) => values.remove(0),
            Err(_) => return GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_unavailable", score: None },
        };
        let positive_embeddings = match self.document_embeddings(&positives) {
            Ok(values) => values,
            Err(_) => return GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_unavailable", score: None },
        };
        let best_positive = positive_embeddings.iter().map(|value| cosine(&answer_embedding, value)).fold(-1.0, f64::max);

        let best_negative = if negatives.is_empty() {
            None
        } else {
            match self.document_embeddings(&negatives) {
                Ok(values) => Some(values.iter().map(|value| cosine(&answer_embedding, value)).fold(-1.0, f64::max)),
                Err(_) => return GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_unavailable", score: None },
            }
        };

        let margin = best_negative.map(|negative| best_positive - negative).unwrap_or(f64::INFINITY);
        let context_positive = self
            .contextual_translation_score(entry, &normalized_answer, &positives, answer_language, expression_language)
            .ok();
        let direct_candidate = best_positive >= self.thresholds.pass && margin >= self.thresholds.minimum_margin;
        let context_candidate = context_positive.is_some_and(|score| score >= self.thresholds.context_support);
        let descriptive_relatedness = if best_positive <= self.thresholds.fail
            && descriptive_length_ratio(&normalized_answer, &positives) >= 3.0
        {
            self.descriptive_relatedness_scores(entry, &normalized_answer, &positive_embeddings).ok()
        } else {
            None
        };
        let descriptive_candidate = descriptive_relatedness.is_some_and(|(plain, source)| {
            plain >= self.thresholds.descriptive_plain_relatedness
                && source >= self.thresholds.descriptive_source_relatedness
        });

        if direct_candidate || context_candidate || descriptive_candidate {
            let relation = match self.best_relation(entry, &normalized_answer, &positives) {
                Ok(value) => value,
                Err(_) => {
                    return GradeOutcome {
                        decision: GradeDecision::Ambiguous,
                        method: "semantic_verifier_unavailable",
                        score: Some(best_positive),
                    };
                }
            };
            if relation.contradiction >= self.thresholds.contradiction_fail {
                return GradeOutcome {
                    decision: GradeDecision::Fail,
                    method: "semantic_contradiction",
                    score: Some(relation.contradiction),
                };
            }
            let context_rescue = context_positive.is_some_and(|score| score >= self.thresholds.context_pass)
                && best_positive >= self.thresholds.context_rescue_floor
                && margin >= self.thresholds.minimum_margin
                && relation.entailment >= self.thresholds.entailment_pass;
            if (direct_candidate || context_rescue) && relation.contradiction < self.thresholds.contradiction_block {
                return GradeOutcome {
                    decision: GradeDecision::Pass,
                    method: "semantic_consensus",
                    score: Some(best_positive),
                };
            }
        }

        if best_negative.is_some_and(|negative| negative >= best_positive && negative >= self.thresholds.fail) {
            GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_negative", score: Some(best_positive) }
        } else if context_positive.is_some_and(|score| score >= self.thresholds.context_support) {
            GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_context_embedding", score: context_positive }
        } else if descriptive_candidate {
            GradeOutcome {
                decision: GradeDecision::Ambiguous,
                method: "semantic_descriptive_related",
                score: descriptive_relatedness.map(|(plain, source)| plain.min(source)),
            }
        } else if best_positive <= self.thresholds.fail {
            GradeOutcome { decision: GradeDecision::Fail, method: "semantic_embedding", score: Some(best_positive) }
        } else {
            GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_embedding", score: Some(best_positive) }
        }
    }

    fn contextual_translation_score(&self, entry: &EntryRecord, answer: &str, positives: &[String], answer_language: &str, expression_language: &str) -> Result<f64, String> {
        let answer_text = contextual_translation_text(entry, answer, answer_language, expression_language)?;
        let answer_embedding = self.embeddings(&[("context_query", answer_text)])?.remove(0);
        let positive_requests: Vec<_> = positives.iter()
            .map(|value| contextual_translation_text(entry, value, answer_language, expression_language).map(|text| ("context_document", text)))
            .collect::<Result<_, _>>()?;
        let positive_embeddings = self.embeddings(&positive_requests)?;
        let best_positive = positive_embeddings.iter().map(|value| cosine(&answer_embedding, value)).fold(-1.0, f64::max);
        Ok(best_positive)
    }

    fn descriptive_relatedness_scores(&self, entry: &EntryRecord, answer: &str, positive_embeddings: &[Vec<f32>]) -> Result<(f64, f64), String> {
        let source = normalize_generic(&entry.term);
        if source.is_empty() {
            return Err("semantic source term is empty".into());
        }
        let values = self.document_embeddings(&[source, answer.to_string()])?;
        if values.len() != 2 {
            return Err("semantic descriptive relatedness response count mismatch".into());
        }
        let source_relatedness = cosine(&values[0], &values[1]);
        let plain_relatedness = positive_embeddings
            .iter()
            .map(|positive| cosine(&values[1], positive))
            .fold(-1.0, f64::max);
        Ok((plain_relatedness, source_relatedness))
    }

    fn best_relation(&self, entry: &EntryRecord, answer: &str, positives: &[String]) -> Result<RelationEvidence, String> {
        let source = entry.term.trim();
        if source.is_empty() {
            return Err("semantic source term is empty".into());
        }
        let mut pairs = Vec::with_capacity(positives.len() * 2);
        for positive in positives {
            let positive = semantic_relation_text(source, positive);
            let answer = semantic_relation_text(source, answer);
            pairs.push((positive.clone(), answer.clone()));
            pairs.push((answer, positive));
        }
        let evidence = self.relation_backend.relations(&pairs)?;
        if evidence.len() != pairs.len() {
            return Err("semantic relation response count mismatch".into());
        }

        evidence
            .chunks_exact(2)
            .map(|directions| RelationEvidence {
                entailment: directions[0].entailment.max(directions[1].entailment),
                contradiction: directions[0].contradiction.max(directions[1].contradiction),
            })
            .max_by(|left, right| {
                let left_compatibility = left.entailment - left.contradiction;
                let right_compatibility = right.entailment - right.contradiction;
                left_compatibility.total_cmp(&right_compatibility)
            })
            .ok_or_else(|| "semantic relation has no positive reference".into())
    }

    fn grade_multiple_meanings(&self, entry: &EntryRecord, answer: &str, answer_language: &str, expression_language: &str) -> (GradeOutcome, Vec<MeaningAdjudication>) {
        let answers = split_reading_answer(answer, entry.meanings.len());
        if answers.len() != entry.meanings.len() {
            return (GradeOutcome { decision: GradeDecision::Fail, method: "meaning_count_mismatch", score: Some(0.0) }, Vec::new());
        }

        let normalized_answers = normalized_unique(answers.iter());
        if normalized_answers.len() != answers.len() {
            return (GradeOutcome { decision: GradeDecision::Fail, method: "duplicate_meaning_answer", score: Some(0.0) }, Vec::new());
        }
        if normalized_answers.iter().any(|value| value.chars().count() < 2) {
            return (GradeOutcome { decision: GradeDecision::Fail, method: "semantic_degenerate", score: Some(0.0) }, Vec::new());
        }

        let meanings = normalized_unique(entry.meanings.iter());
        if meanings.len() != entry.meanings.len() {
            return (GradeOutcome { decision: GradeDecision::Fail, method: "duplicate_canonical_meaning", score: Some(0.0) }, Vec::new());
        }
        if meanings.iter().any(|value| contains_hangul(value)) && normalized_answers.iter().any(|value| !contains_hangul(value)) {
            return (GradeOutcome { decision: GradeDecision::Fail, method: "semantic_wrong_language", score: Some(0.0) }, Vec::new());
        }

        let answer_requests: Vec<_> = normalized_answers.iter().cloned().map(|value| ("query", value)).collect();
        let answer_embeddings = match self.embeddings(&answer_requests) {
            Ok(values) => values,
            Err(_) => return (GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_unavailable", score: None }, Vec::new()),
        };
        let meaning_embeddings = match self.document_embeddings(&meanings) {
            Ok(values) => values,
            Err(_) => return (GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_unavailable", score: None }, Vec::new()),
        };
        let plain_scores: Vec<Vec<f64>> = answer_embeddings.iter().map(|answer_embedding| {
            meaning_embeddings.iter().map(|meaning_embedding| cosine(answer_embedding, meaning_embedding)).collect()
        }).collect();

        let mut outcomes = Vec::with_capacity(normalized_answers.len());
        let mut scores = Vec::with_capacity(normalized_answers.len());
        let mut passes = Vec::with_capacity(normalized_answers.len());
        for answer in &normalized_answers {
            let mut outcome_row = Vec::with_capacity(meanings.len());
            let mut score_row = Vec::with_capacity(meanings.len());
            let mut pass_row = Vec::with_capacity(meanings.len());
            for meaning in &meanings {
                let mut pair_entry = entry.clone();
                pair_entry.meanings = vec![meaning.clone()];
                let outcome = self.grade_reading(&pair_entry, answer, &[], &[], answer_language, expression_language);
                let score = outcome.score.unwrap_or(match outcome.decision {
                    GradeDecision::Pass => 1.0,
                    GradeDecision::Ambiguous => 0.5,
                    GradeDecision::Fail => 0.0,
                });
                let passed = outcome.decision == GradeDecision::Pass;
                pass_row.push(if passed { 1.0 } else { 0.0 });
                score_row.push(score);
                outcome_row.push(outcome);
            }
            outcomes.push(outcome_row);
            scores.push(score_row);
            passes.push(pass_row);
        }

        if let Some(matching) = perfect_matching(&passes, |score| score > 0.5) {
            return (GradeOutcome {
                decision: GradeDecision::Pass,
                method: "semantic_multi_consensus",
                score: Some(matching_floor(&scores, &matching)),
            }, Vec::new());
        }
        if let Some(matching) = perfect_matching(&plain_scores, |_| true) {
            let verifier_blocked = matching.iter().enumerate().any(|(row, &column)| {
                matches!(outcomes[row][column].method, "semantic_contradiction" | "semantic_verifier_unavailable")
            });
            let adjudications = matching.iter().enumerate().filter_map(|(row, &column)| {
                let outcome = &outcomes[row][column];
                (outcome.decision != GradeDecision::Pass).then(|| MeaningAdjudication {
                    canonical_answer: meanings[column].clone(),
                    submitted_answer: normalized_answers[row].clone(),
                })
            }).collect();
            return (GradeOutcome {
                decision: GradeDecision::Ambiguous,
                method: if verifier_blocked { "semantic_multi_verifier" } else { "semantic_multi_embedding" },
                score: Some(matching_floor(&scores, &matching)),
            }, adjudications);
        }

        (GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_multi_embedding", score: Some(best_row_floor(&scores)) }, Vec::new())
    }

    pub fn precompute_documents(&self, texts: &[String]) -> Result<(), String> {
        let normalized = normalized_unique(texts.iter());
        for batch in normalized.chunks(32) {
            self.document_embeddings(batch)?;
        }
        Ok(())
    }

    fn document_embeddings(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let requested: Vec<_> = texts.iter().cloned().map(|value| ("document", value)).collect();
        self.embeddings(&requested)
    }

    fn embeddings(&self, requested: &[(&'static str, String)]) -> Result<Vec<Vec<f32>>, String> {
        let identity = self.backend.identity();
        let keys: Vec<_> = requested.iter().map(|(purpose, normalized_text)| CacheKey {
            normalized_text: normalized_text.clone(),
            purpose,
            model_id: identity.model_id.clone(),
            model_version: identity.model_version.clone(),
            dimension: identity.dimension,
        }).collect();

        let mut resolved: Vec<Option<Vec<f32>>> = vec![None; keys.len()];
        let mut missing = Vec::new();
        {
            let cache = self.memory_cache.lock().map_err(|_| "semantic cache lock poisoned")?;
            for (index, key) in keys.iter().enumerate() {
                if let Some(value) = cache.get(key) { resolved[index] = Some(value.clone()); }
            }
        }
        for (index, key) in keys.iter().enumerate() {
            if resolved[index].is_some() { continue; }
            if let Some(value) = self.db.cached_embedding(&key.normalized_text, key.purpose, &key.model_id, &key.model_version, key.dimension)? {
                resolved[index] = Some(value);
            } else {
                let encoded = match key.purpose {
                    "query" | "context_query" => format!("{QUERY_INSTRUCTION}{}", key.normalized_text),
                    _ => key.normalized_text.clone(),
                };
                missing.push((index, encoded));
            }
        }

        if !missing.is_empty() {
            let inputs: Vec<_> = missing.iter().map(|(_, value)| value.clone()).collect();
            let embedded = self.backend.embed(&inputs)?;
            if embedded.len() != missing.len() { return Err("embedding response count mismatch".into()); }
            for ((index, _), value) in missing.into_iter().zip(embedded) {
                if value.len() != identity.dimension { return Err("embedding dimension mismatch".into()); }
                let value = normalized_embedding(value)?;
                let key = &keys[index];
                self.db.cache_embedding(&key.normalized_text, key.purpose, &key.model_id, &key.model_version, &value)?;
                resolved[index] = Some(value);
            }
        }

        let values: Vec<Vec<f32>> = resolved.into_iter().collect::<Option<_>>().ok_or("embedding cache resolution failed")?;
        let mut cache = self.memory_cache.lock().map_err(|_| "semantic cache lock poisoned")?;
        for (key, value) in keys.into_iter().zip(values.iter()) { cache.insert(key, value.clone()); }
        Ok(values)
    }
}

fn normalized_unique<'a>(values: impl Iterator<Item = &'a String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values.map(|value| normalize_generic(value)).filter(|value| !value.is_empty() && seen.insert(value.clone())).collect()
}

fn descriptive_length_ratio(answer: &str, positives: &[String]) -> f64 {
    let answer_len = answer.chars().filter(|c| !c.is_whitespace()).count();
    let Some(reference_len) = positives
        .iter()
        .map(|value| value.chars().filter(|c| !c.is_whitespace()).count())
        .filter(|len| *len > 0)
        .min()
    else {
        return 0.0;
    };
    answer_len as f64 / reference_len as f64
}

fn contains_hangul(value: &str) -> bool { value.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)) }

fn semantic_relation_text(source: &str, meaning: &str) -> String {
    let source = source.replace('"', "\\\"");
    let meaning = meaning.replace('"', "\\\"");
    format!("The translation of source expression \"{source}\" is \"{meaning}\".")
}

fn contextual_translation_text(entry: &EntryRecord, meaning: &str, answer_language: &str, expression_language: &str) -> Result<String, String> {
    let term = entry.term.trim();
    if term.is_empty() { return Err("semantic source term is empty".into()); }
    let source = entry.reading.as_deref().map(str::trim).filter(|value| !value.is_empty())
        .map(|reading| format!("{term}({reading})"))
        .unwrap_or_else(|| term.to_string());
    Ok(format!("{expression_language} 표현 {source}의 {answer_language} 뜻: {meaning}"))
}

fn threshold_from_env(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|value| value.parse::<f64>().ok()).filter(|value| (0.0..=1.0).contains(value)).unwrap_or(default)
}

fn normalized_embedding(mut value: Vec<f32>) -> Result<Vec<f32>, String> {
    let norm = value.iter().map(|item| (*item as f64) * (*item as f64)).sum::<f64>().sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON { return Err("degenerate embedding".into()); }
    for item in &mut value { *item = (*item as f64 / norm) as f32; }
    Ok(value)
}

fn cosine(a: &[f32], b: &[f32]) -> f64 { a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum() }

fn split_overfilled_meaning_answer(entry: &EntryRecord, answer: &str) -> Option<Vec<String>> {
    let expected_count = entry.meanings.len();
    if expected_count <= 1 { return None; }
    let parts = split_reading_answer(answer, expected_count);
    if parts.len() > expected_count { return Some(parts); }
    if entry.meanings.iter().any(|meaning| meaning.chars().any(char::is_whitespace)) { return None; }
    let whitespace_parts = answer.split_whitespace().map(ToOwned::to_owned).collect::<Vec<_>>();
    (whitespace_parts.len() > expected_count).then_some(whitespace_parts)
}

fn maximum_pass_matching(matrix: &[Vec<bool>]) -> Vec<bool> {
    fn augment(row: usize, matrix: &[Vec<bool>], seen: &mut [bool], column_to_row: &mut [Option<usize>]) -> bool {
        for column in 0..matrix[row].len() {
            if seen[column] || !matrix[row][column] { continue; }
            seen[column] = true;
            if column_to_row[column].is_none_or(|previous_row| augment(previous_row, matrix, seen, column_to_row)) {
                column_to_row[column] = Some(row);
                return true;
            }
        }
        false
    }

    let column_count = matrix.first().map_or(0, Vec::len);
    let mut column_to_row = vec![None; column_count];
    for row in 0..matrix.len() {
        let mut seen = vec![false; column_count];
        augment(row, matrix, &mut seen, &mut column_to_row);
    }
    let mut matched = vec![false; matrix.len()];
    for row in column_to_row.into_iter().flatten() { matched[row] = true; }
    matched
}

fn perfect_matching(matrix: &[Vec<f64>], allowed: impl Fn(f64) -> bool + Copy) -> Option<Vec<usize>> {
    fn augment(
        row: usize,
        matrix: &[Vec<f64>],
        seen: &mut [bool],
        column_to_row: &mut [Option<usize>],
        allowed: impl Fn(f64) -> bool + Copy,
    ) -> bool {
        let mut columns = (0..matrix[row].len()).collect::<Vec<_>>();
        columns.sort_unstable_by(|&left, &right| matrix[row][right].total_cmp(&matrix[row][left]));
        for column in columns {
            if seen[column] || !allowed(matrix[row][column]) {
                continue;
            }
            seen[column] = true;
            if column_to_row[column].is_none_or(|previous_row| augment(previous_row, matrix, seen, column_to_row, allowed)) {
                column_to_row[column] = Some(row);
                return true;
            }
        }
        false
    }

    if matrix.is_empty() || matrix.iter().any(|row| row.len() != matrix.len()) {
        return None;
    }
    let mut column_to_row = vec![None; matrix.len()];
    for row in 0..matrix.len() {
        let mut seen = vec![false; matrix.len()];
        if !augment(row, matrix, &mut seen, &mut column_to_row, allowed) {
            return None;
        }
    }
    let mut row_to_column = vec![0; matrix.len()];
    for (column, row) in column_to_row.into_iter().enumerate() {
        row_to_column[row?] = column;
    }
    Some(row_to_column)
}

fn matching_floor(matrix: &[Vec<f64>], matching: &[usize]) -> f64 {
    matching.iter().enumerate().map(|(row, &column)| matrix[row][column]).fold(1.0, f64::min)
}

fn best_row_floor(matrix: &[Vec<f64>]) -> f64 {
    matrix
        .iter()
        .map(|row| row.iter().copied().fold(-1.0, f64::max))
        .fold(1.0, f64::min)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{semantic_llama::LlamaCppEmbeddingBackend, semantic_nli::OnnxNliRelationBackend};
    use std::{path::PathBuf, thread, time::{Duration, Instant}};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    struct FakeBackend { calls: AtomicUsize, unavailable: bool }
    struct FakeRelationBackend { evidence: RelationEvidence, calls: AtomicUsize }

    impl EmbeddingBackend for FakeBackend {
        fn identity(&self) -> BackendIdentity { BackendIdentity { model_id: "fake".into(), model_version: "1".into(), dimension: 4 } }
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.unavailable { return Err("offline".into()); }
            Ok(texts.iter().map(|text| {
                if text.contains("ja-JP 표현 セックス의 ko-KR 뜻: 자지를 보지에 박는다") { vec![0.0, 0.0, 0.0, 1.0] }
                else if text == "ja-JP 표현 セックス의 ko-KR 뜻: 섹스" { vec![1.0, 0.0, 0.0, 0.0] }
                else if text.starts_with(QUERY_INSTRUCTION) && text.ends_with("자지를 보지에 박는다") { vec![0.0, 0.0, 0.0, 1.0] }
                else if text == "섹스" { vec![1.0, 0.0, 0.0, 0.0] }
                else if text == "セックス" { vec![0.7, 0.7, 0.0, 0.0] }
                else if text == "자지를 보지에 박는다" { vec![0.7, 0.7, 0.0, 0.0] }
                else if text == "見据える" { vec![1.0, 0.0, 0.0, 0.0] }
                else if text == "棚" { vec![0.0, 1.0, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 今日はいい天気ですね") && text.contains("오늘 날씨 좋네요") { vec![0.95, 0.3122, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 今日はいい天気ですね") && text.contains("오늘 날이 안좋네요") { vec![0.95, 0.3122, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 今日はいい天気ですね") && text.contains("오늘은 좋은 날씨네요") { vec![1.0, 0.0, 0.0, 0.0] }
                else if text.ends_with("오늘 날씨 좋네요") { vec![0.66, 0.7513, 0.0, 0.0] }
                else if text.ends_with("오늘 날이 안좋네요") { vec![0.66, 0.7513, 0.0, 0.0] }
                else if text == "오늘은 좋은 날씨네요" { vec![1.0, 0.0, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 棚(たな)의 ko-KR 뜻: 찬장") { vec![0.93, 0.3676, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 棚(たな)의 ko-KR 뜻: 서랍장") { vec![0.91, 0.4146, 0.0, 0.0] }
                else if text == "ja-JP 표현 棚(たな)의 ko-KR 뜻: 선반" { vec![1.0, 0.0, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 棚(たな)의 ko-KR 뜻: 냉장고") { vec![0.0, 0.0, 0.0, 1.0] }
                else if text.contains("ja-JP 표현 見据える의 ko-KR 뜻: 내다보다") || text.contains("ja-JP 표현 見据える의 ko-KR 뜻: 전망하다") { vec![1.0, 0.0, 0.0, 0.0] }
                else if text.contains("ja-JP 표현 見据える의 ko-KR 뜻: 쳐다보다") { vec![0.0, 0.0, 0.0, 1.0] }
                else if text == "선반" { vec![0.0, 1.0, 0.0, 0.0] }
                else if text.ends_with("전화하다") || text.ends_with("전화를 걸다") { vec![0.0, 1.0, 0.0, 0.0] }
                else if text.contains("미래를 내다보다") || text == "내다보다" || text == "전망하다" || text.ends_with("걸다") || text.ends_with("매달다") { vec![1.0, 0.0, 0.0, 0.0] }
                else if text == "시간을 들이다" || text.ends_with("시간을 쓰다") { vec![0.0, 0.0, 1.0, 0.0] }
                else if text.contains("쳐다보다") { vec![0.0, 0.0, 0.0, 1.0] }
                else if text.contains("과거만 보다") { vec![0.8, 0.0, 0.0, 0.6] }
                else { vec![0.0, 0.0, 0.0, 1.0] }
            }).collect())
        }
        fn status(&self) -> SemanticRuntimeStatus { SemanticRuntimeStatus { phase: "ready".into(), download_progress: None, load_progress: Some(100), model_id: "fake".into(), model_version: "1".into(), dimension: 4, backend: "fake".into(), gpu_requested: false, load_time_ms: Some(0), last_embedding_ms: Some(0), error: None } }
    }

    impl SemanticRelationBackend for FakeRelationBackend {
        fn relations(&self, pairs: &[(String, String)]) -> Result<Vec<RelationEvidence>, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![self.evidence; pairs.len()])
        }

        fn status(&self) -> RelationRuntimeStatus {
            RelationRuntimeStatus { phase: "ready".into(), load_progress: Some(100), error: None }
        }
    }

    fn entry() -> EntryRecord { EntryRecord { id: "e".into(), term: "見据える".into(), meanings: vec!["내다보다".into()], reading: None } }

    fn multi_entry() -> EntryRecord {
        EntryRecord {
            id: "multi".into(),
            term: "掛ける".into(),
            meanings: vec!["걸다".into(), "전화를 걸다".into(), "시간을 들이다".into()],
            reading: None,
        }
    }

    fn shelf_entry() -> EntryRecord {
        EntryRecord { id: "shelf".into(), term: "棚".into(), meanings: vec!["선반".into()], reading: Some("たな".into()) }
    }

    fn grader(backend: Arc<FakeBackend>) -> SemanticGrader {
        grader_with_relation(
            backend,
            Arc::new(FakeRelationBackend {
                evidence: RelationEvidence { entailment: 0.9, contradiction: 0.01 },
                calls: AtomicUsize::new(0),
            }),
        )
    }

    fn grader_with_relation(backend: Arc<FakeBackend>, relation: Arc<FakeRelationBackend>) -> SemanticGrader {
        grader_with_relation_thresholds(
            backend,
            relation,
            SemanticThresholds { pass: 0.9, fail: 0.4, minimum_margin: 0.1, ..SemanticThresholds::default() },
        )
    }

    fn grader_with_relation_thresholds(
        backend: Arc<FakeBackend>,
        relation: Arc<FakeRelationBackend>,
        thresholds: SemanticThresholds,
    ) -> SemanticGrader {
        let dir = tempdir().unwrap().keep();
        let db = Database::open(dir.join("semantic.db")).unwrap();
        SemanticGrader::new(backend, relation, db, thresholds)
    }

    #[test]
    fn deterministic_alias_paths_never_call_model() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend.clone());
        assert_eq!(grader.grade_reading(&entry(), "내다보다", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Pass);
        assert_eq!(grader.grade_reading(&entry(), "앞날", &["앞날".into()], &[], "ko-KR", "ja-JP").decision, GradeDecision::Pass);
        assert_eq!(grader.grade_reading(&entry(), "과거", &[], &["과거".into()], "ko-KR", "ja-JP").decision, GradeDecision::Fail);
        assert_eq!(backend.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn bulk_precompute_batches_and_preserves_cached_vectors() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend.clone());
        let texts: Vec<_> = (0..9000).map(|index| format!("meaning {index}")).collect();
        grader.precompute_documents(&texts).unwrap();
        assert_eq!(backend.calls.load(Ordering::Relaxed), 9000usize.div_ceil(32));
        let cached = grader.document_embeddings(&texts).unwrap();
        assert_eq!(cached.len(), 9000);
        assert!(cached.iter().all(|value| value == &vec![0.0, 0.0, 0.0, 1.0]));
        grader.precompute_documents(&texts).unwrap();
        assert_eq!(backend.calls.load(Ordering::Relaxed), 9000usize.div_ceil(32));
    }

    #[test]
    fn semantic_synonym_passes_and_canonical_cache_is_reused() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend.clone());
        assert_eq!(grader.grade_reading(&entry(), "미래를 내다보다", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Pass);
        let first_calls = backend.calls.load(Ordering::Relaxed);
        assert_eq!(grader.grade_reading(&entry(), "미래를 내다보다", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Pass);
        assert_eq!(backend.calls.load(Ordering::Relaxed), first_calls);
    }

    #[test]
    fn unrelated_fails_and_confusable_negative_never_passes() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        assert_eq!(grader.grade_reading(&entry(), "쳐다보다", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Fail);
        assert_ne!(grader.grade_reading(&entry(), "과거만 보다", &[], &["과거를 보다".into()], "ko-KR", "ja-JP").decision, GradeDecision::Pass);
    }

    #[test]
    fn source_term_and_reading_context_only_escalates_uncertain_translation() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        let related = grader.grade_reading(&shelf_entry(), "찬장", &[], &["수납장".into()], "ko-KR", "ja-JP");
        assert_eq!(related.decision, GradeDecision::Ambiguous);
        assert_eq!(related.method, "semantic_negative");
        let nearby = grader.grade_reading(&shelf_entry(), "서랍장", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(nearby.decision, GradeDecision::Ambiguous);
        assert_eq!(nearby.method, "semantic_context_embedding");
        assert_eq!(grader.grade_reading(&shelf_entry(), "수납장", &[], &["수납장".into()], "ko-KR", "ja-JP").decision, GradeDecision::Fail);
        assert_eq!(grader.grade_reading(&shelf_entry(), "냉장고", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Fail);
    }

    #[test]
    fn independent_relation_verifier_rejects_high_similarity_contradiction() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let relation = Arc::new(FakeRelationBackend {
            evidence: RelationEvidence { entailment: 0.01, contradiction: 0.99 },
            calls: AtomicUsize::new(0),
        });
        let grader = grader_with_relation_thresholds(backend, relation.clone(), SemanticThresholds::default());
        let weather = EntryRecord {
            id: "weather".into(),
            term: "今日はいい天気ですね".into(),
            meanings: vec!["오늘은 좋은 날씨네요".into()],
            reading: Some("きょーわいいてんきですね".into()),
        };
        let outcome = grader.grade_reading(&weather, "오늘 날이 안좋네요", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Fail);
        assert_eq!(outcome.method, "semantic_contradiction");
        assert!(relation.calls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn context_similarity_never_grants_pass_by_itself() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let relation = Arc::new(FakeRelationBackend {
            evidence: RelationEvidence { entailment: 0.2, contradiction: 0.01 },
            calls: AtomicUsize::new(0),
        });
        let grader = grader_with_relation_thresholds(backend, relation.clone(), SemanticThresholds::default());
        let weather = EntryRecord {
            id: "weather".into(),
            term: "今日はいい天気ですね".into(),
            meanings: vec!["오늘은 좋은 날씨네요".into()],
            reading: Some("きょーわいいてんきですね".into()),
        };
        let outcome = grader.grade_reading(&weather, "오늘 날이 안좋네요", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_context_embedding");
        assert!(relation.calls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn context_with_independent_entailment_can_rescue_paraphrase() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let relation = Arc::new(FakeRelationBackend {
            evidence: RelationEvidence { entailment: 0.9, contradiction: 0.01 },
            calls: AtomicUsize::new(0),
        });
        let grader = grader_with_relation_thresholds(backend, relation.clone(), SemanticThresholds::default());
        let weather = EntryRecord {
            id: "weather".into(),
            term: "今日はいい天気ですね".into(),
            meanings: vec!["오늘은 좋은 날씨네요".into()],
            reading: Some("きょーわいいてんきですね".into()),
        };
        let outcome = grader.grade_reading(&weather, "오늘 날씨 좋네요", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Pass);
        assert_eq!(outcome.method, "semantic_consensus");
        assert!(relation.calls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn descriptive_relatedness_keeps_elaborated_translation_ambiguous() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let relation = Arc::new(FakeRelationBackend {
            evidence: RelationEvidence { entailment: 0.20, contradiction: 0.12 },
            calls: AtomicUsize::new(0),
        });
        let grader = grader_with_relation_thresholds(backend, relation.clone(), SemanticThresholds::default());
        let entry = EntryRecord {
            id: "sex".into(),
            term: "セックス".into(),
            meanings: vec!["섹스".into()],
            reading: None,
        };
        let outcome = grader.grade_reading(&entry, "자지를 보지에 박는다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_descriptive_related");
        assert!(relation.calls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn installed_pipeline_keeps_descriptive_translation_ambiguous() {
        let Ok(home) = std::env::var("TANREN_NLI_TEST_HOME") else { return; };
        let home = PathBuf::from(home);
        let embedding = LlamaCppEmbeddingBackend::install(home.clone());
        let relation = OnnxNliRelationBackend::install(home);
        let started = Instant::now();
        loop {
            let embedding_status = embedding.status();
            let relation_status = relation.status();
            if embedding_status.phase == "ready" && relation_status.phase == "ready" {
                break;
            }
            if embedding_status.phase == "unavailable" {
                panic!("semantic embedding backend failed to load: {:?}", embedding_status.error);
            }
            if relation_status.phase == "unavailable" {
                panic!("semantic relation backend failed to load: {:?}", relation_status.error);
            }
            if started.elapsed() > Duration::from_secs(60) {
                panic!("semantic runtime load timed out");
            }
            thread::sleep(Duration::from_millis(100));
        }

        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("semantic.db")).unwrap();
        let grader = SemanticGrader::new(embedding, relation, db, SemanticThresholds::default());
        let entry = EntryRecord {
            id: "sex".into(),
            term: "セックス".into(),
            meanings: vec!["섹스".into()],
            reading: None,
        };
        let outcome = grader.grade_reading(&entry, "자지를 보지에 박는다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_descriptive_related");
    }

    #[test]
    fn installed_pipeline_toru_multi_prompts_each_meaning() {
        let Ok(home) = std::env::var("TANREN_NLI_TEST_HOME") else { return; };
        let home = PathBuf::from(home);
        let embedding = LlamaCppEmbeddingBackend::install(home.clone());
        let relation = OnnxNliRelationBackend::install(home);
        let started = Instant::now();
        loop {
            let embedding_status = embedding.status();
            let relation_status = relation.status();
            if embedding_status.phase == "ready" && relation_status.phase == "ready" { break; }
            if embedding_status.phase == "unavailable" { panic!("embedding failed: {:?}", embedding_status.error); }
            if relation_status.phase == "unavailable" { panic!("relation failed: {:?}", relation_status.error); }
            if started.elapsed() > Duration::from_secs(60) { panic!("semantic runtime load timed out"); }
            thread::sleep(Duration::from_millis(100));
        }

        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().join("semantic.db")).unwrap();
        let grader = SemanticGrader::new(embedding, relation, db, SemanticThresholds::default());
        let entry = EntryRecord {
            id: "toru".into(), term: "とる".into(), meanings: vec!["가지다".into(), "들다".into()], reading: Some("とる".into()),
        };
        let (outcome, adjudications) = grader.grade_reading_with_adjudications(
            &entry, "가져오다 들어올리다", &[], &[], "ko-KR", "ja-JP",
        );
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(adjudications.len(), 2);
        assert!(adjudications.iter().any(|item| item.canonical_answer == "가지다" && item.submitted_answer == "가져오다"));
        assert!(adjudications.iter().any(|item| item.canonical_answer == "들다" && item.submitted_answer == "들어올리다"));
    }

    #[test]
    fn unavailable_backend_abstains() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: true });
        let grader = grader(backend);
        let outcome = grader.grade_reading(&entry(), "미래를 예측하다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_unavailable");
    }

    #[test]
    fn multiple_meanings_are_order_independent_one_to_one() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        let outcome = grader.grade_reading(&multi_entry(), "시간을 쓰다 / 매달다 / 전화하다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Pass);
        assert_eq!(outcome.method, "semantic_multi_consensus");
    }

    #[test]
    fn multiple_meanings_require_relation_consensus() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let relation = Arc::new(FakeRelationBackend {
            evidence: RelationEvidence { entailment: 0.01, contradiction: 0.99 },
            calls: AtomicUsize::new(0),
        });
        let grader = grader_with_relation(backend, relation.clone());
        let outcome = grader.grade_reading(&multi_entry(), "시간을 쓰다 / 매달다 / 전화하다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_multi_verifier");
        assert!(relation.calls.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn multiple_meanings_use_full_single_meaning_semantic_pipeline() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        let entry = EntryRecord {
            id: "weather-multi".into(),
            term: "今日はいい天気ですね".into(),
            meanings: vec!["오늘은 좋은 날씨네요".into(), "전화하다".into()],
            reading: Some("きょーわいいてんきですね".into()),
        };

        let outcome = grader.grade_reading(&entry, "오늘 날씨 좋네요 / 전화하다", &[], &[], "ko-KR", "ja-JP");
        assert_eq!(outcome.decision, GradeDecision::Pass);
        assert_eq!(outcome.method, "semantic_multi_consensus");
    }

    #[test]
    fn multiple_meanings_require_count_but_adjudicate_nonpassing_items() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        assert_eq!(grader.grade_reading(&multi_entry(), "매달다 / 전화하다", &[], &[], "ko-KR", "ja-JP").decision, GradeDecision::Fail);
        let (outcome, adjudications) = grader.grade_reading_with_adjudications(
            &multi_entry(), "매달다 / 전화하다 / 쳐다보다", &[], &[], "ko-KR", "ja-JP",
        );
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert!(!adjudications.is_empty());
    }

    #[test]
    fn overfilled_multiple_meanings_keep_partial_review_colors() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: true });
        let grader = grader(backend);
        let entry = EntryRecord {
            id: "toru".into(), term: "とる".into(), meanings: vec!["가지다".into(), "들다".into()], reading: Some("とる".into()),
        };
        let grades = grader.grade_overfilled_meanings(&entry, "가지다 들다 가져오다", "ko-KR", "ja-JP").unwrap();
        assert_eq!(grades.iter().map(|grade| grade.submitted_answer.as_str()).collect::<Vec<_>>(), vec!["가지다", "들다", "가져오다"]);
        assert_eq!(grades.iter().map(|grade| grade.correct).collect::<Vec<_>>(), vec![true, true, false]);

        let duplicate = grader.grade_overfilled_meanings(&entry, "가지다 들다 가지다", "ko-KR", "ja-JP").unwrap();
        assert_eq!(duplicate.iter().map(|grade| grade.correct).collect::<Vec<_>>(), vec![true, true, false]);
    }

    #[test]
    fn contextual_translation_text_uses_deck_languages() {
        let entry = EntryRecord { id: "en".into(), term: "shelf".into(), meanings: vec!["선반".into()], reading: None };
        assert_eq!(contextual_translation_text(&entry, "선반", "ko-KR", "en-US").unwrap(), "en-US 표현 shelf의 ko-KR 뜻: 선반");
        let entry = EntryRecord { id: "fr".into(), term: "étagère".into(), meanings: vec!["선반".into()], reading: None };
        assert_eq!(contextual_translation_text(&entry, "선반", "ko-KR", "fr-FR").unwrap(), "fr-FR 표현 étagère의 ko-KR 뜻: 선반");
    }
}
