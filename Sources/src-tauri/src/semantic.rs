use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

use serde::Serialize;

use crate::{
    db::Database,
    grading::{grade_recognition_deterministic, normalize_generic},
    model::{EntryRecord, GradeDecision, GradeOutcome},
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

#[derive(Debug, Clone, Copy)]
pub struct SemanticThresholds {
    pub pass: f64,
    pub fail: f64,
    pub minimum_margin: f64,
}

impl Default for SemanticThresholds {
    fn default() -> Self {
        Self { pass: 0.80, fail: 0.45, minimum_margin: 0.08 }
    }
}

impl SemanticThresholds {
    pub fn configured() -> Self {
        let defaults = Self::default();
        Self {
            pass: threshold_from_env("TANREN_SEMANTIC_PASS_THRESHOLD", defaults.pass),
            fail: threshold_from_env("TANREN_SEMANTIC_FAIL_THRESHOLD", defaults.fail),
            minimum_margin: threshold_from_env("TANREN_SEMANTIC_MINIMUM_MARGIN", defaults.minimum_margin),
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
    db: Database,
    thresholds: SemanticThresholds,
    memory_cache: Mutex<HashMap<CacheKey, Vec<f32>>>,
}

impl SemanticGrader {
    pub fn new(backend: Arc<dyn EmbeddingBackend>, db: Database, thresholds: SemanticThresholds) -> Self {
        Self { backend, db, thresholds, memory_cache: Mutex::new(HashMap::new()) }
    }

    pub fn status(&self) -> SemanticRuntimeStatus { self.backend.status() }

    pub fn grade_recognition(&self, entry: &EntryRecord, answer: &str, accepted: &[String], rejected: &[String]) -> GradeOutcome {
        if let Some(outcome) = grade_recognition_deterministic(entry, answer, accepted, rejected) {
            return outcome;
        }

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
        if best_negative.is_some_and(|negative| negative >= best_positive && negative >= self.thresholds.fail) {
            return GradeOutcome { decision: GradeDecision::Fail, method: "semantic_negative", score: Some(best_positive) };
        }
        if best_positive >= self.thresholds.pass && margin >= self.thresholds.minimum_margin {
            GradeOutcome { decision: GradeDecision::Pass, method: "semantic_embedding", score: Some(best_positive) }
        } else if best_positive <= self.thresholds.fail {
            GradeOutcome { decision: GradeDecision::Fail, method: "semantic_embedding", score: Some(best_positive) }
        } else {
            GradeOutcome { decision: GradeDecision::Ambiguous, method: "semantic_embedding", score: Some(best_positive) }
        }
    }

    pub fn precompute_documents(&self, texts: &[String]) -> Result<(), String> {
        let normalized = normalized_unique(texts.iter());
        self.document_embeddings(&normalized).map(|_| ())
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
                let encoded = if key.purpose == "query" { format!("{QUERY_INSTRUCTION}{}", key.normalized_text) } else { key.normalized_text.clone() };
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

fn contains_hangul(value: &str) -> bool { value.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)) }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    struct FakeBackend { calls: AtomicUsize, unavailable: bool }

    impl EmbeddingBackend for FakeBackend {
        fn identity(&self) -> BackendIdentity { BackendIdentity { model_id: "fake".into(), model_version: "1".into(), dimension: 3 } }
        fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.unavailable { return Err("offline".into()); }
            Ok(texts.iter().map(|text| {
                if text.contains("미래를 내다보다") || text == "내다보다" || text == "전망하다" { vec![1.0, 0.0, 0.0] }
                else if text.contains("쳐다보다") { vec![0.0, 1.0, 0.0] }
                else if text.contains("과거만 보다") { vec![0.8, 0.6, 0.0] }
                else { vec![0.0, 0.0, 1.0] }
            }).collect())
        }
        fn status(&self) -> SemanticRuntimeStatus { SemanticRuntimeStatus { phase: "ready".into(), model_id: "fake".into(), model_version: "1".into(), dimension: 3, backend: "fake".into(), gpu_requested: false, load_time_ms: Some(0), last_embedding_ms: Some(0), error: None } }
    }

    fn entry() -> EntryRecord { EntryRecord { id: "e".into(), term: "見据える".into(), meanings: vec!["내다보다".into(), "전망하다".into()], reading: None } }

    fn grader(backend: Arc<FakeBackend>) -> SemanticGrader {
        let dir = tempdir().unwrap().keep();
        let db = Database::open(dir.join("semantic.db")).unwrap();
        SemanticGrader::new(backend, db, SemanticThresholds { pass: 0.9, fail: 0.4, minimum_margin: 0.1 })
    }

    #[test]
    fn deterministic_alias_paths_never_call_model() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend.clone());
        assert_eq!(grader.grade_recognition(&entry(), "내다보다", &[], &[]).decision, GradeDecision::Pass);
        assert_eq!(grader.grade_recognition(&entry(), "앞날", &["앞날".into()], &[]).decision, GradeDecision::Pass);
        assert_eq!(grader.grade_recognition(&entry(), "과거", &[], &["과거".into()]).decision, GradeDecision::Fail);
        assert_eq!(backend.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn semantic_synonym_passes_and_canonical_cache_is_reused() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend.clone());
        assert_eq!(grader.grade_recognition(&entry(), "미래를 내다보다", &[], &[]).decision, GradeDecision::Pass);
        let first_calls = backend.calls.load(Ordering::Relaxed);
        assert_eq!(grader.grade_recognition(&entry(), "미래를 내다보다", &[], &[]).decision, GradeDecision::Pass);
        assert_eq!(backend.calls.load(Ordering::Relaxed), first_calls);
    }

    #[test]
    fn unrelated_fails_and_confusable_negative_never_passes() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: false });
        let grader = grader(backend);
        assert_eq!(grader.grade_recognition(&entry(), "쳐다보다", &[], &[]).decision, GradeDecision::Fail);
        assert_ne!(grader.grade_recognition(&entry(), "과거만 보다", &[], &["과거를 보다".into()]).decision, GradeDecision::Pass);
    }

    #[test]
    fn unavailable_backend_abstains() {
        let backend = Arc::new(FakeBackend { calls: AtomicUsize::new(0), unavailable: true });
        let grader = grader(backend);
        let outcome = grader.grade_recognition(&entry(), "미래를 예측하다", &[], &[]);
        assert_eq!(outcome.decision, GradeDecision::Ambiguous);
        assert_eq!(outcome.method, "semantic_unavailable");
    }
}
