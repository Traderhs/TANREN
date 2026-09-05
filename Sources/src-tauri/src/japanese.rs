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
        let bundled = app.shell().sidecar("tanren-language");
        if let Ok(command) = bundled {
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
        })
    }

    pub fn audio_runtime_phase(&self) -> String { self.voicevox.phase() }

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
        let response = self.request_sidecar(&serde_json::json!({ "op": "warm" }))?;
        if response.get("warm").and_then(serde_json::Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err("language sidecar warm-up returned an invalid response".into())
        }
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
        if enrichment.scope == "lexical" {
            if audio.is_empty() {
                return Err(format!("lexical enrichment completed without generated audio: {}", entry.term));
            }
        }
        Ok((enrichment, audio))
    }
}
