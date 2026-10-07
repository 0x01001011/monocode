use crate::ssh_askpass::Askpass;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, MutexGuard, PoisonError, TryLockError,
};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub target: String,
    pub port: Option<u16>,
    pub remote_port: u16,
}

pub fn validate_target(target: &str, port: Option<u16>) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty()
        || target.len() > 255
        || target.starts_with('-')
        || port == Some(0)
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@:[ ]".contains(&b) && b != b' ')
        || target.matches('@').count() > 1
        || target.starts_with('@')
        || target.ends_with('@')
    {
        return Err(
            "Enter an SSH hostname or alias, such as user@my-mac-mini, and a valid port.".into(),
        );
    }
    Ok(target.into())
}

/// Why an SSH attempt failed, as a stable slug the UI can switch on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshErrorKind {
    HostKeyChanged,
    PermissionDenied,
    Timeout,
    Dns,
    Refused,
    NeedsInteractiveAuth,
    SshMissing,
    Unknown,
}

impl SshErrorKind {
    const ALL: [SshErrorKind; 8] = [
        Self::HostKeyChanged,
        Self::PermissionDenied,
        Self::Timeout,
        Self::Dns,
        Self::Refused,
        Self::NeedsInteractiveAuth,
        Self::SshMissing,
        Self::Unknown,
    ];
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::HostKeyChanged => "host-key-changed",
            Self::PermissionDenied => "permission-denied",
            Self::Timeout => "timeout",
            Self::Dns => "dns",
            Self::Refused => "refused",
            Self::NeedsInteractiveAuth => "needs-interactive-auth",
            Self::SshMissing => "ssh-missing",
            Self::Unknown => "unknown",
        }
    }
    pub fn from_slug(slug: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_slug() == slug)
    }
}

const ERROR_PREFIX: &str = "[ssh:";

/// `[ssh:<kind>] message`: errors stay plain strings across the Tauri boundary.
pub fn tag_error(kind: SshErrorKind, message: &str) -> String {
    format!("{ERROR_PREFIX}{}] {message}", kind.as_slug())
}

pub fn split_error_kind(error: &str) -> (Option<SshErrorKind>, &str) {
    error
        .strip_prefix(ERROR_PREFIX)
        .and_then(|rest| rest.split_once("] "))
        .and_then(|(slug, message)| Some((SshErrorKind::from_slug(slug)?, message)))
        .map_or((None, error), |(kind, message)| (Some(kind), message))
}

pub fn ensure_error_kind(error: String, default: SshErrorKind) -> String {
    if split_error_kind(&error).0.is_some() {
        error
    } else {
        tag_error(default, &error)
    }
}

const MAX_URL_BYTES: usize = 2048;

/// Byte ranges of every http(s) URL in `text`, without wrapping punctuation.
fn url_spans(text: &str) -> Vec<(usize, usize)> {
    let lowered = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    let mut resume = 0;
    for (start, _) in lowered.match_indices("http") {
        if start < resume {
            continue;
        }
        let rest = &lowered[start + 4..];
        let scheme = if rest.starts_with("s://") {
            8
        } else if rest.starts_with("://") {
            7
        } else {
            continue;
        };
        let body = &text[start + scheme..];
        let length = body
            .find(|c: char| c.is_whitespace() || c.is_control() || "\"'<>".contains(c))
            .unwrap_or(body.len());
        let body = body[..length].trim_end_matches(|c| ".,;:!?)]}".contains(c));
        resume = start + scheme + length;
        if body.chars().any(char::is_alphanumeric) {
            spans.push((start, start + scheme + body.len()));
        }
    }
    spans
}

/// The first http(s) URL on a stderr line, e.g. a Tailscale check-mode link.
/// Callers must treat the result as a secret: never log it or put it in errors.
pub fn extract_auth_url(line: &str) -> Option<String> {
    url_spans(line)
        .into_iter()
        .map(|(start, end)| &line[start..end])
        .find(|url| url.len() <= MAX_URL_BYTES)
        .map(str::to_string)
}

/// Replaces every URL so diagnostics can be shown without leaking sign-in links.
pub fn redact_urls(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut last = 0;
    for (start, end) in url_spans(text) {
        output.push_str(&text[last..start]);
        output.push_str("[link hidden]");
        last = end;
    }
    output.push_str(&text[last..]);
    output
}

const SIGN_IN_WORDS: [&str; 10] = [
    "authenticat",
    "log in",
    "login",
    "sign in",
    "sign-in",
    "sso",
    "approve",
    "visit",
    "browser",
    "device",
];

/// Whether stderr asks the user to finish signing in elsewhere, such as Tailscale
/// SSH check mode or a NetBird SSO login. A bare link (a banner) is not enough:
/// the link's line or the two lines before it must talk about signing in.
fn requests_interactive_auth(stderr: &str) -> bool {
    let lines: Vec<String> = stderr.lines().map(str::to_ascii_lowercase).collect();
    lines.iter().enumerate().any(|(index, line)| {
        if line.contains("additional check") || line.contains("check mode") {
            return true;
        }
        if extract_auth_url(line).is_none() {
            return false;
        }
        let context = lines[index.saturating_sub(2)..=index].join(" ");
        SIGN_IN_WORDS.iter().any(|word| context.contains(word))
    })
}

pub fn classify_ssh_error(stderr: &str, io: Option<&std::io::Error>) -> SshErrorKind {
    if io.is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return SshErrorKind::SshMissing;
    }
    if requests_interactive_auth(stderr) {
        return SshErrorKind::NeedsInteractiveAuth;
    }
    let text = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&[
        "remote host identification has changed",
        "host key verification failed",
    ]) {
        SshErrorKind::HostKeyChanged
    } else if has(&[
        "permission denied",
        "too many authentication failures",
        "authentication failed",
    ]) {
        SshErrorKind::PermissionDenied
    } else if has(&[
        "could not resolve hostname",
        "name or service not known",
        "nodename nor servname",
        "temporary failure in name resolution",
    ]) {
        SshErrorKind::Dns
    } else if has(&[
        "connection refused",
        "no route to host",
        "network is unreachable",
    ]) {
        SshErrorKind::Refused
    } else if has(&["timed out"]) {
        SshErrorKind::Timeout
    } else {
        SshErrorKind::Unknown
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub message: String,
    pub confirm: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub message: String,
    pub prompt: Option<Prompt>,
    pub done: bool,
    pub error: Option<String>,
    /// Slug of the `SshErrorKind` behind `error`; set whenever the job fails.
    /// Left out when unset, matching the optional `SshSetup.errorKind`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// Browser link ssh asked the user to open (e.g. Tailscale check mode).
    /// Sensitive: it is only ever returned to the UI, never logged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    pub machine: Option<crate::remote::Machine>,
}
struct JobData {
    view: JobView,
    answer: Option<String>,
}
pub struct Job {
    inner: Mutex<JobData>,
    pub cancelled: AtomicBool,
}
impl Job {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(JobData {
                view: JobView {
                    id: uuid::Uuid::new_v4().to_string(),
                    message: "Connecting to SSH and setting up MonoCode Host…".into(),
                    prompt: None,
                    done: false,
                    error: None,
                    error_kind: None,
                    auth_url: None,
                    machine: None,
                },
                answer: None,
            }),
            cancelled: AtomicBool::new(false),
        })
    }
    pub fn view(&self) -> JobView {
        self.inner.lock().unwrap().view.clone()
    }
    pub fn message(&self, text: &str) {
        self.inner.lock().unwrap().view.message = text.into();
    }
    pub fn complete(&self, action: impl FnOnce() -> Result<crate::remote::Machine, String>) {
        let mut inner = self.inner.lock().unwrap();
        let result = if self.cancelled.load(Ordering::Relaxed) {
            Err("Connection cancelled".into())
        } else {
            action()
        };
        inner.view.done = true;
        inner.view.prompt = None;
        inner.answer = None;
        match result {
            Ok(machine) => {
                inner.view.message = "Connected".into();
                inner.view.auth_url = None;
                inner.view.machine = Some(machine);
            }
            Err(error) => {
                let (kind, message) = split_error_kind(&error);
                inner.view.error_kind =
                    Some(kind.unwrap_or(SshErrorKind::Unknown).as_slug().into());
                inner.view.error = Some(message.to_string());
            }
        }
    }
    /// Publishes the sign-in link ssh printed. Repeating a link is a no-op and a
    /// different one replaces it, since only the newest approval can succeed.
    pub fn set_auth_url(&self, url: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.view.auth_url.as_deref() != Some(url) {
            inner.view.auth_url = Some(url.into());
        }
    }
    fn clear_auth_url(&self) {
        self.inner.lock().unwrap().view.auth_url = None;
    }
    pub fn cancel(&self) {
        let inner = self.inner.lock().unwrap();
        if !inner.view.done {
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }
    pub fn answer(&self, id: &str, answer: String) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "SSH prompt is unavailable")?;
        let prompt = inner
            .view
            .prompt
            .as_ref()
            .filter(|p| p.id == id)
            .ok_or("This SSH prompt has expired")?;
        // Typed or pasted codes often arrive with their line ending attached.
        let answer = answer.trim_end_matches(['\r', '\n']);
        if answer.len() > 8192
            || answer.contains(['\n', '\r', '\0'])
            || (prompt.confirm && answer != "yes" && answer != "no")
        {
            return Err("Invalid SSH prompt response".into());
        }
        inner.answer = Some(answer.to_string());
        Ok(())
    }
    fn prompt(&self, message: String, confirm: bool) -> Option<String> {
        let deadline = Instant::now() + crate::ssh_askpass::PROMPT_WAIT;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.answer = None;
            inner.view.prompt = Some(Prompt {
                id: uuid::Uuid::new_v4().to_string(),
                message,
                confirm,
            });
        }
        loop {
            let mut inner = self.inner.lock().unwrap();
            if self.cancelled.load(Ordering::Relaxed)
                || Instant::now() >= deadline
                || inner.view.done
            {
                inner.view.prompt = None;
                inner.answer = None;
                return None;
            }
            if let Some(answer) = inner.answer.take() {
                inner.view.prompt = None;
                return Some(answer);
            }
            drop(inner);
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn askpass(self: &Arc<Self>) -> Result<Askpass, String> {
        let job = self.clone();
        Askpass::start(move |message, confirm| job.prompt(message, confirm))
    }
}

/// `MONOCODE_SSH_BIN` names the ssh program; tests point it at a fake.
fn ssh_program(configured: Option<OsString>) -> OsString {
    configured
        .filter(|program| !program.is_empty())
        .unwrap_or_else(|| "ssh".into())
}

fn command(target: &SshTarget, interactive: bool) -> Command {
    command_with_program(
        &ssh_program(std::env::var_os("MONOCODE_SSH_BIN")),
        target,
        interactive,
    )
}

fn command_with_program(program: &OsStr, target: &SshTarget, interactive: bool) -> Command {
    let mut command = Command::new(program);
    command.args([
        "-T",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "NumberOfPasswordPrompts=3",
        "-o",
        "ForkAfterAuthentication=no",
    ]);
    command.args([
        "-o",
        if interactive {
            "BatchMode=no"
        } else {
            "BatchMode=yes"
        },
    ]);
    if let Some(port) = target.port {
        command.args(["-p", &port.to_string()]);
    }
    command
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn capture(mut reader: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let remaining = (64 * 1024usize).saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        output
    })
}

const STDERR_LINE_LIMIT: usize = 8192;

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    auth_url_seen: bool,
}

/// Reads ssh's stderr as it arrives. The first `cap` bytes are kept for error
/// messages; every line is scanned for a sign-in URL, which goes straight to the
/// job so the UI can show it while ssh is still waiting for approval.
struct StderrCapture {
    shared: Arc<Mutex<Captured>>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl StderrCapture {
    fn spawn(mut reader: impl Read + Send + 'static, cap: usize, job: Option<Arc<Job>>) -> Self {
        let shared = Arc::new(Mutex::new(Captured::default()));
        let state = shared.clone();
        let reader = std::thread::spawn(move || {
            let mut line = Vec::new();
            let mut buffer = [0; 2048];
            let scan = |line: &[u8]| {
                let Some(url) = extract_auth_url(&String::from_utf8_lossy(line)) else {
                    return;
                };
                state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .auth_url_seen = true;
                if let Some(job) = &job {
                    job.set_auth_url(&url);
                }
            };
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                {
                    let mut captured = state.lock().unwrap_or_else(PoisonError::into_inner);
                    let remaining = cap.saturating_sub(captured.bytes.len());
                    captured
                        .bytes
                        .extend_from_slice(&buffer[..count.min(remaining)]);
                }
                for &byte in &buffer[..count] {
                    if byte == b'\n' || byte == b'\r' {
                        scan(&line);
                        line.clear();
                    } else if line.len() < STDERR_LINE_LIMIT {
                        line.push(byte);
                    }
                }
            }
            scan(&line);
        });
        Self {
            shared,
            reader: Some(reader),
        }
    }
    fn text(&self) -> String {
        let captured = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&captured.bytes).into_owned()
    }
    fn saw_auth_url(&self) -> bool {
        self.shared
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .auth_url_seen
    }
    /// Lets the reader drain what the exited process left in the pipe. Bounded,
    /// because a stray grandchild can keep the pipe open indefinitely.
    fn wait(&mut self, timeout: Duration) {
        let Some(reader) = self.reader.as_ref() else {
            return;
        };
        let deadline = Instant::now() + timeout;
        while !reader.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if reader.is_finished() {
            let _ = self.reader.take().map(std::thread::JoinHandle::join);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostPlatform {
    Unix,
    Windows,
}

const PLATFORM_PROBE: &[&str] = &["echo", "MONOCODE_PLATFORM", "$env:OS", "%OS%", "$OS"];

fn parse_platform(output: &str) -> Result<HostPlatform, String> {
    let marker = output
        .rsplit_once("MONOCODE_PLATFORM")
        .ok_or("Could not identify the remote shell. Use cmd.exe, PowerShell, or a Unix shell.")?
        .1;
    Ok(
        if marker
            .split_whitespace()
            .any(|word| word.eq_ignore_ascii_case("Windows_NT"))
        {
            HostPlatform::Windows
        } else {
            HostPlatform::Unix
        },
    )
}

pub fn detect_platform(
    target: &SshTarget,
    job: &Arc<Job>,
    askpass: &Askpass,
) -> Result<HostPlatform, String> {
    job.message("Checking the remote machine…");
    let output = run_remote_command(
        target,
        String::new(),
        job,
        askpass,
        command(target, true),
        PLATFORM_PROBE,
    )?;
    parse_platform(&output)
}

fn powershell_encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Keep the remote command below cmd.exe's length limit. The actual script is
/// read from UTF-8 stdin as a single block, rather than evaluated line by line.
fn powershell_reader() -> String {
    // Prefer this shell's built-in modules if the SSH environment inherited
    // PowerShell 7 module paths through an intermediate process.
    powershell_encoded("$env:PSModulePath = $PSHOME + '\\Modules;' + $env:PSModulePath; $ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); try { & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }")
}

pub fn run_script(
    target: &SshTarget,
    platform: HostPlatform,
    script: String,
    job: &Arc<Job>,
    askpass: &Askpass,
) -> Result<String, String> {
    if platform == HostPlatform::Windows {
        let encoded = powershell_reader();
        run_remote_command(
            target,
            script,
            job,
            askpass,
            command(target, true),
            &[
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded,
            ],
        )
    } else {
        run_script_with_command(target, script, job, askpass, || command(target, true))
    }
}

fn run_script_with_command(
    target: &SshTarget,
    script: String,
    job: &Arc<Job>,
    askpass: &Askpass,
    make_command: impl FnMut() -> Command,
) -> Result<String, String> {
    run_unix_script(target, script, job, askpass, make_command, SETUP_DEADLINE)
}

const LOGIN_SHELL: &[&str] = &["sh", "-l", "-s"];
const PLAIN_SHELL: &[&str] = &["sh", "-s"];

/// Runs a script in a login shell so it sees the user's PATH. Some `sh` builds
/// reject `-l`; they get the script once more without it.
fn run_unix_script(
    target: &SshTarget,
    script: String,
    job: &Arc<Job>,
    askpass: &Askpass,
    mut make_command: impl FnMut() -> Command,
    deadline: Duration,
) -> Result<String, String> {
    let login = run_remote_command_with_deadline(
        target,
        script.clone(),
        job,
        askpass,
        make_command(),
        LOGIN_SHELL,
        deadline,
    );
    match login {
        Err(error) if rejects_login_flag(&error) => run_remote_command_with_deadline(
            target,
            script,
            job,
            askpass,
            make_command(),
            PLAIN_SHELL,
            deadline,
        ),
        result => result,
    }
}

/// Whether a failed setup came from the remote `sh` refusing `-l`, rather than
/// from ssh or from the script itself.
fn rejects_login_flag(error: &str) -> bool {
    let (kind, message) = split_error_kind(error);
    kind == Some(SshErrorKind::Unknown)
        && message.to_ascii_lowercase().lines().any(|line| {
            (line.contains("illegal option") || line.contains("invalid option"))
                && ["-l", "-- l", "'l'"].iter().any(|flag| line.contains(flag))
        })
}

/// The reply of a setup script: the last stdout line that is a JSON object.
/// Login shells print banners and MOTD text before it, and exit hooks after.
pub fn last_json_object(output: &str) -> Option<serde_json::Value> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .filter(serde_json::Value::is_object)
        })
}

const SETUP_DEADLINE: Duration = Duration::from_secs(300);
const STDERR_SETTLE: Duration = Duration::from_secs(2);
const OUTPUT_EXCERPT_CHARS: usize = 2000;
const MISSING_SSH: &str = "OpenSSH (ssh) was not found on this computer";
const SIGN_IN_FROM_SETTINGS: &str = "SSH is waiting for an interactive sign-in (for example Tailscale SSH check mode). Open Settings → Connections and press Reconnect to approve it.";
const SIGN_IN_FROM_DIALOG: &str =
    "SSH sign-in was not approved in time. Approve the request in your browser, then try again.";

fn spawn_error(error: &std::io::Error) -> String {
    match classify_ssh_error("", Some(error)) {
        SshErrorKind::SshMissing => tag_error(SshErrorKind::SshMissing, MISSING_SSH),
        kind => tag_error(kind, &format!("Could not start OpenSSH: {error}")),
    }
}

/// Stderr that is safe to show: sign-in links removed, then bounded.
fn output_excerpt(stderr: &str, limit: usize) -> String {
    redact_urls(stderr).trim().chars().take(limit).collect()
}

/// ssh printed a sign-in link, or its text asks for an interactive sign-in.
fn blocked_on_sign_in(capture: &StderrCapture, stderr: &str) -> bool {
    capture.saw_auth_url() || classify_ssh_error(stderr, None) == SshErrorKind::NeedsInteractiveAuth
}

fn run_remote_command(
    target: &SshTarget,
    script: String,
    job: &Arc<Job>,
    askpass: &Askpass,
    command: Command,
    remote: &[&str],
) -> Result<String, String> {
    run_remote_command_with_deadline(
        target,
        script,
        job,
        askpass,
        command,
        remote,
        SETUP_DEADLINE,
    )
}

enum Outcome {
    Cancelled,
    TimedOut,
    Exited(ExitStatus),
    Failed(std::io::Error),
}

fn run_remote_command_with_deadline(
    target: &SshTarget,
    script: String,
    job: &Arc<Job>,
    askpass: &Askpass,
    mut command: Command,
    remote: &[&str],
    deadline: Duration,
) -> Result<String, String> {
    if job.cancelled.load(Ordering::Relaxed) {
        return Err("Connection cancelled".into());
    }
    askpass.configure(&mut command)?;
    command.args(["--", &target.target]).args(remote);
    // A link from an earlier ssh run can no longer be approved.
    job.clear_auth_url();
    let mut child = command.spawn().map_err(|e| spawn_error(&e))?;
    let stdout = capture(child.stdout.take().unwrap());
    let mut stderr =
        StderrCapture::spawn(child.stderr.take().unwrap(), 64 * 1024, Some(job.clone()));
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(script.as_bytes()));
    let deadline = Instant::now() + deadline;
    let outcome = loop {
        if job.cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break if job.cancelled.load(Ordering::Relaxed) {
                Outcome::Cancelled
            } else {
                Outcome::TimedOut
            };
        }
        match child.try_wait() {
            Ok(Some(status)) => break Outcome::Exited(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Outcome::Failed(error);
            }
        }
    };
    let _ = writer.join();
    let output = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).to_string();
    stderr.wait(STDERR_SETTLE);
    let errors = stderr.text();
    match outcome {
        Outcome::Cancelled => Err("Connection cancelled".into()),
        Outcome::TimedOut if blocked_on_sign_in(&stderr, &errors) => Err(tag_error(
            SshErrorKind::NeedsInteractiveAuth,
            "SSH setup timed out waiting for sign-in approval. Approve the request in your browser, then try again.",
        )),
        Outcome::TimedOut => Err(tag_error(
            SshErrorKind::Timeout,
            "SSH setup timed out. Check the host's network connection and try again.",
        )),
        Outcome::Failed(error) => Err(tag_error(
            classify_ssh_error(&errors, Some(&error)),
            &error.to_string(),
        )),
        Outcome::Exited(status) if status.success() => Ok(output),
        Outcome::Exited(status) => {
            // ssh itself exits 255; any other code came from the remote command,
            // whose stderr must not be mistaken for a connection problem.
            let kind = if status.code().is_some_and(|code| code != 255) {
                SshErrorKind::Unknown
            } else if blocked_on_sign_in(&stderr, &errors) {
                SshErrorKind::NeedsInteractiveAuth
            } else {
                classify_ssh_error(&errors, None)
            };
            Err(tag_error(
                kind,
                &format!("SSH setup failed: {}", output_excerpt(&errors, 4000)),
            ))
        }
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn bootstrap_script(platform: HostPlatform) -> String {
    let template = match platform {
        HostPlatform::Unix => include_str!("remote_bootstrap.sh"),
        HostPlatform::Windows => include_str!("remote_bootstrap.ps1"),
    };
    bootstrap_script_from_template(platform, template)
}

fn bootstrap_script_from_template(platform: HostPlatform, template: &str) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let url = format!("https://github.com/hardbeat920/monocode/releases/download/v{version}");
    match platform {
        // include_str! preserves checkout line endings, including Windows CRLF.
        HostPlatform::Unix => template
            .replace("\r\n", "\n")
            .replace("@@VERSION@@", &shell_quote(version))
            .replace("@@RELEASE@@", &shell_quote(&url)),
        HostPlatform::Windows => template
            .replace("@@VERSION@@", &powershell_quote(version))
            .replace("@@RELEASE@@", &powershell_quote(&url))
            .replace("@@ACL@@", include_str!("../../host/windows-acl.ps1")),
    }
}

pub fn upgrade_script(platform: HostPlatform, port: u16) -> String {
    let script = bootstrap_script(platform);
    match platform {
        HostPlatform::Unix => {
            format!("MONOCODE_HOST_FORCE_UPGRADE=1\nMONOCODE_HOST_PORT={port}\n{script}")
        }
        HostPlatform::Windows => format!(
            "$env:MONOCODE_HOST_FORCE_UPGRADE = '1'\n$env:MONOCODE_HOST_PORT = '{port}'\n{script}"
        ),
    }
}

pub fn pairing_script(platform: HostPlatform, name: &str) -> String {
    match platform {
        HostPlatform::Unix => format!("set -eu\n\"$HOME/.monocode-host/bin/monocode-host\" pair --name {} --json\n", shell_quote(name)),
        HostPlatform::Windows => format!("$ErrorActionPreference = 'Stop'\n$base = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.monocode-host'\n$runtime = [IO.File]::ReadAllText((Join-Path $base 'runtime-path')).Trim()\n& (Join-Path $runtime 'node.exe') (Join-Path $runtime 'host.mjs') pair --name {} --json\nif ($LASTEXITCODE -ne 0) {{ throw 'Host pairing failed.' }}\n", powershell_quote(name)),
    }
}

pub struct Tunnel {
    child: Child,
    pub port: u16,
    stderr: StderrCapture,
    signs_in_with_job: bool,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Tunnel {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    /// The failure for a process that is gone or still not forwarding.
    fn failure(&mut self, exited: bool) -> String {
        if exited {
            self.stderr.wait(Duration::from_secs(1));
        }
        let text = self.stderr.text();
        let output = output_excerpt(&text, OUTPUT_EXCERPT_CHARS);
        let with_output = |headline: &str| {
            if output.is_empty() {
                headline.to_string()
            } else {
                format!("{headline} SSH output: {output}")
            }
        };
        if blocked_on_sign_in(&self.stderr, &text) {
            let headline = if self.signs_in_with_job {
                SIGN_IN_FROM_DIALOG
            } else {
                SIGN_IN_FROM_SETTINGS
            };
            return tag_error(SshErrorKind::NeedsInteractiveAuth, &with_output(headline));
        }
        if exited {
            let message = if output.is_empty() {
                "SSH connection closed before it was ready. Open Settings → Connections and reconnect to check access.".to_string()
            } else {
                format!("SSH connection failed: {output}. Open Settings → Connections and reconnect to check access.")
            };
            return tag_error(classify_ssh_error(&text, None), &message);
        }
        tag_error(
            SshErrorKind::Timeout,
            &with_output(
                "SSH timed out. Open Settings → Connections and reconnect to authenticate.",
            ),
        )
    }
    /// Classifies an ssh that has exited during startup.
    fn exited(&mut self) -> Attempt {
        let error = self.failure(true);
        if forward_port_taken(&self.stderr.text()) {
            Attempt::PortTaken(error)
        } else {
            Attempt::Failed(error)
        }
    }
    pub fn start(
        target: &SshTarget,
        job: Option<&Arc<Job>>,
        askpass: Option<&Askpass>,
    ) -> Result<Self, String> {
        Self::start_with_command(target, job, askpass, || command(target, askpass.is_some()))
    }

    fn start_with_command(
        target: &SshTarget,
        job: Option<&Arc<Job>>,
        askpass: Option<&Askpass>,
        make_command: impl FnMut() -> Command,
    ) -> Result<Self, String> {
        let deadline = Duration::from_secs(if job.is_some() { 150 } else { 20 });
        Self::start_with_deadline(target, job, askpass, make_command, deadline, PORT_SETTLE)
    }

    /// Starts ssh on a free local port. If another program grabs that port
    /// before ssh listens on it, a fresh port is tried, within one deadline.
    fn start_with_deadline(
        target: &SshTarget,
        job: Option<&Arc<Job>>,
        askpass: Option<&Askpass>,
        mut make_command: impl FnMut() -> Command,
        deadline: Duration,
        settle: Duration,
    ) -> Result<Self, String> {
        let deadline = Instant::now() + deadline;
        let mut tried = Vec::new();
        loop {
            let (listener, port) = reserve_port(&tried)?;
            tried.push(port);
            let attempt = Self::attempt(
                target,
                job,
                askpass,
                make_command(),
                (listener, port),
                deadline,
                settle,
            );
            match attempt {
                Ok(tunnel) => return Ok(tunnel),
                Err(Attempt::PortTaken(_)) if tried.len() < PORT_ATTEMPTS => {}
                Err(Attempt::PortTaken(error) | Attempt::Failed(error)) => return Err(error),
            }
        }
    }

    fn attempt(
        target: &SshTarget,
        job: Option<&Arc<Job>>,
        askpass: Option<&Askpass>,
        mut command: Command,
        (listener, port): (TcpListener, u16),
        deadline: Instant,
        settle: Duration,
    ) -> Result<Self, Attempt> {
        if let Some(askpass) = askpass {
            askpass.configure(&mut command).map_err(Attempt::Failed)?;
        }
        command.args([
            "-N",
            "-L",
            &format!("127.0.0.1:{port}:127.0.0.1:{}", target.remote_port),
            "--",
            &target.target,
        ]);
        command.stdin(Stdio::null()).stdout(Stdio::null());
        drop(listener);
        if let Some(job) = job {
            job.clear_auth_url();
        }
        let mut child = command
            .spawn()
            .map_err(|e| Attempt::Failed(spawn_error(&e)))?;
        let stderr = StderrCapture::spawn(child.stderr.take().unwrap(), 8192, job.cloned());
        let mut tunnel = Self {
            child,
            port,
            stderr,
            signs_in_with_job: job.is_some(),
        };
        loop {
            if job.is_some_and(|j| j.cancelled.load(Ordering::Relaxed)) {
                return Err(Attempt::Failed("Connection cancelled".into()));
            }
            if !tunnel.alive() {
                return Err(tunnel.exited());
            }
            if accepts_connections(port) {
                // What answered may be another program that took the port; an
                // ssh that then cannot listen on it exits a moment later.
                std::thread::sleep(settle);
                return if tunnel.alive() {
                    Ok(tunnel)
                } else {
                    Err(tunnel.exited())
                };
            }
            if Instant::now() >= deadline {
                return Err(Attempt::Failed(tunnel.failure(false)));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(all(test, unix))]
impl Tunnel {
    /// A tunnel whose "ssh" is a shell script; dropping it kills the process.
    pub(crate) fn running_for_tests(script: &str) -> Self {
        let mut child = Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = StderrCapture::spawn(child.stderr.take().unwrap(), 8192, None);
        Self {
            child,
            port: 9,
            stderr,
            signs_in_with_job: false,
        }
    }
}

/// How long ssh must stay up after its local port first accepts a connection.
const PORT_SETTLE: Duration = Duration::from_millis(200);
/// Local ports tried when ssh cannot listen on the one it was given.
const PORT_ATTEMPTS: usize = 3;

fn accepts_connections(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(100))
        // A connect to a port nobody listens on can pick that same port as its
        // source and connect to itself, which says nothing about ssh.
        .is_ok_and(|stream| stream.local_addr().ok() != stream.peer_addr().ok())
}

enum Attempt {
    /// ssh could not listen on its local port; a fresh one may work.
    PortTaken(String),
    Failed(String),
}

fn forward_port_taken(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    [
        "address already in use",
        "cannot listen to port",
        "could not request local forwarding",
        "exitonforwardfailure",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// A free loopback port other than `avoid`, still bound so it stays free
/// until ssh is about to start.
fn reserve_port(avoid: &[u16]) -> Result<(TcpListener, u16), String> {
    // Holding rejected listeners makes each bind return a different port.
    let mut rejected = Vec::new();
    loop {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        if !avoid.contains(&port) {
            return Ok((listener, port));
        }
        rejected.push(listener);
    }
}

/// Lazy restarts after consecutive failures wait 2 s, 4 s, 8 s, … up to 60 s.
const BACKOFF_FIRST: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default)]
struct Backoff {
    failures: u32,
    until: Option<Instant>,
}
impl Backoff {
    /// The wait after `failures` consecutive failures.
    fn delay(failures: u32) -> Duration {
        match failures {
            0 => Duration::ZERO,
            n => BACKOFF_FIRST
                .saturating_mul(1 << (n - 1).min(16))
                .min(BACKOFF_MAX),
        }
    }
    /// Records a failure at `now` and returns how long to wait after it.
    fn fail(&mut self, now: Instant) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let delay = Self::delay(self.failures);
        self.until = Some(now + delay);
        delay
    }
    fn remaining(&self, now: Instant) -> Option<Duration> {
        self.until
            .map(|until| until.saturating_duration_since(now))
            .filter(|wait| !wait.is_zero())
    }
    fn reset(&mut self) {
        *self = Self::default();
    }
}

fn with_retry_hint(error: &str, remaining: Duration) -> String {
    let seconds = remaining.as_millis().div_ceil(1000).max(1);
    format!("{error} Retrying in {seconds} s.")
}

/// Consecutive stalled requests after which a tunnel counts as half-open.
const STALL_LIMIT: u32 = 3;

/// How many network changes and explicit reconnects a slot has caught up with.
type Stamp = (u64, u64);

#[derive(Default)]
struct Slot {
    tunnel: Option<Tunnel>,
    failure: Option<String>,
    backoff: Backoff,
    /// Requests in a row that timed out or broke off through this tunnel.
    stalls: u32,
    generation: u64,
    stamp: Stamp,
}
impl Slot {
    fn forget_failures(&mut self) {
        self.failure = None;
        self.backoff.reset();
        self.stalls = 0;
    }
    /// Applies the network changes and reconnects requested since last use.
    fn catch_up(&mut self, (network, machine): Stamp) {
        if network > self.stamp.0 {
            self.tunnel = None;
        }
        if network > self.stamp.0 || machine > self.stamp.1 {
            self.forget_failures();
        }
        self.stamp = (self.stamp.0.max(network), self.stamp.1.max(machine));
    }
}

pub struct TunnelLease {
    pub endpoint: String,
    slot: Arc<Mutex<Slot>>,
    generation: u64,
}

/// Each machine has its own lock: restarting one machine's tunnel (up to
/// 20 seconds) must not block requests to other machines.
#[derive(Default)]
pub struct Tunnels {
    slots: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    /// Network changes and per-machine reconnects are counted rather than
    /// applied under the slot lock, so neither waits for a restart in progress;
    /// slots catch up the next time they are locked.
    network: AtomicU64,
    reconnects: Mutex<HashMap<String, u64>>,
}
impl Tunnels {
    fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<Slot>>>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn stamp(&self, id: &str) -> Stamp {
        let reconnects = self
            .reconnects
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        (
            self.network.load(Ordering::SeqCst),
            reconnects.get(id).copied().unwrap_or(0),
        )
    }
    pub fn insert(&self, id: String, tunnel: Tunnel) {
        // A fresh slot never waits for a reconnect in progress; that attempt's
        // tunnel is dropped with the replaced slot.
        let slot = Slot {
            tunnel: Some(tunnel),
            generation: 1,
            stamp: self.stamp(&id),
            ..Slot::default()
        };
        let old = self.slots().insert(id, Arc::new(Mutex::new(slot)));
        drop(old);
    }
    pub fn remove(&self, id: &str) {
        let old = self.slots().remove(id);
        drop(old);
        self.reconnects
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
    pub fn endpoint(&self, id: &str, target: &SshTarget) -> Result<TunnelLease, String> {
        self.endpoint_at(id, target, Instant::now, |target| {
            Tunnel::start(target, None, None)
        })
    }
    #[cfg(test)]
    fn endpoint_with(
        &self,
        id: &str,
        target: &SshTarget,
        now: Instant,
        start: impl Fn(&SshTarget) -> Result<Tunnel, String>,
    ) -> Result<TunnelLease, String> {
        self.endpoint_at(id, target, || now, start)
    }
    fn endpoint_at(
        &self,
        id: &str,
        target: &SshTarget,
        clock: impl Fn() -> Instant,
        start: impl Fn(&SshTarget) -> Result<Tunnel, String>,
    ) -> Result<TunnelLease, String> {
        let slot = self.slots().entry(id.into()).or_default().clone();
        let mut current = slot.lock().unwrap_or_else(PoisonError::into_inner);
        current.catch_up(self.stamp(id));
        // try_wait on every call: an ssh that exited is restarted right away.
        if let Some(tunnel) = current.tunnel.as_mut() {
            if tunnel.alive() {
                return Ok(TunnelLease {
                    endpoint: format!("http://127.0.0.1:{}", tunnel.port),
                    slot: slot.clone(),
                    generation: current.generation,
                });
            }
        }
        current.tunnel = None;
        if let (Some(error), Some(remaining)) =
            (&current.failure, current.backoff.remaining(clock()))
        {
            return Err(with_retry_hint(error, remaining));
        }
        match start(target) {
            Ok(tunnel) => {
                let endpoint = format!("http://127.0.0.1:{}", tunnel.port);
                current.forget_failures();
                current.generation = current.generation.wrapping_add(1);
                current.tunnel = Some(tunnel);
                Ok(TunnelLease {
                    endpoint,
                    slot: slot.clone(),
                    generation: current.generation,
                })
            }
            Err(error) => {
                let error = ensure_error_kind(error, SshErrorKind::Unknown);
                // The wait runs from when the attempt failed, not when it began.
                current.backoff.fail(clock());
                current.failure = Some(error.clone());
                Err(error)
            }
        }
    }
    /// The lease's slot, if it still holds the tunnel the lease was given.
    fn leased<'a>(&self, id: &str, lease: &'a TunnelLease) -> Option<MutexGuard<'a, Slot>> {
        let slot = self.slots().get(id).cloned()?;
        if !Arc::ptr_eq(&slot, &lease.slot) {
            return None;
        }
        let current = lease.slot.lock().unwrap_or_else(PoisonError::into_inner);
        (current.generation == lease.generation).then_some(current)
    }
    pub fn invalidate(&self, id: &str, lease: &TunnelLease) {
        if let Some(mut current) = self.leased(id, lease) {
            current.tunnel = None;
            current.failure = None;
            current.stalls = 0;
        }
    }
    /// A request through the lease's tunnel got a response.
    pub fn request_succeeded(&self, id: &str, lease: &TunnelLease) {
        if let Some(mut current) = self.leased(id, lease) {
            current.stalls = 0;
        }
    }
    /// A request through the lease's tunnel timed out or broke off. One slow
    /// response proves nothing, but `STALL_LIMIT` in a row suggest a half-open
    /// tunnel: it is dropped so the next request starts a new one. Returns
    /// whether that happened.
    pub fn request_stalled(&self, id: &str, lease: &TunnelLease) -> bool {
        let Some(mut current) = self.leased(id, lease) else {
            return false;
        };
        current.stalls += 1;
        if current.stalls < STALL_LIMIT {
            return false;
        }
        current.tunnel = None;
        current.failure = None;
        current.stalls = 0;
        true
    }
    /// Lets the next request for `id` try at once, as after a manual reconnect.
    pub fn forget_failures(&self, id: &str) {
        *self
            .reconnects
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.into())
            .or_default() += 1;
    }
    /// The computer's network changed: earlier failures say nothing about the
    /// new one, and every cached tunnel may be half-open.
    pub fn network_changed(&self) {
        self.network.fetch_add(1, Ordering::SeqCst);
        let slots: Vec<_> = self
            .slots()
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect();
        for (id, slot) in slots {
            let mut current = match slot.try_lock() {
                Ok(current) => current,
                Err(TryLockError::Poisoned(error)) => error.into_inner(),
                // A restart is in progress; it catches up on its next use.
                Err(TryLockError::WouldBlock) => continue,
            };
            current.catch_up(self.stamp(&id));
        }
    }
    pub fn clear(&self) {
        let old = std::mem::take(&mut *self.slots());
        drop(old);
    }
    #[cfg(test)]
    pub(crate) fn has_tunnel(&self, id: &str) -> bool {
        self.slots().get(id).is_some_and(|slot| {
            slot.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .tunnel
                .is_some()
        })
    }
}

/// How this desktop appears in the host's device list.
pub fn device_name() -> String {
    #[cfg(not(windows))]
    let run = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    #[cfg(target_os = "macos")]
    let name = run("scutil", &["--get", "ComputerName"]).or_else(|| run("hostname", &[]));
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(any(target_os = "macos", windows)))]
    let name = std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| run("hostname", &[]));
    let name: String = name
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if name.is_empty() {
        "MonoCode desktop".into()
    } else {
        format!("MonoCode on {name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_requests_cannot_invalidate_a_newer_tunnel() {
        let tunnels = Tunnels::default();
        let slot = |generation| {
            Arc::new(Mutex::new(Slot {
                failure: Some("keep".into()),
                generation,
                ..Slot::default()
            }))
        };
        let old = slot(1);
        tunnels.slots().insert("host".into(), old.clone());
        let old_lease = TunnelLease {
            endpoint: String::new(),
            slot: old,
            generation: 1,
        };
        let newer = slot(2);
        tunnels.slots().insert("host".into(), newer.clone());
        tunnels.invalidate("host", &old_lease);
        assert!(newer.lock().unwrap().failure.is_some());
        let stale_lease = TunnelLease {
            endpoint: String::new(),
            slot: newer.clone(),
            generation: 1,
        };
        tunnels.invalidate("host", &stale_lease);
        assert!(newer.lock().unwrap().failure.is_some());
        tunnels.invalidate(
            "host",
            &TunnelLease {
                generation: 2,
                ..stale_lease
            },
        );
        assert!(newer.lock().unwrap().failure.is_none());
    }
    // scripts/test-remote-ssh.py creates an isolated sshd, host and keypair.
    // This test uses the production tunnel lifecycle and shell transport.
    #[test]
    #[ignore = "requires the isolated loopback SSH fixture"]
    fn loopback_transport_preserves_host_and_reconnects() {
        let required = |key| std::env::var(key).expect("Run scripts/test-remote-ssh.py");
        let target = SshTarget {
            target: required("MONOCODE_TEST_SSH_TARGET"),
            port: Some(required("MONOCODE_TEST_SSH_PORT").parse().unwrap()),
            remote_port: required("MONOCODE_TEST_HOST_PORT").parse().unwrap(),
        };
        let make_command = || {
            let mut command = command(&target, false);
            command.args([
                "-F",
                "/dev/null",
                "-i",
                &required("MONOCODE_TEST_SSH_KEY"),
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                &format!(
                    "UserKnownHostsFile={}",
                    required("MONOCODE_TEST_KNOWN_HOSTS")
                ),
            ]);
            command
        };
        let job = Job::new();
        let askpass = job.askpass().unwrap();
        let detected = run_remote_command(
            &target,
            String::new(),
            &job,
            &askpass,
            make_command(),
            PLATFORM_PROBE,
        )
        .unwrap();
        assert_eq!(parse_platform(&detected).unwrap(), HostPlatform::Unix);
        let output = run_script_with_command(
            &target,
            "printf 'remote-script-ok\\n'\n".into(),
            &job,
            &askpass,
            &make_command,
        )
        .unwrap();
        assert_eq!(output.trim(), "remote-script-ok");
        let environment = required("MONOCODE_TEST_ENVIRONMENT");
        for _ in 0..2 {
            let tunnel = Tunnel::start_with_command(&target, None, None, &make_command).unwrap();
            let response = ureq::post(&format!("http://127.0.0.1:{}/rpc", tunnel.port))
                .set(
                    "Authorization",
                    &format!("Bearer {}", required("MONOCODE_TEST_TOKEN")),
                )
                .send_string(r#"{"version":1,"method":"environment.describe"}"#)
                .unwrap();
            let value: serde_json::Value = serde_json::from_reader(response.into_reader()).unwrap();
            assert_eq!(value["result"]["environmentId"], environment);
            drop(tunnel);
            // A client disappearing must not kill the independently owned host.
            assert!(TcpStream::connect(("127.0.0.1", target.remote_port)).is_ok());
        }
    }
    #[test]
    fn ssh_targets_cannot_inject_options_or_shell_commands() {
        for target in [
            "home",
            "me@mac-mini.local",
            "user@192.168.1.4",
            "user@[::1]",
        ] {
            assert!(validate_target(target, None).is_ok());
        }
        for target in [
            "",
            "-oProxyCommand=bad",
            "host;touch /tmp/x",
            "host\nname",
            "$(whoami)",
            "user@host command",
            "host/../../x",
            "ssh://user@host",
            "a@b@c",
        ] {
            assert!(validate_target(target, None).is_err(), "{target}");
        }
        assert!(validate_target("host", Some(0)).is_err());
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }
    #[test]
    fn unix_bootstrap_accepts_windows_checkout_line_endings() {
        let lf_template = include_str!("remote_bootstrap.sh").replace("\r\n", "\n");
        let crlf_template = lf_template.replace('\n', "\r\n");
        let script = bootstrap_script_from_template(HostPlatform::Unix, &crlf_template);
        assert!(script.starts_with("set -eu\n"));
        assert!(!script.contains('\r'));
        assert_eq!(
            script,
            bootstrap_script_from_template(HostPlatform::Unix, &lf_template)
        );
    }
    #[test]
    fn bootstrap_is_versioned_and_only_explicit_upgrade_restarts_the_host() {
        let script = bootstrap_script(HostPlatform::Unix);
        assert!(!script.contains('\r'));
        assert!(!script.contains("@@"));
        assert!(script.contains("--proto '=https'"));
        assert!(script.contains("checksum mismatch"));
        assert!(script.contains("\"$FORCE_UPGRADE\" = 1"));
        assert!(script.contains("service uninstall"));
        assert!(
            upgrade_script(HostPlatform::Unix, 3774).starts_with("MONOCODE_HOST_FORCE_UPGRADE=1")
        );
        assert!(!upgrade_script(HostPlatform::Unix, 3774).contains('\r'));
        assert!(upgrade_script(HostPlatform::Windows, 3774)
            .starts_with("$env:MONOCODE_HOST_FORCE_UPGRADE = '1'"));
    }
    #[test]
    fn remote_platform_probe_handles_cmd_powershell_and_unix() {
        assert_eq!(
            parse_platform("MONOCODE_PLATFORM $env:OS Windows_NT $OS\r\n").unwrap(),
            HostPlatform::Windows
        );
        assert_eq!(
            parse_platform("MONOCODE_PLATFORM\r\nWindows_NT\r\n%OS%\r\n").unwrap(),
            HostPlatform::Windows
        );
        assert_eq!(
            parse_platform("MONOCODE_PLATFORM :OS %OS%\n").unwrap(),
            HostPlatform::Unix
        );
        assert!(parse_platform("unrecognized shell").is_err());
        assert!(powershell_reader().len() < 4096);
        let script = bootstrap_script(HostPlatform::Windows);
        assert!(!script.contains("@@"));
        assert!(script.contains("checksum mismatch"));
        assert!(script.contains("Protect-MonoCodeDirectory"));
        assert!(pairing_script(HostPlatform::Windows, "Nick's $PC").contains("'Nick''s $PC'"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_shells_detect_the_platform_and_accept_utf8_scripts() {
        for (program, args) in [
            ("cmd.exe", vec!["/D", "/C"]),
            (
                "powershell.exe",
                vec!["-NoProfile", "-NonInteractive", "-Command"],
            ),
        ] {
            let output = Command::new(program)
                .env_remove("PSModulePath")
                .args(args)
                .arg(PLATFORM_PROBE.join(" "))
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                parse_platform(&String::from_utf8_lossy(&output.stdout)).unwrap(),
                HostPlatform::Windows
            );
        }
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &powershell_reader(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all("Write-Output '日本語 🖥'\n".as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "日本語 🖥");
    }
    #[test]
    fn device_names_are_bounded_single_lines() {
        let name = device_name();
        assert!(name.starts_with("MonoCode"));
        assert!(name.chars().count() <= 100);
        assert!(!name.chars().any(char::is_control));
    }
    #[test]
    fn answers_must_match_the_current_prompt() {
        let job = Job::new();
        assert!(job.answer("old", "yes".into()).is_err());
        let waiter = job.clone();
        let thread = std::thread::spawn(move || waiter.prompt("Trust this host?".into(), true));
        while job.view().prompt.is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let prompt = job.view().prompt.unwrap();
        assert!(job.answer(&prompt.id, "arbitrary".into()).is_err());
        job.answer(&prompt.id, "yes".into()).unwrap();
        assert_eq!(thread.join().unwrap(), Some("yes".into()));
        assert!(job.answer(&prompt.id, "yes".into()).is_err());
    }

    // ---- error classification -------------------------------------------------
    const TAILSCALE_CHECK: &str = "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/1a2b3c4d5e6f7\n";

    #[test]
    fn changed_host_keys_are_classified() {
        let changed = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\nOffending ECDSA key in /Users/me/.ssh/known_hosts:12\nHost key verification failed.\n";
        assert_eq!(
            classify_ssh_error(changed, None),
            SshErrorKind::HostKeyChanged
        );
        assert_eq!(
            classify_ssh_error("Host key verification failed.\n", None),
            SshErrorKind::HostKeyChanged
        );
    }
    #[test]
    fn rejected_credentials_are_classified() {
        for text in [
            "me@mac-mini: Permission denied (publickey).\n",
            "me@mac-mini: Permission denied (publickey,password,keyboard-interactive).\n",
            "Permission denied, please try again.\nPermission denied, please try again.\n",
            "Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures\n",
        ] {
            assert_eq!(
                classify_ssh_error(text, None),
                SshErrorKind::PermissionDenied,
                "{text}"
            );
        }
    }
    #[test]
    fn network_timeouts_are_classified() {
        for text in [
            "ssh: connect to host 10.0.0.5 port 22: Connection timed out\n",
            "ssh: connect to host 10.0.0.5 port 22: Operation timed out\n",
            "Connection timed out during banner exchange\n",
        ] {
            assert_eq!(
                classify_ssh_error(text, None),
                SshErrorKind::Timeout,
                "{text}"
            );
        }
    }
    #[test]
    fn unresolvable_hosts_are_classified() {
        for text in [
            "ssh: Could not resolve hostname mac-mini.invalid: Name or service not known\n",
            "ssh: Could not resolve hostname mac-mini: nodename nor servname provided, or not known\n",
        ] {
            assert_eq!(classify_ssh_error(text, None), SshErrorKind::Dns, "{text}");
        }
    }
    #[test]
    fn refused_connections_are_classified() {
        assert_eq!(
            classify_ssh_error(
                "ssh: connect to host localhost port 22: Connection refused\n",
                None
            ),
            SshErrorKind::Refused
        );
        assert_eq!(
            classify_ssh_error(
                "ssh: connect to host 10.0.0.9 port 22: No route to host\n",
                None
            ),
            SshErrorKind::Refused
        );
    }
    #[test]
    fn a_missing_ssh_binary_wins_over_any_stderr() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            classify_ssh_error("", Some(&missing)),
            SshErrorKind::SshMissing
        );
        assert_eq!(
            classify_ssh_error("Permission denied (publickey).", Some(&missing)),
            SshErrorKind::SshMissing
        );
        let other = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(classify_ssh_error("", Some(&other)), SshErrorKind::Unknown);
    }
    #[test]
    fn sso_sign_in_requests_need_interactive_auth() {
        assert_eq!(
            classify_ssh_error(TAILSCALE_CHECK, None),
            SshErrorKind::NeedsInteractiveAuth
        );
        // The approval wait often ends in a plain denial; the cause is still the check.
        let denied = format!("{TAILSCALE_CHECK}me@mac-mini: Permission denied (publickey).\n");
        assert_eq!(
            classify_ssh_error(&denied, None),
            SshErrorKind::NeedsInteractiveAuth
        );
        let netbird = "Please do the SSO login in your browser.\nIf your browser didn't open automatically, use this URL to log in:\n\nhttps://login.netbird.io/device?user_code=ABCD-EFGH\n";
        assert_eq!(
            classify_ssh_error(netbird, None),
            SshErrorKind::NeedsInteractiveAuth
        );
        assert_eq!(
            classify_ssh_error("# Tailscale SSH requires an additional check.\n", None),
            SshErrorKind::NeedsInteractiveAuth
        );
    }
    #[test]
    fn banner_links_do_not_look_like_sign_in_requests() {
        let banner = "Authorized use only. Policy: https://intranet.example/policy\nme@mac-mini: Permission denied (publickey).\n";
        assert_eq!(
            classify_ssh_error(banner, None),
            SshErrorKind::PermissionDenied
        );
    }
    #[test]
    fn unrecognised_output_is_unknown() {
        assert_eq!(classify_ssh_error("", None), SshErrorKind::Unknown);
        assert_eq!(
            classify_ssh_error(
                "kex_exchange_identification: read: Connection reset by peer\n",
                None
            ),
            SshErrorKind::Unknown
        );
    }
    #[test]
    fn error_kinds_have_stable_slugs() {
        let all = [
            (SshErrorKind::HostKeyChanged, "host-key-changed"),
            (SshErrorKind::PermissionDenied, "permission-denied"),
            (SshErrorKind::Timeout, "timeout"),
            (SshErrorKind::Dns, "dns"),
            (SshErrorKind::Refused, "refused"),
            (SshErrorKind::NeedsInteractiveAuth, "needs-interactive-auth"),
            (SshErrorKind::SshMissing, "ssh-missing"),
            (SshErrorKind::Unknown, "unknown"),
        ];
        for (kind, slug) in all {
            assert_eq!(kind.as_slug(), slug);
            assert_eq!(SshErrorKind::from_slug(slug), Some(kind));
        }
        assert_eq!(SshErrorKind::from_slug("nope"), None);
    }
    #[test]
    fn error_prefixes_round_trip() {
        let tagged = tag_error(SshErrorKind::Timeout, "SSH timed out.");
        assert_eq!(tagged, "[ssh:timeout] SSH timed out.");
        assert_eq!(
            split_error_kind(&tagged),
            (Some(SshErrorKind::Timeout), "SSH timed out.")
        );
        assert_eq!(split_error_kind("plain"), (None, "plain"));
        assert_eq!(split_error_kind("[ssh:bogus] x"), (None, "[ssh:bogus] x"));
        assert_eq!(
            ensure_error_kind(tagged.clone(), SshErrorKind::Unknown),
            tagged
        );
        assert_eq!(
            ensure_error_kind("plain".into(), SshErrorKind::Unknown),
            "[ssh:unknown] plain"
        );
    }

    // ---- URL extraction -------------------------------------------------------
    #[test]
    fn tailscale_check_mode_url_is_extracted() {
        assert_eq!(
            extract_auth_url(
                "# To authenticate, visit: https://login.tailscale.com/a/1a2b3c4d5e6f7"
            ),
            Some("https://login.tailscale.com/a/1a2b3c4d5e6f7".into())
        );
        assert_eq!(
            extract_auth_url("#     https://login.tailscale.com/a/abc\r"),
            Some("https://login.tailscale.com/a/abc".into())
        );
    }
    #[test]
    fn netbird_sign_in_urls_are_extracted_without_trailing_punctuation() {
        assert_eq!(
            extract_auth_url("If your browser didn't open automatically, use this URL to log in: https://login.netbird.io/device?user_code=ABCD-EFGH."),
            Some("https://login.netbird.io/device?user_code=ABCD-EFGH".into())
        );
        assert_eq!(
            extract_auth_url("To sign in, use a web browser to open the page https://login.netbird.io/activate and enter the code ABCD-EFGH"),
            Some("https://login.netbird.io/activate".into())
        );
    }
    #[test]
    fn generic_visit_lines_are_extracted() {
        assert_eq!(
            extract_auth_url("Please visit https://sso.example.com/auth?x=1&y=2, then press enter"),
            Some("https://sso.example.com/auth?x=1&y=2".into())
        );
        assert_eq!(
            extract_auth_url("open http://192.168.1.2:8080/login now"),
            Some("http://192.168.1.2:8080/login".into())
        );
        assert_eq!(
            extract_auth_url("Open HTTPS://Example.com/Auth to continue"),
            Some("HTTPS://Example.com/Auth".into())
        );
    }
    #[test]
    fn wrapping_punctuation_is_stripped_from_urls() {
        for line in [
            "(https://example.com/a)",
            "\"https://example.com/a\".",
            "<https://example.com/a>",
            "'https://example.com/a',",
            "see https://example.com/a;",
        ] {
            assert_eq!(
                extract_auth_url(line),
                Some("https://example.com/a".into()),
                "{line}"
            );
        }
    }
    #[test]
    fn lines_without_a_usable_url_are_ignored() {
        for line in [
            "me@mac-mini: Permission denied (publickey).",
            "see https:// for details",
            "ftp://example.com/file",
            "",
        ] {
            assert_eq!(extract_auth_url(line), None, "{line}");
        }
        assert_eq!(
            extract_auth_url(&format!("https://example.com/{}", "a".repeat(3000))),
            None
        );
    }
    #[test]
    fn the_first_url_on_a_line_wins() {
        assert_eq!(
            extract_auth_url("https://one.example/a https://two.example/b"),
            Some("https://one.example/a".into())
        );
    }
    #[test]
    fn urls_are_redacted_from_diagnostic_text() {
        let text = "# To authenticate, visit: https://login.tailscale.com/a/secret.\nlater (http://x.example/y?token=1), done";
        let redacted = redact_urls(text);
        assert!(!redacted.contains("tailscale.com/a"));
        assert!(!redacted.contains("token"));
        assert!(!redacted.contains("http"));
        assert!(redacted.contains("To authenticate, visit: [link hidden]."));
        assert!(redacted.contains("([link hidden]), done"));
        assert_eq!(redact_urls("nothing here"), "nothing here");
    }

    // ---- jobs, prompts and the incremental stderr reader ----------------------
    const TAILSCALE_URL: &str = "https://login.tailscale.com/a/1a2b3c4d5e6f7";

    /// Hands out a few bytes per read, so lines and URLs straddle reads.
    struct Trickle {
        data: Vec<u8>,
        position: usize,
        step: usize,
    }
    impl Read for Trickle {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self
                .step
                .min(buffer.len())
                .min(self.data.len() - self.position);
            buffer[..count].copy_from_slice(&self.data[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        }
    }

    #[test]
    fn auth_urls_are_published_once_and_replaced_when_a_new_one_arrives() {
        let job = Job::new();
        assert_eq!(job.view().auth_url, None);
        job.set_auth_url("https://a.example/1");
        job.set_auth_url("https://a.example/1");
        assert_eq!(job.view().auth_url.as_deref(), Some("https://a.example/1"));
        job.set_auth_url("https://a.example/2");
        assert_eq!(job.view().auth_url.as_deref(), Some("https://a.example/2"));
    }
    #[test]
    fn job_views_serialize_the_new_fields_in_camel_case() {
        let job = Job::new();
        job.set_auth_url("https://a.example/1");
        let value = serde_json::to_value(job.view()).unwrap();
        assert_eq!(value["authUrl"], "https://a.example/1");
        assert!(value["errorKind"].is_null());
        assert!(value.get("auth_url").is_none() && value.get("error_kind").is_none());
    }
    #[test]
    fn unset_sign_in_fields_are_left_out_like_optional_ts_fields() {
        // protocol.ts types these as `authUrl?: string` and `errorKind?: string`,
        // so they must be absent rather than null.
        let job = Job::new();
        let value = serde_json::to_value(job.view()).unwrap();
        assert!(value.get("authUrl").is_none(), "{value}");
        assert!(value.get("errorKind").is_none(), "{value}");
        job.complete(|| Err(tag_error(SshErrorKind::Dns, "No such host.")));
        let value = serde_json::to_value(job.view()).unwrap();
        assert_eq!(value["errorKind"], "dns");
        assert!(value.get("authUrl").is_none(), "{value}");
    }
    #[test]
    fn a_failed_job_reports_the_error_kind_without_the_prefix() {
        let job = Job::new();
        job.complete(|| Err(tag_error(SshErrorKind::Timeout, "SSH timed out.")));
        let view = job.view();
        assert!(view.done);
        assert_eq!(view.error.as_deref(), Some("SSH timed out."));
        assert_eq!(view.error_kind.as_deref(), Some("timeout"));
        let job = Job::new();
        job.complete(|| Err("Host did not report a valid port".into()));
        let view = job.view();
        assert_eq!(
            view.error.as_deref(),
            Some("Host did not report a valid port")
        );
        assert_eq!(view.error_kind.as_deref(), Some("unknown"));
    }
    #[test]
    fn the_reader_publishes_urls_split_across_reads() {
        let job = Job::new();
        let mut capture = StderrCapture::spawn(
            Trickle {
                data: format!("# Tailscale SSH requires an additional check.\n# To authenticate, visit: {TAILSCALE_URL}\n").into_bytes(),
                position: 0,
                step: 3,
            },
            64 * 1024,
            Some(job.clone()),
        );
        capture.wait(Duration::from_secs(2));
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
        assert!(capture.saw_auth_url());
        assert!(capture.text().contains("additional check"));
    }
    #[test]
    fn the_reader_publishes_a_final_line_without_a_newline() {
        let job = Job::new();
        let mut capture = StderrCapture::spawn(
            std::io::Cursor::new(format!("open {TAILSCALE_URL}").into_bytes()),
            64 * 1024,
            Some(job.clone()),
        );
        capture.wait(Duration::from_secs(2));
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
    }
    #[test]
    fn the_reader_keeps_its_cap_but_still_sees_urls_after_it() {
        let job = Job::new();
        let mut input = "noise noise noise\n".repeat(200);
        input.push_str(&format!("To authenticate, visit: {TAILSCALE_URL}\n"));
        let mut capture = StderrCapture::spawn(
            std::io::Cursor::new(input.into_bytes()),
            100,
            Some(job.clone()),
        );
        capture.wait(Duration::from_secs(2));
        assert_eq!(capture.text().len(), 100);
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
    }
    #[test]
    fn the_reader_survives_unbounded_lines_and_invalid_utf8() {
        let mut capture =
            StderrCapture::spawn(std::io::Cursor::new(vec![0xff; 1024 * 1024]), 8192, None);
        capture.wait(Duration::from_secs(5));
        assert_eq!(capture.text().chars().count(), 8192);
        assert!(!capture.saw_auth_url());
    }

    #[test]
    fn prompt_answers_may_end_with_a_line_break() {
        for (answer, expected) in [
            ("123456\n", "123456"),
            ("123456\r\n", "123456"),
            ("123456", "123456"),
            ("pass word\r\n\r\n", "pass word"),
        ] {
            let job = Job::new();
            let waiter = job.clone();
            let thread =
                std::thread::spawn(move || waiter.prompt("Verification code:".into(), false));
            while job.view().prompt.is_none() {
                std::thread::sleep(Duration::from_millis(5));
            }
            let id = job.view().prompt.unwrap().id;
            job.answer(&id, answer.into()).unwrap();
            assert_eq!(thread.join().unwrap().as_deref(), Some(expected));
        }
    }
    #[test]
    fn confirmations_accept_a_trailing_line_break_too() {
        let job = Job::new();
        let waiter = job.clone();
        let thread = std::thread::spawn(move || waiter.prompt("Trust this host?".into(), true));
        while job.view().prompt.is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let id = job.view().prompt.unwrap().id;
        assert!(job.answer(&id, "maybe\n".into()).is_err());
        job.answer(&id, "yes\r\n".into()).unwrap();
        assert_eq!(thread.join().unwrap().as_deref(), Some("yes"));
    }
    #[test]
    fn prompt_answers_still_reject_embedded_newlines_nul_and_oversize() {
        let job = Job::new();
        let waiter = job.clone();
        let thread = std::thread::spawn(move || waiter.prompt("Code:".into(), false));
        while job.view().prompt.is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let id = job.view().prompt.unwrap().id;
        assert!(job.answer(&id, "12\n34".into()).is_err());
        assert!(job.answer(&id, "12\r34\n".into()).is_err());
        assert!(job.answer(&id, "12\u{0}34".into()).is_err());
        assert!(job.answer(&id, "a".repeat(8193)).is_err());
        assert!(job.answer(&id, format!("{}\n", "a".repeat(8193))).is_err());
        job.answer(&id, "a".repeat(8192)).unwrap();
        assert_eq!(thread.join().unwrap().map(|a| a.len()), Some(8192));
    }
    #[test]
    fn sso_approvals_get_five_minutes_and_the_client_outwaits_the_job() {
        assert_eq!(crate::ssh_askpass::PROMPT_WAIT, Duration::from_secs(300));
        assert_eq!(
            crate::ssh_askpass::CLIENT_READ_TIMEOUT,
            Duration::from_secs(310)
        );
    }

    // ---- process-level behaviour with a fake ssh -------------------------------
    fn fake_target() -> SshTarget {
        SshTarget {
            target: "mac-mini".into(),
            port: None,
            remote_port: 3774,
        }
    }
    /// A stand-in `ssh` script. It runs in its own process group and records its
    /// pid, so dropping the guard (also on panic or timeout) kills everything it
    /// started, and tests can assert nothing outlived the code under test.
    #[cfg(unix)]
    struct FakeSsh {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
        pid_file: std::path::PathBuf,
    }
    #[cfg(unix)]
    impl FakeSsh {
        fn new(body: &str) -> Self {
            use std::os::unix::fs::OpenOptionsExt;
            let dir =
                std::env::temp_dir().join(format!("monocode-fake-ssh-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("ssh");
            let pid_file = dir.join("pid");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o755)
                .open(&path)
                .unwrap();
            writeln!(
                file,
                "#!/bin/sh\necho $$ > '{}'\n{body}",
                pid_file.display()
            )
            .unwrap();
            drop(file);
            Self {
                dir,
                path,
                pid_file,
            }
        }
        fn command(&self, target: &SshTarget, interactive: bool) -> Command {
            use std::os::unix::process::CommandExt;
            let mut command = command_with_program(self.path.as_os_str(), target, interactive);
            command.process_group(0);
            command
        }
        /// The script is its group's leader; `None` if it never got to run.
        fn group(&self) -> Option<i32> {
            std::fs::read_to_string(&self.pid_file)
                .ok()?
                .trim()
                .parse()
                .ok()
        }
        fn group_is_gone(&self) -> bool {
            self.group().is_none_or(|pid| {
                // SAFETY: signal 0 only probes for existence.
                let probe = unsafe { libc::kill(-pid, 0) };
                probe != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            })
        }
        fn assert_no_leftover_processes(&self) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !self.group_is_gone() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(
                self.group_is_gone(),
                "fake ssh process group {:?} outlived the code under test",
                self.group()
            );
        }
    }
    #[cfg(unix)]
    impl Drop for FakeSsh {
        fn drop(&mut self) {
            if let Some(pid) = self.group() {
                // SAFETY: kills the process group this guard created, nothing else.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    #[cfg(unix)]
    #[test]
    fn the_fake_ssh_guard_detects_a_live_group_and_kills_it_on_drop() {
        let fake = FakeSsh::new("exec sleep 30");
        let mut child = fake.command(&fake_target(), false).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while fake.group().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let pid = fake.group().expect("the fake ssh recorded its pid");
        assert!(!fake.group_is_gone());
        drop(fake);
        child.wait().unwrap();
        // SAFETY: signal 0 only probes for existence.
        assert_ne!(unsafe { libc::kill(-pid, 0) }, 0);
    }
    #[cfg(unix)]
    const CHECK_MODE: &str = "printf '%s\\n' '# Tailscale SSH requires an additional check.' '# To authenticate, visit: https://login.tailscale.com/a/1a2b3c4d5e6f7' >&2";
    #[cfg(unix)]
    fn run_fake(body: &str, deadline: Duration) -> (Result<String, String>, Arc<Job>) {
        let fake = FakeSsh::new(body);
        let target = fake_target();
        let job = Job::new();
        let askpass = job.askpass().unwrap();
        let result = run_remote_command_with_deadline(
            &target,
            "true\n".into(),
            &job,
            &askpass,
            fake.command(&target, true),
            &["sh", "-l", "-s"],
            deadline,
        );
        fake.assert_no_leftover_processes();
        (result, job)
    }
    #[cfg(unix)]
    fn assert_no_url(text: &str) {
        assert!(!text.contains("http"), "{text}");
        assert!(!text.contains("tailscale.com/a"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn check_mode_failure_exposes_the_link_and_the_kind() {
        let (result, job) = run_fake(&format!("{CHECK_MODE}\nexit 255"), Duration::from_secs(10));
        let error = result.unwrap_err();
        assert_eq!(
            split_error_kind(&error).0,
            Some(SshErrorKind::NeedsInteractiveAuth)
        );
        assert_no_url(&error);
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
        job.complete(|| Err(error));
        let view = job.view();
        assert_eq!(view.error_kind.as_deref(), Some("needs-interactive-auth"));
        assert!(!view.error.unwrap().starts_with('['));
        assert_eq!(view.auth_url.as_deref(), Some(TAILSCALE_URL));
    }
    #[cfg(unix)]
    #[test]
    fn check_mode_link_is_exposed_even_when_ssh_then_succeeds() {
        let (result, job) = run_fake(
            &format!("{CHECK_MODE}\necho ready"),
            Duration::from_secs(10),
        );
        assert_eq!(result.unwrap().trim(), "ready");
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
    }
    #[cfg(unix)]
    #[test]
    fn a_failing_remote_script_is_not_blamed_on_the_earlier_sign_in() {
        let (result, _job) = run_fake(
            &format!("{CHECK_MODE}\necho 'disk full' >&2\nexit 1"),
            Duration::from_secs(10),
        );
        let error = result.unwrap_err();
        assert_eq!(split_error_kind(&error).0, Some(SshErrorKind::Unknown));
        assert!(error.contains("disk full"));
        assert_no_url(&error);
    }
    #[cfg(unix)]
    #[test]
    fn rejected_keys_fail_as_permission_denied() {
        let (result, job) = run_fake(
            "echo 'me@mac-mini: Permission denied (publickey).' >&2\nexit 255",
            Duration::from_secs(10),
        );
        let error = result.unwrap_err();
        assert_eq!(
            split_error_kind(&error).0,
            Some(SshErrorKind::PermissionDenied)
        );
        assert!(error.contains("Permission denied (publickey)"));
        assert_eq!(job.view().auth_url, None);
    }
    #[cfg(unix)]
    #[test]
    fn a_stalled_setup_times_out_at_the_deadline() {
        let started = Instant::now();
        let (result, _job) = run_fake("exec sleep 30", Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(20));
        let error = result.unwrap_err();
        assert_eq!(split_error_kind(&error).0, Some(SshErrorKind::Timeout));
        assert!(error.contains("SSH setup timed out"));
    }
    #[cfg(unix)]
    #[test]
    fn a_setup_waiting_for_approval_reports_the_sign_in_not_a_timeout() {
        let (result, job) = run_fake(
            &format!("{CHECK_MODE}\nexec sleep 30"),
            Duration::from_secs(10),
        );
        let error = result.unwrap_err();
        assert_eq!(
            split_error_kind(&error).0,
            Some(SshErrorKind::NeedsInteractiveAuth)
        );
        assert_no_url(&error);
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
    }
    #[test]
    fn a_missing_ssh_binary_is_reported_plainly() {
        let target = fake_target();
        let job = Job::new();
        let askpass = job.askpass().unwrap();
        let missing = std::env::temp_dir().join(format!("no-such-ssh-{}", uuid::Uuid::new_v4()));
        let error = run_remote_command_with_deadline(
            &target,
            String::new(),
            &job,
            &askpass,
            command_with_program(missing.as_os_str(), &target, true),
            &["true"],
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "[ssh:ssh-missing] OpenSSH (ssh) was not found on this computer"
        );
        let tunnel = Tunnel::start_with_deadline(
            &target,
            None,
            None,
            || command_with_program(missing.as_os_str(), &target, false),
            Duration::from_secs(5),
            PORT_SETTLE,
        )
        .err()
        .unwrap();
        assert_eq!(tunnel, error);
    }
    #[test]
    fn the_ssh_program_can_be_overridden_for_tests() {
        assert_eq!(ssh_program(None), std::ffi::OsString::from("ssh"));
        assert_eq!(
            ssh_program(Some("".into())),
            std::ffi::OsString::from("ssh")
        );
        assert_eq!(
            ssh_program(Some("/tmp/fake-ssh".into())),
            std::ffi::OsString::from("/tmp/fake-ssh")
        );
        let command =
            command_with_program(std::ffi::OsStr::new("/tmp/fake-ssh"), &fake_target(), false);
        assert_eq!(command.get_program(), "/tmp/fake-ssh");
    }

    #[cfg(unix)]
    fn start_fake_tunnel(
        body: &str,
        job: Option<&Arc<Job>>,
        deadline: Duration,
    ) -> Result<Tunnel, String> {
        let fake = FakeSsh::new(body);
        let target = fake_target();
        let askpass = job.map(|job| job.askpass().unwrap());
        let result = Tunnel::start_with_deadline(
            &target,
            job,
            askpass.as_ref(),
            || fake.command(&target, askpass.is_some()),
            deadline,
            PORT_SETTLE,
        );
        // A failed start must have killed and reaped its ssh.
        if result.is_err() {
            fake.assert_no_leftover_processes();
        }
        result
    }
    #[cfg(unix)]
    #[test]
    fn a_tunnel_that_dies_reports_what_ssh_said() {
        let error = start_fake_tunnel(
            "echo 'ssh: Could not resolve hostname mac-mini: nodename nor servname provided, or not known' >&2\nexit 255",
            None,
            Duration::from_secs(10),
        )
        .err()
        .unwrap();
        assert_eq!(split_error_kind(&error).0, Some(SshErrorKind::Dns));
        assert!(error.contains("Could not resolve hostname mac-mini"));
        assert!(error.contains("Settings"));
    }
    #[cfg(unix)]
    #[test]
    fn a_lazy_restore_blocked_by_check_mode_tells_the_user_to_reconnect() {
        let started = Instant::now();
        let error = start_fake_tunnel(
            &format!("{CHECK_MODE}\nexec sleep 30"),
            None,
            Duration::from_secs(10),
        )
        .err()
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(20));
        let (kind, message) = split_error_kind(&error);
        assert_eq!(kind, Some(SshErrorKind::NeedsInteractiveAuth));
        assert!(message.contains("Settings → Connections"));
        assert!(message.contains("Reconnect"));
        assert!(message.contains("additional check"));
        assert_no_url(&error);
    }
    #[cfg(unix)]
    #[test]
    fn a_lazy_restore_that_dies_in_check_mode_is_also_interactive() {
        let error = start_fake_tunnel(
            &format!(
                "{CHECK_MODE}\necho 'me@mac-mini: Permission denied (publickey).' >&2\nexit 255"
            ),
            None,
            Duration::from_secs(10),
        )
        .err()
        .unwrap();
        let (kind, message) = split_error_kind(&error);
        assert_eq!(kind, Some(SshErrorKind::NeedsInteractiveAuth));
        assert!(message.contains("Reconnect"));
        assert_no_url(&error);
    }
    #[cfg(unix)]
    #[test]
    fn a_setup_tunnel_waiting_for_approval_publishes_the_link() {
        let job = Job::new();
        let error = start_fake_tunnel(
            &format!("{CHECK_MODE}\nexec sleep 30"),
            Some(&job),
            Duration::from_secs(10),
        )
        .err()
        .unwrap();
        assert_eq!(
            split_error_kind(&error).0,
            Some(SshErrorKind::NeedsInteractiveAuth)
        );
        assert_no_url(&error);
        assert_eq!(job.view().auth_url.as_deref(), Some(TAILSCALE_URL));
    }

    // ---- SSO simulations: ssh prints a link, then waits until it is approved ---
    /// Holds the fake ssh until the test creates `approved` next to the script,
    /// like Tailscale or NetBird waiting for the browser sign-in.
    #[cfg(unix)]
    const AWAIT_APPROVAL: &str =
        "dir=$(dirname \"$0\")\nwhile [ ! -e \"$dir/approved\" ]; do sleep 0.05; done";
    #[cfg(unix)]
    const TAILSCALE_CHECK_MODE: &str = "printf '%s\\n' '# Tailscale SSH requires an additional check.' '# To authenticate, visit: https://login.tailscale.com/a/test' >&2";
    #[cfg(unix)]
    const NETBIRD_SSO: &str = "printf '%s\\n' 'Please do the SSO login in your browser.' \"If your browser didn't open automatically, use this URL to log in:\" '' 'https://login.netbird.io/device?user_code=ABCD-EFGH' >&2";
    /// Waits until the job publishes a sign-in link, then checks it is still
    /// waiting: the link must reach the UI before ssh finishes, not after.
    #[cfg(unix)]
    fn assert_waiting_with_link(
        job: &Job,
        waiter: &std::thread::JoinHandle<impl Sized>,
        url: &str,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while job.view().auth_url.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let view = job.view();
        assert_eq!(view.auth_url.as_deref(), Some(url));
        assert!(!view.done);
        assert!(!waiter.is_finished(), "ssh finished before approval");
        // What `remote_ssh_poll` hands the UI.
        assert_eq!(serde_json::to_value(&view).unwrap()["authUrl"], url);
    }
    /// Drives `run_remote_command`, the lowest level of the setup job that runs
    /// ssh: the full job also needs a real host to bootstrap and pair with.
    #[cfg(unix)]
    fn platform_probe_completes_after_approval(sign_in: &str, url: &str) {
        let fake = FakeSsh::new(&format!(
            "{sign_in}\n{AWAIT_APPROVAL}\ncat > /dev/null\necho 'MONOCODE_PLATFORM Linux'"
        ));
        let target = fake_target();
        let job = Job::new();
        let waiter = {
            let (job, target) = (job.clone(), target.clone());
            let command = fake.command(&target, true);
            std::thread::spawn(move || {
                let askpass = job.askpass().unwrap();
                run_remote_command(
                    &target,
                    String::new(),
                    &job,
                    &askpass,
                    command,
                    PLATFORM_PROBE,
                )
            })
        };
        assert_waiting_with_link(&job, &waiter, url);
        std::fs::write(fake.dir.join("approved"), "").unwrap();
        let output = waiter.join().unwrap().unwrap();
        assert_eq!(parse_platform(&output).unwrap(), HostPlatform::Unix);
        fake.assert_no_leftover_processes();
    }
    #[cfg(unix)]
    #[test]
    fn tailscale_check_mode_shows_the_link_while_waiting_and_completes_after_approval() {
        platform_probe_completes_after_approval(
            TAILSCALE_CHECK_MODE,
            "https://login.tailscale.com/a/test",
        );
    }
    #[cfg(unix)]
    #[test]
    fn netbird_sso_shows_the_link_while_waiting_and_completes_after_approval() {
        platform_probe_completes_after_approval(
            NETBIRD_SSO,
            "https://login.netbird.io/device?user_code=ABCD-EFGH",
        );
    }
    #[cfg(unix)]
    #[test]
    fn a_setup_tunnel_in_check_mode_opens_once_approved() {
        let fake = FakeSsh::new(&format!(
            "{RECORD_PORT}\n{TAILSCALE_CHECK_MODE}\n{AWAIT_APPROVAL}\n{LISTEN}"
        ));
        let target = fake_target();
        let job = Job::new();
        let waiter = {
            let (job, target) = (job.clone(), target.clone());
            let mut command = Some(fake.command(&target, true));
            std::thread::spawn(move || {
                let askpass = job.askpass().unwrap();
                Tunnel::start_with_deadline(
                    &target,
                    Some(&job),
                    Some(&askpass),
                    || command.take().expect("one attempt"),
                    Duration::from_secs(20),
                    PORT_SETTLE,
                )
            })
        };
        assert_waiting_with_link(&job, &waiter, "https://login.tailscale.com/a/test");
        std::fs::write(fake.dir.join("approved"), "").unwrap();
        let tunnel = waiter.join().unwrap().unwrap();
        assert!(TcpStream::connect(("127.0.0.1", tunnel.port)).is_ok());
        drop(tunnel);
        fake.assert_no_leftover_processes();
    }
    #[cfg(unix)]
    #[test]
    fn a_plain_readiness_timeout_keeps_its_wording_and_bounded_output() {
        let error = start_fake_tunnel(
            "head -c 5000 /dev/zero | tr '\\0' Q >&2\nexec sleep 30",
            None,
            Duration::from_secs(10),
        )
        .err()
        .unwrap();
        let (kind, message) = split_error_kind(&error);
        assert_eq!(kind, Some(SshErrorKind::Timeout));
        assert!(message.starts_with(
            "SSH timed out. Open Settings → Connections and reconnect to authenticate."
        ));
        assert_eq!(message.matches('Q').count(), 2000);
    }
    #[cfg(unix)]
    #[test]
    fn a_quiet_readiness_timeout_adds_no_empty_output_section() {
        let error = start_fake_tunnel("exec sleep 30", None, Duration::from_millis(300))
            .err()
            .unwrap();
        assert_eq!(
            error,
            "[ssh:timeout] SSH timed out. Open Settings → Connections and reconnect to authenticate."
        );
    }

    #[test]
    fn restore_failures_are_cached_with_their_kind() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let start = |_: &SshTarget| {
            calls.set(calls.get() + 1);
            Err::<Tunnel, String>("Address in use".into())
        };
        let now = Instant::now();
        let first = tunnels
            .endpoint_with("host", &fake_target(), now, start)
            .err()
            .unwrap();
        assert_eq!(first, "[ssh:unknown] Address in use");
        let second = tunnels
            .endpoint_with("host", &fake_target(), now, start)
            .err()
            .unwrap();
        assert_eq!(second, format!("{first} Retrying in 2 s."));
        assert_eq!(calls.get(), 1);
    }

    // ---- restart backoff, half-open tunnels and network changes ---------------
    #[test]
    fn backoff_doubles_from_two_seconds_up_to_a_minute() {
        let seconds: Vec<u64> = (0..9).map(|n| Backoff::delay(n).as_secs()).collect();
        assert_eq!(seconds, [0, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(Backoff::delay(u32::MAX), BACKOFF_MAX);
        assert_eq!(BACKOFF_FIRST, Duration::from_secs(2));
        assert_eq!(BACKOFF_MAX, Duration::from_secs(60));
    }
    #[test]
    fn backoff_counts_down_and_starts_over_after_a_reset() {
        let now = Instant::now();
        let mut backoff = Backoff::default();
        assert_eq!(backoff.remaining(now), None);
        assert_eq!(backoff.fail(now), Duration::from_secs(2));
        assert_eq!(backoff.remaining(now), Some(Duration::from_secs(2)));
        assert_eq!(
            backoff.remaining(now + Duration::from_millis(500)),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(backoff.remaining(now + Duration::from_secs(2)), None);
        assert_eq!(backoff.fail(now), Duration::from_secs(4));
        backoff.reset();
        assert_eq!(backoff.remaining(now), None);
        assert_eq!(backoff.fail(now), Duration::from_secs(2));
    }
    #[test]
    fn retry_hints_round_the_wait_up_to_whole_seconds() {
        assert_eq!(
            with_retry_hint("[ssh:dns] x", Duration::from_millis(1200)),
            "[ssh:dns] x Retrying in 2 s."
        );
        assert_eq!(
            with_retry_hint("[ssh:dns] x", Duration::from_millis(1)),
            "[ssh:dns] x Retrying in 1 s."
        );
    }

    fn failing_start(
        calls: &std::cell::Cell<u32>,
    ) -> impl Fn(&SshTarget) -> Result<Tunnel, String> + '_ {
        move |_| {
            calls.set(calls.get() + 1);
            Err(tag_error(SshErrorKind::Dns, "Could not resolve hostname"))
        }
    }
    #[test]
    fn restore_failures_back_off_exponentially() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let start = failing_start(&calls);
        let base = Instant::now();
        let first = tunnels
            .endpoint_with("host", &fake_target(), base, &start)
            .err()
            .unwrap();
        assert_eq!(first, "[ssh:dns] Could not resolve hostname");
        let cached = tunnels
            .endpoint_with(
                "host",
                &fake_target(),
                base + Duration::from_secs(1),
                &start,
            )
            .err()
            .unwrap();
        assert_eq!(cached, format!("{first} Retrying in 1 s."));
        assert_eq!(split_error_kind(&cached).0, Some(SshErrorKind::Dns));
        assert_eq!(calls.get(), 1);
        // Two seconds later the next attempt runs, and its failure waits four.
        let retry = base + Duration::from_secs(2);
        assert!(tunnels
            .endpoint_with("host", &fake_target(), retry, &start)
            .is_err());
        assert_eq!(calls.get(), 2);
        let cached = tunnels
            .endpoint_with("host", &fake_target(), retry, &start)
            .err()
            .unwrap();
        assert!(cached.ends_with("Retrying in 4 s."), "{cached}");
        assert_eq!(calls.get(), 2);
        // Other machines keep their own schedule.
        assert!(tunnels
            .endpoint_with("other", &fake_target(), retry, &start)
            .is_err());
        assert_eq!(calls.get(), 3);
    }
    #[cfg(unix)]
    #[test]
    fn a_successful_restart_resets_the_backoff() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let base = Instant::now();
        let fail = failing_start(&calls);
        for second in [0, 2, 6] {
            assert!(tunnels
                .endpoint_with(
                    "host",
                    &fake_target(),
                    base + Duration::from_secs(second),
                    &fail
                )
                .is_err());
        }
        assert_eq!(calls.get(), 3);
        // ssh comes up, then exits again: the next failure waits two seconds.
        let later = base + Duration::from_secs(14);
        tunnels
            .endpoint_with("host", &fake_target(), later, |_| {
                Ok(Tunnel::running_for_tests("exit 0"))
            })
            .unwrap();
        // Once the exited ssh is noticed, the restart runs and fails afresh.
        wait_until(|| {
            tunnels
                .endpoint_with("host", &fake_target(), later, &fail)
                .is_err()
        });
        assert_eq!(calls.get(), 4);
        let cached = tunnels
            .endpoint_with("host", &fake_target(), later, &fail)
            .err()
            .unwrap();
        assert!(cached.ends_with("Retrying in 2 s."), "{cached}");
    }
    #[cfg(unix)]
    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "condition never became true");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    #[test]
    fn an_explicit_reconnect_forgets_the_cached_failure() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let start = failing_start(&calls);
        let now = Instant::now();
        for id in ["host", "other"] {
            assert!(tunnels
                .endpoint_with(id, &fake_target(), now, &start)
                .is_err());
        }
        tunnels.forget_failures("host");
        let error = tunnels
            .endpoint_with("host", &fake_target(), now, &start)
            .err()
            .unwrap();
        assert!(!error.contains("Retrying"), "{error}");
        assert_eq!(calls.get(), 3);
        // Only the reconnected machine starts over.
        let other = tunnels
            .endpoint_with("other", &fake_target(), now, &start)
            .err()
            .unwrap();
        assert!(other.contains("Retrying"), "{other}");
        assert_eq!(calls.get(), 3);
    }
    #[cfg(unix)]
    #[test]
    fn an_exited_ssh_is_restarted_on_the_next_endpoint_call() {
        let tunnels = Tunnels::default();
        tunnels.insert("host".into(), Tunnel::running_for_tests("exit 0"));
        let restarted = std::cell::Cell::new(false);
        wait_until(|| {
            tunnels
                .endpoint_with("host", &fake_target(), Instant::now(), |_| {
                    restarted.set(true);
                    Ok(Tunnel::running_for_tests("exec sleep 60"))
                })
                .unwrap();
            restarted.get()
        });
        // The replacement is alive, so the next call reuses it.
        let lease = tunnels
            .endpoint_with("host", &fake_target(), Instant::now(), |_| {
                panic!("a live tunnel must be reused")
            })
            .unwrap();
        assert_eq!(lease.endpoint, "http://127.0.0.1:9");
    }
    #[cfg(unix)]
    #[test]
    fn three_stalled_requests_in_a_row_drop_the_tunnel() {
        let tunnels = Tunnels::default();
        tunnels.insert("host".into(), Tunnel::running_for_tests("exec sleep 60"));
        let lease = tunnels.endpoint("host", &fake_target()).unwrap();
        assert!(!tunnels.request_stalled("host", &lease));
        assert!(!tunnels.request_stalled("host", &lease));
        tunnels.request_succeeded("host", &lease);
        assert!(!tunnels.request_stalled("host", &lease));
        assert!(!tunnels.request_stalled("host", &lease));
        assert!(tunnels.has_tunnel("host"));
        assert!(tunnels.request_stalled("host", &lease));
        assert!(!tunnels.has_tunnel("host"));
        assert_eq!(STALL_LIMIT, 3);
    }
    #[cfg(unix)]
    #[test]
    fn stalls_through_a_replaced_tunnel_do_not_count() {
        let tunnels = Tunnels::default();
        tunnels.insert("host".into(), Tunnel::running_for_tests("exec sleep 60"));
        let old = tunnels.endpoint("host", &fake_target()).unwrap();
        tunnels.insert("host".into(), Tunnel::running_for_tests("exec sleep 60"));
        for _ in 0..5 {
            assert!(!tunnels.request_stalled("host", &old));
        }
        assert!(tunnels.has_tunnel("host"));
    }
    #[cfg(unix)]
    #[test]
    fn a_network_change_clears_every_backoff_and_drops_cached_tunnels() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let fail = failing_start(&calls);
        let now = Instant::now();
        assert!(tunnels
            .endpoint_with("down", &fake_target(), now, &fail)
            .is_err());
        tunnels.insert("up".into(), Tunnel::running_for_tests("exec sleep 60"));
        let lease = tunnels.endpoint("up", &fake_target()).unwrap();
        assert!(!tunnels.request_stalled("up", &lease));
        assert!(!tunnels.request_stalled("up", &lease));
        tunnels.network_changed();
        assert!(!tunnels.has_tunnel("up"));
        let error = tunnels
            .endpoint_with("down", &fake_target(), now, &fail)
            .err()
            .unwrap();
        assert!(!error.contains("Retrying"), "{error}");
        assert_eq!(calls.get(), 2);
        let started = std::cell::Cell::new(0);
        let lease = tunnels
            .endpoint_with("up", &fake_target(), now, |_| {
                started.set(started.get() + 1);
                Ok(Tunnel::running_for_tests("exec sleep 60"))
            })
            .unwrap();
        assert_eq!(started.get(), 1);
        // The stall count started over with the new tunnel.
        assert!(!tunnels.request_stalled("up", &lease));
        assert!(tunnels.has_tunnel("up"));
    }
    #[test]
    fn a_network_change_during_a_restart_discards_its_stale_failure() {
        let tunnels = Tunnels::default();
        let calls = std::cell::Cell::new(0);
        let now = Instant::now();
        // The change arrives while this machine's slot is locked for a restart;
        // it must neither block nor let the old network's failure stick.
        let error = tunnels
            .endpoint_with("host", &fake_target(), now, |_| {
                calls.set(calls.get() + 1);
                tunnels.network_changed();
                Err(tag_error(SshErrorKind::Timeout, "timed out"))
            })
            .err()
            .unwrap();
        assert_eq!(error, "[ssh:timeout] timed out");
        let start = failing_start(&calls);
        let error = tunnels
            .endpoint_with("host", &fake_target(), now, &start)
            .err()
            .unwrap();
        assert!(!error.contains("Retrying"), "{error}");
        assert_eq!(calls.get(), 2);
    }

    // ---- local port races ------------------------------------------------------
    #[test]
    fn forward_port_conflicts_are_recognised() {
        for text in [
            "bind [127.0.0.1]:50123: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 50123\nCould not request local forwarding.\n",
            "Could not request local forwarding.\n",
            "Error: ExitOnForwardFailure is set\n",
        ] {
            assert!(forward_port_taken(text), "{text}");
        }
        for text in [
            "",
            "me@mac-mini: Permission denied (publickey).\n",
            "Connection to mac-mini closed by remote host.\n",
        ] {
            assert!(!forward_port_taken(text), "{text}");
        }
    }
    #[test]
    fn reserved_ports_avoid_the_ones_already_tried() {
        let (listener, first) = reserve_port(&[]).unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), first);
        drop(listener);
        let (listener, second) = reserve_port(&[first]).unwrap();
        assert_ne!(second, first);
        assert_eq!(listener.local_addr().unwrap().port(), second);
    }
    /// Records each invocation's forwarded local port in `ports`, next to the script.
    #[cfg(unix)]
    const RECORD_PORT: &str = "dir=$(dirname \"$0\"); port=; prev=\nfor arg; do [ \"$prev\" = -L ] && port=$(echo \"$arg\" | cut -d: -f2); prev=$arg; done\necho \"$port\" >> \"$dir/ports\"";
    /// Listens on the forwarded port like a working tunnel would.
    #[cfg(unix)]
    const LISTEN: &str = r#"exec perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $ARGV[0], Listen => 5, ReuseAddr => 1) or die "bind: $!"; while (my $c = $s->accept) { close $c }' "$port""#;
    #[cfg(unix)]
    const PORT_TAKEN: &str = "echo \"bind [127.0.0.1]:$port: Address already in use\" >&2\necho \"channel_setup_fwd_listener_tcpip: cannot listen to port: $port\" >&2\necho 'Could not request local forwarding.' >&2\nexit 255";
    #[cfg(unix)]
    fn recorded_ports(fake: &FakeSsh) -> Vec<u16> {
        std::fs::read_to_string(fake.dir.join("ports"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.parse().unwrap())
            .collect()
    }
    #[cfg(unix)]
    fn start_tunnel_with(fake: &FakeSsh, settle: Duration) -> Result<Tunnel, String> {
        let target = fake_target();
        Tunnel::start_with_deadline(
            &target,
            None,
            None,
            || fake.command(&target, false),
            Duration::from_secs(10),
            settle,
        )
    }
    #[cfg(unix)]
    #[test]
    fn a_tunnel_whose_ssh_exits_right_after_the_port_opens_fails() {
        // Accepts the readiness probe, then dies like a dropped connection.
        let fake = FakeSsh::new(&format!(
            "{RECORD_PORT}\nexec perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => $ARGV[0], Listen => 5, ReuseAddr => 1) or die; $s->accept; print STDERR \"Connection to mac-mini closed by remote host.\\n\"; exit 255' \"$port\""
        ));
        let error = start_tunnel_with(&fake, Duration::from_secs(1))
            .err()
            .unwrap();
        assert!(error.contains("closed by remote host"), "{error}");
        assert!(error.contains("Settings"), "{error}");
        assert_eq!(recorded_ports(&fake).len(), 1);
        fake.assert_no_leftover_processes();
    }
    #[cfg(unix)]
    #[test]
    fn a_taken_local_port_is_retried_on_a_fresh_port() {
        let fake = FakeSsh::new(&format!(
            "{RECORD_PORT}\nif [ \"$(wc -l < \"$dir/ports\")\" -lt 2 ]; then\n{PORT_TAKEN}\nfi\n{LISTEN}"
        ));
        let tunnel = start_tunnel_with(&fake, PORT_SETTLE).unwrap();
        let ports = recorded_ports(&fake);
        assert_eq!(ports.len(), 2, "{ports:?}");
        assert_ne!(ports[0], ports[1]);
        assert_eq!(tunnel.port, ports[1]);
        assert!(TcpStream::connect(("127.0.0.1", tunnel.port)).is_ok());
        drop(tunnel);
        fake.assert_no_leftover_processes();
    }
    #[cfg(unix)]
    #[test]
    fn port_retries_are_bounded() {
        let fake = FakeSsh::new(&format!("{RECORD_PORT}\n{PORT_TAKEN}"));
        let error = start_tunnel_with(&fake, PORT_SETTLE).err().unwrap();
        assert!(error.contains("Address already in use"), "{error}");
        assert!(split_error_kind(&error).0.is_some(), "{error}");
        assert_eq!(recorded_ports(&fake).len(), PORT_ATTEMPTS);
        fake.assert_no_leftover_processes();
    }
    #[cfg(unix)]
    #[test]
    fn other_tunnel_failures_are_not_retried() {
        let fake = FakeSsh::new(&format!(
            "{RECORD_PORT}\necho 'me@mac-mini: Permission denied (publickey).' >&2\nexit 255"
        ));
        let error = start_tunnel_with(&fake, PORT_SETTLE).err().unwrap();
        assert_eq!(
            split_error_kind(&error).0,
            Some(SshErrorKind::PermissionDenied)
        );
        assert_eq!(recorded_ports(&fake).len(), 1);
    }

    // ---- noisy shells -----------------------------------------------------------
    #[test]
    fn json_replies_are_found_after_login_banners() {
        let output = "Welcome to Ubuntu 24.04 LTS\n * Documentation:  https://help.ubuntu.com\n\nLast login: Mon Oct  6 09:12:01 2026\n{\"port\":3774}\n";
        assert_eq!(last_json_object(output).unwrap()["port"], 3774);
    }
    #[test]
    fn json_replies_are_found_before_exit_hook_output() {
        let output = "{\"token\":\"abc\",\"environmentId\":\"env\"}\r\nlogout\r\nSaving session...completed.\r\n[1] Done\n";
        assert_eq!(last_json_object(output).unwrap()["token"], "abc");
    }
    #[test]
    fn json_replies_are_found_between_noise_on_both_sides() {
        let output = "motd {not json}\n[\"an\", \"array\"]\n  {\"port\": 4000}  \n42\n\"text\"\n{broken\nbye\n";
        assert_eq!(last_json_object(output).unwrap()["port"], 4000);
        // The last object wins, so a stale earlier reply cannot shadow it.
        assert_eq!(
            last_json_object("{\"port\":1}\n{\"port\":2}\n").unwrap()["port"],
            2
        );
    }
    #[test]
    fn output_without_a_json_object_has_no_reply() {
        for output in ["", "\n\n", "Welcome!\n", "[1,2]\n", "null\n", "{\"port\":"] {
            assert!(last_json_object(output).is_none(), "{output}");
        }
    }
    #[test]
    fn login_flag_rejections_are_recognised() {
        for stderr in [
            "sh: 0: Illegal option -l",
            "sh: -l: invalid option\nUsage:\tsh [GNU long option] [option] ...",
            "sh: invalid option -- 'l'",
            "/bin/sh: illegal option -- l",
        ] {
            let error = tag_error(
                SshErrorKind::Unknown,
                &format!("SSH setup failed: {stderr}"),
            );
            assert!(rejects_login_flag(&error), "{stderr}");
        }
        for error in [
            tag_error(SshErrorKind::Unknown, "SSH setup failed: disk full"),
            tag_error(
                SshErrorKind::Unknown,
                "SSH setup failed: tar: invalid option -- 'J'",
            ),
            // ssh itself failing is never a shell problem.
            tag_error(
                SshErrorKind::PermissionDenied,
                "SSH setup failed: sh: 0: Illegal option -l",
            ),
        ] {
            assert!(!rejects_login_flag(&error), "{error}");
        }
    }
    /// Counts invocations in `calls`, next to the script.
    #[cfg(unix)]
    const COUNT_CALLS: &str = "dir=$(dirname \"$0\")\necho called >> \"$dir/calls\"";
    #[cfg(unix)]
    fn calls(fake: &FakeSsh) -> usize {
        std::fs::read_to_string(fake.dir.join("calls"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    #[cfg(unix)]
    fn run_fake_script(fake: &FakeSsh) -> Result<String, String> {
        let target = fake_target();
        let job = Job::new();
        let askpass = job.askpass().unwrap();
        let result = run_unix_script(
            &target,
            "true\n".into(),
            &job,
            &askpass,
            || fake.command(&target, true),
            Duration::from_secs(10),
        );
        fake.assert_no_leftover_processes();
        result
    }
    #[cfg(unix)]
    #[test]
    fn a_shell_without_a_login_flag_gets_the_script_without_it() {
        let fake = FakeSsh::new(&format!(
            "{COUNT_CALLS}\nfor arg; do if [ \"$arg\" = -l ]; then echo 'sh: 0: Illegal option -l' >&2; exit 2; fi; done\ncat > /dev/null\necho '{{\"port\":4000}}'"
        ));
        let output = run_fake_script(&fake).unwrap();
        assert_eq!(last_json_object(&output).unwrap()["port"], 4000);
        assert_eq!(calls(&fake), 2);
    }
    #[cfg(unix)]
    #[test]
    fn other_setup_failures_are_not_run_twice() {
        let fake = FakeSsh::new(&format!(
            "{COUNT_CALLS}\ncat > /dev/null\necho 'disk full' >&2\nexit 1"
        ));
        let error = run_fake_script(&fake).unwrap_err();
        assert!(error.contains("disk full"), "{error}");
        assert_eq!(calls(&fake), 1);
    }
    #[cfg(unix)]
    #[test]
    fn a_shell_that_rejects_both_forms_reports_the_second_failure() {
        let fake = FakeSsh::new(&format!(
            "{COUNT_CALLS}\nfor arg; do if [ \"$arg\" = -l ]; then echo 'sh: 0: Illegal option -l' >&2; exit 2; fi; done\necho 'sh: 0: Illegal option -s' >&2\nexit 2"
        ));
        let error = run_fake_script(&fake).unwrap_err();
        assert!(error.contains("Illegal option -s"), "{error}");
        assert_eq!(calls(&fake), 2);
    }
    #[cfg(unix)]
    #[test]
    fn setup_output_survives_motd_noise_from_the_login_shell() {
        let fake = FakeSsh::new(
            "cat > /dev/null\nprintf '%s\\n' 'Welcome to Ubuntu 24.04 LTS' ' * Support: https://ubuntu.com/pro' '{\"port\":3999}' 'logout'",
        );
        let output = run_fake_script(&fake).unwrap();
        assert_eq!(last_json_object(&output).unwrap()["port"], 3999);
    }
}
