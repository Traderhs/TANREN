use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::semantic::{BackendIdentity, EmbeddingBackend, SemanticRuntimeStatus};

const INSTALLER: &str = include_str!("../sidecar/install_semantic.ps1");
const MODEL_ID: &str = "Qwen/Qwen3-Embedding-8B-GGUF";
const MODEL_VERSION: &str = "Q4_K_M:90f57aa:llama.cpp-b10621";
const MODEL_FILE: &str = "Qwen3-Embedding-8B-Q4_K_M.gguf";
const DIMENSION: usize = 4096;

struct RuntimeState {
    phase: String,
    port: Option<u16>,
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<usize>,
    load_time_ms: Option<u64>,
    last_embedding_ms: Option<u64>,
    error: Option<String>,
}

pub struct LlamaCppEmbeddingBackend {
    home: PathBuf,
    state: Mutex<RuntimeState>,
}

impl LlamaCppEmbeddingBackend {
    pub fn install(home: PathBuf) -> Arc<Self> {
        let backend = Arc::new(Self {
            home,
            state: Mutex::new(RuntimeState { phase: "starting".into(), port: None, child: None, #[cfg(windows)] job: None, load_time_ms: None, last_embedding_ms: None, error: None }),
        });
        let worker = Arc::clone(&backend);
        thread::spawn(move || worker.prepare());
        backend
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
        let model_path = self.home.join("models").join(MODEL_FILE);
        let server_path = find_file(&self.home.join("runtime"), "llama-server.exe");
        if !model_path.exists() || server_path.is_none() {
            self.set_phase("downloading")?;
            let installer_path = self.home.join("install_semantic.ps1");
            if fs::read_to_string(&installer_path).ok().as_deref() != Some(INSTALLER) {
                fs::write(&installer_path, INSTALLER).map_err(|e| e.to_string())?;
            }
            let status = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&installer_path)
                .arg("-HomePath")
                .arg(&self.home)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| format!("semantic installer could not start: {e}"))?;
            if !status.success() { return Err(format!("semantic installer failed with {status}")); }
        }

        let server_path = find_file(&self.home.join("runtime"), "llama-server.exe").ok_or("llama-server.exe is missing after installation")?;
        if !model_path.exists() { return Err("Qwen3 embedding model is missing after installation".into()); }
        self.start_server(&server_path, &model_path)
    }

    fn start_server(&self, server_path: &Path, model_path: &Path) -> Result<(), String> {
        self.set_phase("loading")?;
        let port = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
        let logs = self.home.join("logs");
        fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
        let stdout = File::create(logs.join("llama-server.stdout.log")).map_err(|e| e.to_string())?;
        let stderr = File::create(logs.join("llama-server.stderr.log")).map_err(|e| e.to_string())?;
        let started = Instant::now();
        let mut command = Command::new(server_path);
        command
            .arg("--model").arg(model_path)
            .args(["--embedding", "--pooling", "last", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .args(["--ctx-size", "1024", "--batch-size", "256", "--ubatch-size", "256", "--parallel", "1", "--n-gpu-layers", "auto"])
            .stdin(Stdio::null()).stdout(stdout).stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("llama-server failed to start: {e}"))?;
        #[cfg(windows)]
        let job = match assign_kill_on_close_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("llama-server lifecycle guard failed: {error}"));
            }
        };
        {
            let mut state = self.state.lock().map_err(|_| "semantic runtime lock poisoned")?;
            state.port = Some(port);
            state.child = Some(child);
            #[cfg(windows)]
            { state.job = Some(job); }
        }

        for _ in 0..300 {
            if http_get(port, "/health").is_ok() {
                let mut state = self.state.lock().map_err(|_| "semantic runtime lock poisoned")?;
                state.phase = "ready".into();
                state.load_time_ms = Some(started.elapsed().as_millis() as u64);
                state.error = None;
                return Ok(());
            }
            {
                let mut state = self.state.lock().map_err(|_| "semantic runtime lock poisoned")?;
                if state.child.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_some()) {
                    return Err("llama-server exited while loading; inspect semantic logs".into());
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
        Err("llama-server model load timed out".into())
    }

    fn set_phase(&self, phase: &str) -> Result<(), String> {
        self.state.lock().map_err(|_| "semantic runtime lock poisoned".to_string()).map(|mut state| state.phase = phase.into())
    }
}

impl EmbeddingBackend for LlamaCppEmbeddingBackend {
    fn identity(&self) -> BackendIdentity {
        BackendIdentity { model_id: MODEL_ID.into(), model_version: MODEL_VERSION.into(), dimension: DIMENSION }
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let port = {
            let state = self.state.lock().map_err(|_| "semantic runtime lock poisoned")?;
            if state.phase != "ready" { return Err(format!("semantic backend is {}", state.phase)); }
            state.port.ok_or("semantic server port is unavailable")?
        };
        let started = Instant::now();
        let body = serde_json::json!({ "model": MODEL_ID, "input": texts, "encoding_format": "float" }).to_string();
        let response = http_post(port, "/v1/embeddings", &body)?;
        let mut response: EmbeddingResponse = serde_json::from_slice(&response).map_err(|e| format!("invalid embedding response: {e}"))?;
        response.data.sort_by_key(|item| item.index);
        let values = response.data.into_iter().map(|item| item.embedding).collect();
        if let Ok(mut state) = self.state.lock() { state.last_embedding_ms = Some(started.elapsed().as_millis() as u64); }
        Ok(values)
    }

    fn status(&self) -> SemanticRuntimeStatus {
        let state = self.state.lock().ok();
        SemanticRuntimeStatus {
            phase: state.as_ref().map(|value| value.phase.clone()).unwrap_or_else(|| "unavailable".into()),
            model_id: MODEL_ID.into(),
            model_version: MODEL_VERSION.into(),
            dimension: DIMENSION,
            backend: "llama.cpp CUDA 12.4".into(),
            gpu_requested: true,
            load_time_ms: state.as_ref().and_then(|value| value.load_time_ms),
            last_embedding_ms: state.as_ref().and_then(|value| value.last_embedding_ms),
            error: state.and_then(|value| value.error.clone()),
        }
    }
}

impl Drop for LlamaCppEmbeddingBackend {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(child) = state.child.as_mut() { let _ = child.kill(); }
            #[cfg(windows)]
            if let Some(job) = state.job.take() {
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(job as *mut core::ffi::c_void)) };
            }
        }
    }
}

#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> Result<usize, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    }};

    let job = unsafe { CreateJobObjectW(None, None) }.map_err(|e| e.to_string())?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if let Err(error) = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&limits) as u32,
        )
    } {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(job) };
        return Err(error.to_string());
    }
    if let Err(error) = unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) } {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(job) };
        return Err(error.to_string());
    }
    Ok(job.0 as usize)
}

#[derive(Deserialize)]
struct EmbeddingResponse { data: Vec<EmbeddingItem> }

#[derive(Deserialize)]
struct EmbeddingItem { index: usize, embedding: Vec<f32> }

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().is_some_and(|value| value.eq_ignore_ascii_case(name)) { return Some(path); }
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) { return Some(found); }
        }
    }
    None
}

fn http_get(port: u16, path: &str) -> Result<Vec<u8>, String> {
    http_request(port, format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())
}

fn http_post(port: u16, path: &str, body: &str) -> Result<Vec<u8>, String> {
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    http_request(port, request.as_bytes())
}

fn http_request(port: u16, request: &[u8]) -> Result<Vec<u8>, String> {
    let mut stream = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().map_err(|e| format!("invalid semantic server address: {e}"))?, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(120))).map_err(|e| e.to_string())?;
    stream.write_all(request).map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    let split = response.windows(4).position(|value| value == b"\r\n\r\n").ok_or("invalid HTTP response")?;
    let headers = String::from_utf8_lossy(&response[..split]);
    let status = headers.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") { return Err(format!("semantic server returned {status}")); }
    let body = &response[split + 4..];
    if headers.to_ascii_lowercase().contains("transfer-encoding: chunked") { decode_chunked(body) } else { Ok(body.to_vec()) }
}

fn decode_chunked(mut input: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    loop {
        let end = input.windows(2).position(|value| value == b"\r\n").ok_or("invalid chunked response")?;
        let size = usize::from_str_radix(std::str::from_utf8(&input[..end]).map_err(|e| e.to_string())?.split(';').next().unwrap_or_default(), 16).map_err(|e| e.to_string())?;
        input = &input[end + 2..];
        if size == 0 { break; }
        if input.len() < size + 2 { return Err("truncated chunked response".into()); }
        output.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
    Ok(output)
}
