use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime::Receiver, AppHandle};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

use crate::{
    model::{AudioAssetDraft, EntryRecord},
    voicevox::VoicevoxRuntime,
};

const SIDECAR_SOURCE: &str = include_str!("../sidecar/japanese_sidecar.py");
pub const VOICE_AUDIO_REVISION: &str = "v8";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JapaneseEnrichment {
    pub normalized_text: String,
    pub reading: Option<String>,
    pub scope: String,
    pub morae: Vec<String>,
    pub tokens: Vec<serde_json::Value>,
    pub pitch_patterns: Option<Vec<Vec<u8>>>,
    pub accent_types: Option<Vec<usize>>,
    pub downstep_after_mora: Option<Vec<Option<usize>>>,
    pub provider: String,
    pub source: String,
    pub confidence: String,
    pub model_version: Option<String>,
    pub audio_written: bool,
    pub audio_assets: Vec<AudioAssetDraft>,
}

impl JapaneseEnrichment {
    pub fn analysis_json(&self) -> serde_json::Value {
        serde_json::json!({
            "normalized_text": self.normalized_text,
            "reading": self.reading,
            "scope": self.scope,
            "morae": self.morae,
            "tokens": self.tokens,
            "accent_types": self.accent_types,
            "downstep_after_mora": self.downstep_after_mora,
        })
    }
}

#[derive(Clone)]
pub struct JapaneseAnalyzer {
    app: AppHandle,
    script_path: PathBuf,
    audio_dir: PathBuf,
    voicevox: Arc<VoicevoxRuntime>,
    sidecar: Arc<Mutex<LanguageSidecar>>,
    runtime_phase: Arc<Mutex<String>>,
}

struct LanguageSidecar {
    process: Option<LanguageSidecarProcess>,
}

struct LanguageSidecarProcess {
    child: CommandChild,
    events: Receiver<CommandEvent>,
}

impl LanguageSidecarProcess {
    fn request(&mut self, payload: &[u8]) -> Result<Vec<u8>, String> {
        self.child
            .write(payload)
            .map_err(|error| format!("language sidecar stdin failed: {error}"))?;
        loop {
            let event = tauri::async_runtime::block_on(self.events.recv())
                .ok_or_else(|| "language sidecar event stream closed".to_string())?;
            match event {
                CommandEvent::Stdout(line) => return Ok(line),
                CommandEvent::Stderr(line) => {
                    let message = String::from_utf8_lossy(&line);
                    if !message.trim().is_empty() {
                        eprintln!("TANREN language sidecar: {}", message.trim());
                    }
                }
                CommandEvent::Error(error) => {
                    return Err(format!("language sidecar process error: {error}"));
                }
                CommandEvent::Terminated(status) => {
                    return Err(format!(
                        "language sidecar terminated unexpectedly (code={:?})",
                        status.code
                    ));
                }
                _ => {}
            }
        }
    }
}

impl LanguageSidecar {
    fn new() -> Self {
        Self { process: None }
    }

    fn stop(&mut self) {
        if let Some(process) = self.process.take() {
            let _ = process.child.kill();
        }
    }

    fn spawn(app: &AppHandle, script_path: &Path) -> Result<LanguageSidecarProcess, String> {
        #[cfg(debug_assertions)]
        {
            let (python, dictionary) = debug_sidecar_runtime()?;
            let (events, child) = app
                .shell()
                .command(python)
                .arg("-u")
                .arg(script_path)
                .env("TANREN_UNIDIC_DIR", dictionary)
                .spawn()
                .map_err(|error| format!("development language sidecar could not start: {error}"))?;
            return Ok(LanguageSidecarProcess { child, events });
        }

        #[cfg(not(debug_assertions))]
        {
            let runtime_temp = bundled_sidecar_temp();
            if let Ok(command) = app.shell().sidecar("tanren-language") {
                let command = command
                    .env("TEMP", &runtime_temp)
                    .env("TMP", &runtime_temp)
                    .env("TMPDIR", &runtime_temp);
                if let Ok((events, child)) = command.spawn() {
                    return Ok(LanguageSidecarProcess { child, events });
                }
            }

            let (events, child) = app
                .shell()
                .command("python")
                .arg("-u")
                .arg(script_path)
                .spawn()
                .map_err(|error| format!("language sidecar could not start: {error}"))?;
            Ok(LanguageSidecarProcess { child, events })
        }
    }

    fn request(&mut self, app: &AppHandle, script_path: &Path, request: &serde_json::Value) -> Result<Vec<u8>, String> {
        let mut payload = serde_json::to_vec(request).map_err(|error| error.to_string())?;
        payload.push(b'\n');

        let mut last_error = None;
        for _ in 0..2 {
            if self.process.is_none() {
                self.process = Some(Self::spawn(app, script_path)?);
            }
            let result = self.process.as_mut().expect("sidecar process exists").request(&payload);
            match result {
                Ok(stdout) => return Ok(stdout),
                Err(error) => {
                    last_error = Some(error);
                    self.stop();
                }
            }
        }
        Err(last_error.unwrap_or_else(|| "language sidecar request failed".into()))
    }
}

#[cfg(not(debug_assertions))]
fn bundled_sidecar_temp() -> PathBuf {
    let root = std::env::temp_dir().join("tanren-language-sidecar");
    let _ = fs::create_dir_all(&root);
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("_MEI") {
                let _ = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
            }
        }
    }
    root
}

#[cfg(debug_assertions)]
fn debug_sidecar_runtime() -> Result<(PathBuf, PathBuf), String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or("development TANREN root could not be resolved")?;
    let python = root
        .join("Results")
        .join("python-sidecar-env")
        .join("Scripts")
        .join("python.exe");
    let dictionary = root.join("Results").join("sidecar").join("tanren-unidic");
    if !python.is_file() {
        return Err(format!(
            "development language sidecar Python is missing: {}",
            python.display()
        ));
    }
    if !dictionary.join("sys.dic").is_file() {
        return Err(format!(
            "development UniDic is missing: {}",
            dictionary.display()
        ));
    }
    Ok((python, dictionary))
}


impl JapaneseAnalyzer {
    pub fn install(app: AppHandle, app_data: &Path, audio_dir: PathBuf, voicevox: Arc<VoicevoxRuntime>) -> Result<Self, String> {
        let runtime_dir = app_data.join("runtime");
        fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&audio_dir).map_err(|e| e.to_string())?;
        let script_path = runtime_dir.join("japanese_sidecar.py");
        if fs::read_to_string(&script_path).ok().as_deref() != Some(SIDECAR_SOURCE) {
            fs::write(&script_path, SIDECAR_SOURCE).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            app,
            script_path,
            audio_dir,
            voicevox,
            sidecar: Arc::new(Mutex::new(LanguageSidecar::new())),
            runtime_phase: Arc::new(Mutex::new("starting".into())),
        })
    }

    pub fn audio_runtime_phase(&self) -> String { self.voicevox.phase() }
    pub fn runtime_phase(&self) -> String {
        self.runtime_phase.lock().map(|phase| phase.clone()).unwrap_or_else(|_| "unavailable".into())
    }

    pub fn invalidate_audio(&self, entry_id: &str) -> Result<(), String> {
        let entry_audio_dir = self.audio_dir.join(entry_id);
        if !entry_audio_dir.exists() {
            return Ok(());
        }
        fs::remove_dir_all(&entry_audio_dir)
            .map_err(|error| format!("기존 음성을 삭제하지 못했어요: {error}"))
    }

    fn request_sidecar(&self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let stdout = self
            .sidecar
            .lock()
            .map_err(|_| "language sidecar lock poisoned".to_string())?
            .request(&self.app, &self.script_path, request)?;
        let response: serde_json::Value = serde_json::from_slice(&stdout).map_err(|error| {
            format!(
                "invalid language sidecar response: {error}; stdout={}",
                String::from_utf8_lossy(&stdout)
            )
        })?;
        if let Some(error) = response.get("error").and_then(serde_json::Value::as_str) {
            return Err(error.to_string());
        }
        Ok(response)
    }

    pub fn warm(&self) -> Result<(), String> {
        if let Ok(mut phase) = self.runtime_phase.lock() { *phase = "loading".into(); }
        let result = self.request_sidecar(&serde_json::json!({ "op": "warm" })).and_then(|response| {
            if response.get("warm").and_then(serde_json::Value::as_bool) == Some(true) {
                Ok(())
            } else {
                Err("language sidecar warm-up returned an invalid response".into())
            }
        });
        if let Ok(mut phase) = self.runtime_phase.lock() {
            *phase = if result.is_ok() { "ready".into() } else { "unavailable".into() };
        }
        result
    }

    pub fn warm_audio(&self) -> Result<(), String> {
        let voicevox_url = self.voicevox.endpoint()?;
        let response = self.request_sidecar(&serde_json::json!({
            "op": "warm",
            "voicevox_url": voicevox_url,
        }))?;
        let profile_count = response
            .get("voicevox_profiles")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if profile_count > 0 {
            Ok(())
        } else {
            Err("VOICEVOX warm-up did not initialize any TANREN voice profiles".into())
        }
    }

    pub fn analyze(&self, entry: &EntryRecord) -> Result<(JapaneseEnrichment, Vec<AudioAssetDraft>), String> {
        let audio_dir = self.audio_dir.join(&entry.id);
        let voicevox_url = self.voicevox.endpoint()?;
        let request = serde_json::json!({
            "text": entry.term,
            "reading_hint": entry.reading,
            "audio_dir": audio_dir,
            "voicevox_url": voicevox_url,
        });

        let response = self.request_sidecar(&request)?;
        let enrichment: JapaneseEnrichment = serde_json::from_value(response)
            .map_err(|error| format!("invalid language enrichment payload: {error}"))?;
        let audio: Vec<AudioAssetDraft> = enrichment.audio_assets.iter().filter(|asset| Path::new(&asset.path).exists()).cloned().collect();
        if matches!(enrichment.scope.as_str(), "lexical" | "phrase" | "sentence") {
            if enrichment.pitch_patterns.as_ref().is_none_or(|patterns| patterns.is_empty()) {
                return Err(format!("Japanese enrichment completed without generated pitch: {}", entry.term));
            }
            if audio.is_empty() {
                return Err(format!("Japanese enrichment completed without generated audio: {}", entry.term));
            }
        }
        Ok((enrichment, audio))
    }
}
