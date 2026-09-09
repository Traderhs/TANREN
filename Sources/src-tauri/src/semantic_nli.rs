use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use ort::{session::Session, value::Tensor};
use tokenizers::Tokenizer;

use crate::semantic::{RelationEvidence, RelationRuntimeStatus, SemanticRelationBackend};

pub const NLI_MODEL_FILE: &str = "mDeBERTa-v3-base-mnli-xnli-model_quantized.onnx";
pub const NLI_TOKENIZER_FILE: &str = "mDeBERTa-v3-base-mnli-xnli-tokenizer.json";
pub const ONNX_RUNTIME_ZIP: &str = "onnxruntime-win-x64-1.28.0.zip";

struct NliModel {
    tokenizer: Tokenizer,
    session: Session,
}

enum RuntimeState {
    Starting,
    Loading(u8),
    Ready(NliModel),
    Unavailable(String),
}

pub struct OnnxNliRelationBackend {
    home: PathBuf,
    state: Mutex<RuntimeState>,
    cache: Mutex<HashMap<(String, String), RelationEvidence>>,
}

impl OnnxNliRelationBackend {
    pub fn install(home: PathBuf) -> Arc<Self> {
        let backend = Arc::new(Self {
            home,
            state: Mutex::new(RuntimeState::Starting),
            cache: Mutex::new(HashMap::new()),
        });
        let worker = Arc::clone(&backend);
        thread::spawn(move || worker.prepare());
        backend
    }

    fn prepare(&self) {
        if let Err(error) = self.prepare_inner() {
            if let Ok(mut state) = self.state.lock() {
                *state = RuntimeState::Unavailable(error);
            }
        }
    }

    fn prepare_inner(&self) -> Result<(), String> {
        let model_path = self.home.join("models").join(NLI_MODEL_FILE);
        let tokenizer_path = self.home.join("models").join(NLI_TOKENIZER_FILE);

        for _ in 0..3600 {
            if model_path.exists() && tokenizer_path.exists() {
                if let Some(runtime_path) = find_file(&self.home.join("runtime"), "onnxruntime.dll") {
                    self.set_loading(20)?;
                    ort::init_from(&runtime_path)
                        .map_err(|error| format!("ONNX Runtime could not load: {error}"))?
                        .commit();
                    self.set_loading(45)?;
                    let tokenizer = Tokenizer::from_file(&tokenizer_path)
                        .map_err(|error| format!("semantic verifier tokenizer could not load: {error}"))?;
                    self.set_loading(65)?;
                    let session = Session::builder()
                        .map_err(|error| format!("semantic verifier session could not initialize: {error}"))?
                        .commit_from_file(&model_path)
                        .map_err(|error| format!("semantic verifier model could not load: {error}"))?;
                    self.set_loading(95)?;
                    let mut state = self.state.lock().map_err(|_| "semantic verifier runtime lock poisoned")?;
                    *state = RuntimeState::Ready(NliModel { tokenizer, session });
                    return Ok(());
                }
            }
            thread::sleep(Duration::from_millis(100));
        }

        Err("semantic verifier assets did not become available".into())
    }

    fn set_loading(&self, progress: u8) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "semantic verifier runtime lock poisoned")?;
        *state = RuntimeState::Loading(progress);
        Ok(())
    }

    fn infer_missing(&self, pairs: &[(String, String)]) -> Result<Vec<RelationEvidence>, String> {
        if pairs.is_empty() {
            return Ok(Vec::new());
        }

        let mut state = self.state.lock().map_err(|_| "semantic verifier runtime lock poisoned")?;
        let RuntimeState::Ready(model) = &mut *state else {
            return Err("semantic verifier is not ready".into());
        };

        let encodings = pairs
            .iter()
            .map(|(premise, hypothesis)| {
                model
                    .tokenizer
                    .encode((premise.as_str(), hypothesis.as_str()), true)
                    .map_err(|error| format!("semantic verifier tokenization failed: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let width = encodings.iter().map(|encoding| encoding.len()).max().unwrap_or(0);
        if width == 0 {
            return Err("semantic verifier produced an empty input".into());
        }

        let batch = encodings.len();
        let mut input_ids = vec![0_i64; batch * width];
        let mut attention_mask = vec![0_i64; batch * width];
        for (row, encoding) in encodings.iter().enumerate() {
            for (column, &id) in encoding.get_ids().iter().enumerate() {
                input_ids[row * width + column] = id as i64;
                attention_mask[row * width + column] = 1;
            }
        }

        let inputs = ort::inputs![
            Tensor::from_array(([batch, width], input_ids))
                .map_err(|error| format!("semantic verifier input tensor failed: {error}"))?,
            Tensor::from_array(([batch, width], attention_mask))
                .map_err(|error| format!("semantic verifier attention tensor failed: {error}"))?,
        ];
        let outputs = model
            .session
            .run(inputs)
            .map_err(|error| format!("semantic verifier inference failed: {error}"))?;
        let (shape, logits) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("semantic verifier output failed: {error}"))?;
        if shape.as_ref() != [batch as i64, 3] || logits.len() != batch * 3 {
            return Err(format!("semantic verifier output shape mismatch: {shape:?}"));
        }

        let mut evidence = Vec::with_capacity(batch);
        for row in logits.chunks_exact(3) {
            let maximum = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let weights = [
                (row[0] - maximum).exp(),
                (row[1] - maximum).exp(),
                (row[2] - maximum).exp(),
            ];
            let total = weights.iter().sum::<f32>();
            if !total.is_finite() || total <= f32::EPSILON {
                return Err("semantic verifier produced invalid probabilities".into());
            }
            evidence.push(RelationEvidence {
                entailment: (weights[0] / total) as f64,
                contradiction: (weights[2] / total) as f64,
            });
        }
        Ok(evidence)
    }
}

impl SemanticRelationBackend for OnnxNliRelationBackend {
    fn relations(&self, pairs: &[(String, String)]) -> Result<Vec<RelationEvidence>, String> {
        let mut resolved = vec![None; pairs.len()];
        let mut missing_pairs = Vec::new();
        let mut missing_indices = Vec::new();
        {
            let cache = self.cache.lock().map_err(|_| "semantic verifier cache lock poisoned")?;
            for (index, pair) in pairs.iter().enumerate() {
                if let Some(value) = cache.get(pair) {
                    resolved[index] = Some(*value);
                } else {
                    missing_indices.push(index);
                    missing_pairs.push(pair.clone());
                }
            }
        }

        if !missing_pairs.is_empty() {
            let inferred = self.infer_missing(&missing_pairs)?;
            if inferred.len() != missing_pairs.len() {
                return Err("semantic verifier response count mismatch".into());
            }
            let mut cache = self.cache.lock().map_err(|_| "semantic verifier cache lock poisoned")?;
            for ((index, pair), value) in missing_indices.into_iter().zip(missing_pairs).zip(inferred) {
                cache.insert(pair, value);
                resolved[index] = Some(value);
            }
        }

        resolved.into_iter().collect::<Option<Vec<_>>>().ok_or_else(|| "semantic verifier cache resolution failed".into())
    }

    fn status(&self) -> RelationRuntimeStatus {
        match self.state.lock() {
            Ok(state) => match &*state {
                RuntimeState::Starting => RelationRuntimeStatus { phase: "starting".into(), load_progress: None, error: None },
                RuntimeState::Loading(progress) => RelationRuntimeStatus { phase: "loading".into(), load_progress: Some(*progress), error: None },
                RuntimeState::Ready(_) => RelationRuntimeStatus { phase: "ready".into(), load_progress: Some(100), error: None },
                RuntimeState::Unavailable(error) => RelationRuntimeStatus { phase: "unavailable".into(), load_progress: None, error: Some(error.clone()) },
            },
            Err(_) => RelationRuntimeStatus { phase: "unavailable".into(), load_progress: None, error: Some("semantic verifier runtime lock poisoned".into()) },
        }
    }
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().is_some_and(|value| value.eq_ignore_ascii_case(name)) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn installed_model_separates_equivalence_from_contradiction() {
        let Ok(home) = std::env::var("TANREN_NLI_TEST_HOME") else { return; };
        let backend = OnnxNliRelationBackend::install(PathBuf::from(home));
        let started = Instant::now();
        loop {
            match backend.status().phase.as_str() {
                "ready" => break,
                "unavailable" => panic!("semantic verifier failed to load: {:?}", backend.status().error),
                _ if started.elapsed() > Duration::from_secs(30) => panic!("semantic verifier load timed out"),
                _ => thread::sleep(Duration::from_millis(50)),
            }
        }

        let pairs = vec![
            (
                "The translation of source expression \"今日はいい天気ですね\" is \"오늘은 좋은 날씨네요\".".to_string(),
                "The translation of source expression \"今日はいい天気ですね\" is \"오늘 날씨가 좋네요\".".to_string(),
            ),
            (
                "The translation of source expression \"今日はいい天気ですね\" is \"오늘은 좋은 날씨네요\".".to_string(),
                "The translation of source expression \"今日はいい天気ですね\" is \"오늘 날이 안좋네요\".".to_string(),
            ),
            (
                "The translation of source expression \"セックス\" is \"섹스\".".to_string(),
                "The translation of source expression \"セックス\" is \"자지를 보지에 박는다\".".to_string(),
            ),
            (
                "The translation of source expression \"セックス\" is \"자지를 보지에 박는다\".".to_string(),
                "The translation of source expression \"セックス\" is \"섹스\".".to_string(),
            ),
        ];
        let evidence = backend.relations(&pairs).unwrap();
        assert!(evidence[0].entailment > 0.80);
        assert!(evidence[0].contradiction < 0.05);
        assert!(evidence[1].contradiction > 0.90);
        assert!(evidence[2].contradiction < 0.50);
        assert!(evidence[3].contradiction < 0.50);
    }
}
