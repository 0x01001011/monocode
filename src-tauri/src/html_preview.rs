//! Serve HTML previews (artifacts and on-disk sites) from the `preview` scheme.
//!
//! Every preview root is registered under a random token, so a framed page can
//! only reach `preview://localhost/<token>/<path>` inside its own root. Pages
//! run in a sandboxed iframe without `allow-same-origin`: they may run scripts
//! and use the network, but their origin is opaque, so they cannot reach the
//! app's IPC, storage or DOM.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use tauri::{http, AppHandle, Emitter, Manager, State, UriSchemeResponder};

use crate::fs::expand_home;
use crate::session_store::{validate_id, SessionStore};

/// Tauri event carrying the token of a preview whose files changed.
pub const CHANGED_EVENT: &str = "monocode:preview-changed";

/// Sent with every preview response. Scripts, styles and CDNs over HTTPS stay
/// allowed; plain `http:` and `*` are excluded because on Windows they would
/// match the app's own `http://ipc.localhost` and `http://asset.localhost`.
const FRAME_CSP: &str = "default-src 'self' preview: http://preview.localhost https: data: blob: 'unsafe-inline' 'unsafe-eval'; \
connect-src 'self' preview: http://preview.localhost https: wss: data: blob:; \
frame-src 'self' preview: http://preview.localhost https: data: blob:; \
object-src 'none'; base-uri 'self' preview: http://preview.localhost; form-action 'self' https:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewRoot {
    Dir(PathBuf),
    Artifact(String),
}

#[derive(Default)]
pub struct PreviewRegistry {
    roots: Mutex<HashMap<String, PreviewRoot>>,
}

impl PreviewRegistry {
    /// Directories are canonicalized once here, so later lookups compare
    /// resolved paths against a fixed, symlink-free root.
    pub fn register(&self, root: PreviewRoot) -> Result<String, String> {
        let root = match root {
            PreviewRoot::Dir(dir) => {
                let dir = dir
                    .canonicalize()
                    .map_err(|_| "Preview folder was not found".to_string())?;
                if !dir.is_dir() {
                    return Err("Preview root must be a folder".into());
                }
                PreviewRoot::Dir(dir)
            }
            artifact => artifact,
        };
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(token.clone(), root);
        Ok(token)
    }

    pub fn remove(&self, token: &str) {
        self.lock().remove(token);
    }

    fn get(&self, token: &str) -> Option<PreviewRoot> {
        self.lock().get(token).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PreviewRoot>> {
        self.roots.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Answer one `preview://localhost/<token>/<path>` request.
pub fn serve(
    registry: &PreviewRegistry,
    path: &str,
    artifact_body: impl Fn(&str) -> Option<String>,
) -> http::Response<Vec<u8>> {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let path = path.trim_start_matches('/');
    let (token, rel) = path.split_once('/').unwrap_or((path, ""));
    match registry.get(token) {
        Some(PreviewRoot::Dir(root)) => match resolve(&root, rel) {
            Some(file) => match std::fs::read(&file) {
                Ok(body) => respond(200, mime_type(&file), body),
                Err(_) => not_found(),
            },
            None => not_found(),
        },
        Some(PreviewRoot::Artifact(id)) if rel.is_empty() || rel == "index.html" => {
            match artifact_body(&id) {
                Some(body) => respond(200, "text/html; charset=utf-8", body.into_bytes()),
                None => not_found(),
            }
        }
        _ => not_found(),
    }
}

/// Map a percent-encoded relative path to a file inside `root`, or `None`.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(rel).decode_utf8().ok()?;
    if decoded.contains(['\0', '\\']) {
        return None;
    }
    let mut path = root.to_path_buf();
    for part in decoded
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        // Rejects `..`, roots and Windows drive prefixes such as `C:`.
        let mut components = Path::new(part).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => path.push(name),
            _ => return None,
        }
    }
    if path.is_dir() {
        path.push("index.html");
    }
    // Canonicalizing resolves symlinks, so a link pointing outside fails here.
    let resolved = path.canonicalize().ok()?;
    (resolved.starts_with(root) && resolved.is_file()).then_some(resolved)
}

fn mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn not_found() -> http::Response<Vec<u8>> {
    respond(404, "text/plain; charset=utf-8", b"Not found".to_vec())
}

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", FRAME_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        // Opaque-origin frames send CORS requests for module scripts and fetch.
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap_or_default()
}

/// Quiet time after the last write before a preview reloads.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// A steady stream of writes still reloads after this many windows.
const MAX_DEBOUNCE_WINDOWS: u32 = 10;

/// Watches the folders behind open previews and reports their tokens once per
/// debounced burst of changes.
pub struct PreviewWatcher {
    shared: Arc<WatchShared>,
}

struct WatchShared {
    watcher: Mutex<RecommendedWatcher>,
    roots: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl PreviewWatcher {
    pub fn new(on_change: impl Fn(&str) + Send + 'static) -> Result<Self, String> {
        let roots: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
        let (tx, rx) = channel::<String>();
        let handler_roots = roots.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let roots = handler_roots.lock().unwrap_or_else(|p| p.into_inner());
            for (token, root) in roots.iter() {
                if event
                    .paths
                    .iter()
                    .any(|path| path.starts_with(root) && !is_ignored(root, path))
                {
                    let _ = tx.send(token.clone());
                }
            }
        })
        .map_err(|err| err.to_string())?;
        let dispatch_roots = roots.clone();
        std::thread::Builder::new()
            .name("html-preview-watch".into())
            .spawn(move || {
                // Ends when the watcher (and with it the sender) is dropped.
                while let Ok(first) = rx.recv() {
                    let mut tokens = HashSet::from([first]);
                    let started = Instant::now();
                    while started.elapsed() < DEBOUNCE * MAX_DEBOUNCE_WINDOWS {
                        match rx.recv_timeout(DEBOUNCE) {
                            Ok(token) => {
                                tokens.insert(token);
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    for token in tokens {
                        // Late events for a closed preview are dropped here.
                        let live = dispatch_roots
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .contains_key(&token);
                        if live {
                            on_change(&token);
                        }
                    }
                }
            })
            .map_err(|err| err.to_string())?;
        Ok(Self {
            shared: Arc::new(WatchShared {
                watcher: Mutex::new(watcher),
                roots,
            }),
        })
    }

    pub fn watch(&self, token: &str, dir: &Path) -> Result<(), String> {
        // Events arrive with resolved paths (`/private/var` on macOS).
        let dir = dir.canonicalize().map_err(|err| err.to_string())?;
        let mut roots = self.shared.lock_roots();
        if !roots.values().any(|root| root == &dir) {
            self.shared
                .lock_watcher()
                .watch(&dir, RecursiveMode::Recursive)
                .map_err(|err| err.to_string())?;
        }
        roots.insert(token.to_string(), dir);
        Ok(())
    }

    pub fn unwatch(&self, token: &str) {
        let mut roots = self.shared.lock_roots();
        let Some(dir) = roots.remove(token) else {
            return;
        };
        if !roots.values().any(|root| root == &dir) {
            let _ = self.shared.lock_watcher().unwatch(&dir);
        }
    }
}

impl WatchShared {
    fn lock_roots(&self) -> std::sync::MutexGuard<'_, HashMap<String, PathBuf>> {
        self.roots.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_watcher(&self) -> std::sync::MutexGuard<'_, RecommendedWatcher> {
        self.watcher.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Dependency and VCS churn inside a previewed folder never reloads the page.
fn is_ignored(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|rel| {
        rel.components()
            .any(|part| matches!(part.as_os_str().to_str(), Some(".git" | "node_modules")))
    })
}

/// What a preview frame shows: a folder (sites resolve relative links inside
/// it) or one stored HTML artifact.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PreviewSource {
    Dir { path: String },
    Artifact { id: String },
}

pub struct PreviewState {
    registry: PreviewRegistry,
    /// `None` when the OS watcher could not start; previews still render and
    /// the reload button keeps working.
    watcher: Option<PreviewWatcher>,
}

pub fn init(app: &AppHandle) {
    let handle = app.clone();
    let watcher = match PreviewWatcher::new(move |token| {
        let _ = handle.emit(CHANGED_EVENT, token);
    }) {
        Ok(watcher) => Some(watcher),
        Err(err) => {
            eprintln!("monocode: html preview watcher unavailable: {err}");
            None
        }
    };
    app.manage(PreviewState {
        registry: PreviewRegistry::default(),
        watcher,
    });
}

#[tauri::command(async)]
pub fn preview_open(
    state: State<'_, PreviewState>,
    source: PreviewSource,
) -> Result<String, String> {
    match source {
        PreviewSource::Dir { path } => {
            let dir = expand_home(&path);
            let token = state.registry.register(PreviewRoot::Dir(dir.clone()))?;
            if let Some(watcher) = &state.watcher {
                if let Err(err) = watcher.watch(&token, &dir) {
                    eprintln!("monocode: html preview watch failed: {err}");
                }
            }
            Ok(token)
        }
        PreviewSource::Artifact { id } => {
            validate_id(&id, "artifact")?;
            state.registry.register(PreviewRoot::Artifact(id))
        }
    }
}

#[tauri::command(async)]
pub fn preview_close(state: State<'_, PreviewState>, token: String) {
    if let Some(watcher) = &state.watcher {
        watcher.unwatch(&token);
    }
    state.registry.remove(&token);
}

/// `preview://` handler. Files are read off the webview thread, which is the
/// main thread on macOS.
pub fn handle_request(
    app: &AppHandle,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = app.clone();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreviewState>();
        let response = serve(&state.registry, &path, |id| artifact_html(&app, id));
        responder.respond(response);
    });
}

fn artifact_html(app: &AppHandle, id: &str) -> Option<String> {
    let store = app.try_state::<SessionStore>()?;
    let conn = store.lock_conn().ok()?;
    crate::artifacts::html_body(&conn, id)
}

#[cfg(test)]
#[path = "html_preview_spec.rs"]
mod spec;
