use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::{
    model::{AudioAssetDraft, EntryRecord},
    voicevox::VoicevoxRuntime,
};

const SIDECAR_SOURCE: &str = include_str!("../sidecar/japanese_sidecar.py");

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
        Ok(Self { app, script_path, audio_dir, voicevox })
    }

    pub fn audio_runtime_phase(&self) -> String { self.voicevox.phase() }

    pub fn analyze(&self, entry: &EntryRecord) -> Result<(JapaneseEnrichment, Vec<AudioAssetDraft>), String> {
        let audio_dir = self.audio_dir.join(&entry.id);
        let voicevox_url = self.voicevox.endpoint()?;
        let request = serde_json::json!({
            "text": entry.term,
            "reading_hint": entry.reading,
            "audio_dir": audio_dir,
            "voicevox_url": voicevox_url,
        });

        let bundled = self.app.shell().sidecar("tanren-language")
            .map_err(|e| format!("bundled language sidecar unavailable: {e}"));
        if let Ok(command) = bundled {
            let request_arg = request.to_string();
            let output = tauri::async_runtime::block_on(async move {
                command.arg(request_arg).output().await
            }).map_err(|e| format!("bundled language sidecar failed: {e}"))?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            let enrichment: JapaneseEnrichment = serde_json::from_slice(&output.stdout)
                .map_err(|e| format!("invalid bundled sidecar response: {e}; stdout={}", String::from_utf8_lossy(&output.stdout)))?;
            let audio = enrichment.audio_assets.iter().filter(|asset| Path::new(&asset.path).exists()).cloned().collect();
            return Ok((enrichment, audio));
        }

        // Developer fallback only. Packaged builds should always use the bundled sidecar.
        let mut child = Command::new("python")
            .arg(&self.script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Python sidecar unavailable: {e}"))?;
        child.stdin.as_mut().ok_or("sidecar stdin unavailable")?.write_all(request.to_string().as_bytes()).map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let enrichment: JapaneseEnrichment = serde_json::from_slice(&output.stdout).map_err(|e| format!("invalid sidecar response: {e}"))?;
        let audio = enrichment.audio_assets.iter().filter(|asset| Path::new(&asset.path).exists()).cloned().collect();
        Ok((enrichment, audio))
    }
}
