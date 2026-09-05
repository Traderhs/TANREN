use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime},
};

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    },
};

const INSTALLER: &str = include_str!("../sidecar/install_voicevox.ps1");
const ENGINE_VERSION: &str = "0.25.2";
const REQUIRED_VOICE_MODELS: [&str; 7] = [
    "0.vvm", "4.vvm", "7.vvm", "12.vvm", "13.vvm", "15.vvm", "21.vvm",
];
const ENGINE_LIST_SIZE: u64 = 47;
const ENGINE_ARCHIVE_SIZE: u64 = 1_810_425_262;
const SEVEN_ZIP_SIZE: u64 = 602_112;
const VOICE_MODEL_SIZES: [(&str, u64); 7] = [
    ("0.vvm", 58_214_379),
    ("4.vvm", 58_211_265),
    ("7.vvm", 57_232_459),
    ("12.vvm", 58_213_390),
    ("13.vvm", 60_231_935),
    ("15.vvm", 65_647_574),
    ("21.vvm", 62_075_160),
];

struct RuntimeState {
    phase: String,
    port: Option<u16>,
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoicevoxRuntimeStatus {
    pub phase: String,
    pub download_progress: Option<u8>,
    pub engine_version: String,
    pub backend: String,
    pub error: Option<String>,
}

pub struct VoicevoxRuntime {
    home: PathBuf,
    state: Mutex<RuntimeState>,
}

impl VoicevoxRuntime {
    pub fn install(home: PathBuf) -> Arc<Self> {
        let runtime = Arc::new(Self {
            home,
            state: Mutex::new(RuntimeState {
                phase: "starting".into(),
                port: None,
                child: None,
                #[cfg(windows)]
                job: None,
                error: None,
            }),
        });
        let worker = Arc::clone(&runtime);
        thread::spawn(move || worker.prepare());
        runtime
    }

    fn prepare(&self) {
        if let Err(error) = self.prepare_inner() {
            if let Ok(mut state) = self.state.lock() {
                state.phase = "unavailable".into();
                state.error = Some(error);
            }
        }
    }

    fn prepare_inner(&self) -> Result<(), String> {
        fs::create_dir_all(&self.home).map_err(|e| e.to_string())?;
        let runtime_dir = self.home.join("runtime");
        let mut run = find_file(&runtime_dir, "run.exe");
        if voice_model_layout_needs_reconcile(run.as_deref()) {
            self.set_phase("downloading")?;
            let installer = self.home.join("install_voicevox.ps1");
            if fs::read_to_string(&installer).ok().as_deref() != Some(INSTALLER) {
                fs::write(&installer, INSTALLER).map_err(|e| e.to_string())?;
            }
            let logs = self.home.join("logs");
            fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
            let stdout = File::create(logs.join("installer.stdout.log")).map_err(|e| e.to_string())?;
            let stderr = File::create(logs.join("installer.stderr.log")).map_err(|e| e.to_string())?;
            let status = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&installer)
                .arg("-HomePath")
                .arg(&self.home)
                .stdin(Stdio::null())
                .stdout(stdout)
                .stderr(stderr)
                .status()
                .map_err(|e| format!("VOICEVOX installer could not start: {e}"))?;
            if !status.success() {
                return Err(format!("VOICEVOX installer failed with {status}; inspect voicevox/logs"));
            }
            run = find_file(&runtime_dir, "run.exe");
        }
        let run = run.ok_or("VOICEVOX run.exe is missing after installation")?;
        self.start_engine(&run)
    }

    fn start_engine(&self, run: &Path) -> Result<(), String> {
        self.set_phase("loading")?;
        let port = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
        let logs = self.home.join("logs");
        fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
        let stdout = File::create(logs.join("engine.stdout.log")).map_err(|e| e.to_string())?;
        let stderr = File::create(logs.join("engine.stderr.log")).map_err(|e| e.to_string())?;
        let mut command = Command::new(run);
        command
            .args(["--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .arg("--use_gpu")
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("VOICEVOX engine failed to start: {e}"))?;
        #[cfg(windows)]
        let job = match attach_kill_on_close_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        {
            let mut state = self.state.lock().map_err(|_| "VOICEVOX runtime lock poisoned")?;
            state.port = Some(port);
            state.child = Some(child);
            #[cfg(windows)]
            {
                state.job = Some(job);
            }
        }

        for _ in 0..300 {
            if http_get(port, "/version").is_ok() {
                let mut state = self.state.lock().map_err(|_| "VOICEVOX runtime lock poisoned")?;
                state.phase = "ready".into();
                state.error = None;
                return Ok(());
            }
            {
                let mut state = self.state.lock().map_err(|_| "VOICEVOX runtime lock poisoned")?;
                if state.child.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_some()) {
                    return Err("VOICEVOX engine exited while loading; inspect voicevox/logs".into());
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
        Err("VOICEVOX engine load timed out".into())
    }

    pub fn endpoint(&self) -> Result<String, String> {
        let state = self.state.lock().map_err(|_| "VOICEVOX runtime lock poisoned")?;
        if state.phase != "ready" {
            return Err(format!("VOICEVOX runtime is {}", state.phase));
        }
        Ok(format!("http://127.0.0.1:{}", state.port.ok_or("VOICEVOX port is unavailable")?))
    }

    pub fn phase(&self) -> String {
        self.state.lock().map(|state| state.phase.clone()).unwrap_or_else(|_| "unavailable".into())
    }

    pub fn status(&self) -> VoicevoxRuntimeStatus {
        let state = self.state.lock().ok();
        let phase = state.as_ref().map(|value| value.phase.clone()).unwrap_or_else(|| "unavailable".into());
        VoicevoxRuntimeStatus {
            download_progress: if phase == "downloading" { self.download_progress() } else { None },
            phase,
            engine_version: ENGINE_VERSION.into(),
            backend: "DirectML".into(),
            error: state.and_then(|value| value.error.clone()),
        }
    }

    fn set_phase(&self, phase: &str) -> Result<(), String> {
        self.state.lock().map_err(|_| "VOICEVOX runtime lock poisoned".to_string()).map(|mut state| state.phase = phase.into())
    }

    fn download_progress(&self) -> Option<u8> {
        let downloads = self.home.join("downloads");
        let mut assets = vec![
            (downloads.join("voicevox_engine-windows-directml-0.25.2.7z.txt"), ENGINE_LIST_SIZE),
            (downloads.join("voicevox_engine-windows-directml-0.25.2.7z.001"), ENGINE_ARCHIVE_SIZE),
            (downloads.join("7zr.exe"), SEVEN_ZIP_SIZE),
        ];
        if let Some(run) = find_file(&self.home.join("runtime"), "run.exe") {
            if let Some(parent) = run.parent() {
                let model_dir = parent.join("model");
                assets.extend(VOICE_MODEL_SIZES.iter().map(|(name, size)| (model_dir.join(name), *size)));
            }
        }
        latest_partial_progress(&assets)
    }
}

impl Drop for VoicevoxRuntime {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(child) = state.child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(windows)]
fn attach_kill_on_close_job(child: &Child) -> Result<OwnedHandle, String> {
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|error| format!("VOICEVOX job object creation failed: {error}"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!("VOICEVOX job object setup failed: {error}"));
        }
        if let Err(error) = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(format!("VOICEVOX process could not join TANREN job object: {error}"));
        }
        Ok(OwnedHandle::from_raw_handle(job.0))
    }
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
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

fn latest_partial_progress(assets: &[(PathBuf, u64)]) -> Option<u8> {
    let mut latest: Option<(SystemTime, u64, u64)> = None;
    for (path, total) in assets {
        let mut partial_name = path.as_os_str().to_os_string();
        partial_name.push(".partial");
        let partial = PathBuf::from(partial_name);
        let Ok(metadata) = fs::metadata(partial) else { continue; };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if latest.as_ref().map_or(true, |(current, _, _)| modified >= *current) {
            latest = Some((modified, metadata.len(), *total));
        }
    }
    latest.map(|(_, downloaded, total)| ((downloaded.min(total) * 100) / total.max(1)) as u8)
}

fn voice_model_layout_needs_reconcile(run: Option<&Path>) -> bool {
    let Some(model_dir) = run.and_then(Path::parent).map(|parent| parent.join("model")) else {
        return true;
    };
    let Ok(entries) = fs::read_dir(model_dir) else {
        return true;
    };
    let mut installed = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("vvm")))
                .then(|| path.file_name()?.to_str().map(str::to_owned))
                .flatten()
        })
        .collect::<Vec<_>>();
    installed.sort_unstable();

    let mut required = REQUIRED_VOICE_MODELS.map(str::to_owned).to_vec();
    required.sort_unstable();
    installed != required
}

fn http_get(port: u16, path: &str) -> Result<Vec<u8>, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(|e| format!("invalid VOICEVOX address: {e}"))?,
        Duration::from_secs(2),
    ).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    let split = response.windows(4).position(|value| value == b"\r\n\r\n").ok_or("invalid VOICEVOX HTTP response")?;
    let status = String::from_utf8_lossy(&response[..split]);
    if !status.lines().next().unwrap_or_default().contains(" 200 ") {
        return Err(format!("VOICEVOX returned {}", status.lines().next().unwrap_or_default()));
    }
    Ok(response[split + 4..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::{voice_model_layout_needs_reconcile, REQUIRED_VOICE_MODELS};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn voicevox_reconciles_to_only_tanren_models() {
        let temp = tempdir().unwrap();
        let runtime = temp.path().join("windows-directml");
        let model = runtime.join("model");
        fs::create_dir_all(&model).unwrap();
        fs::write(runtime.join("run.exe"), []).unwrap();
        for name in REQUIRED_VOICE_MODELS {
            fs::write(model.join(name), []).unwrap();
        }

        let run = runtime.join("run.exe");
        assert!(!voice_model_layout_needs_reconcile(Some(&run)));

        fs::write(model.join("1.vvm"), []).unwrap();
        assert!(voice_model_layout_needs_reconcile(Some(&run)));
    }
}
