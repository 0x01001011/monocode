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

/// Attribute that marks the injected script, so it is never added twice.
const BOOTSTRAP_MARKER: &str = "data-monocode-preview";

/// Runs first in every HTML page and talks to the host app over `postMessage`.
/// The page has an opaque origin, so the host can learn nothing about it
/// otherwise. The channel nonce is the frame's `window.name`, which the host
/// sets and which survives in-frame navigation; outside a MonoCode frame the
/// script does nothing. Messages are untrusted input on the host side.
const BOOTSTRAP: &str = concat!(
    "<script data-monocode-preview>",
    "(function(){var n=window.name;",
    "if(typeof n!==\"string\"||n.slice(0,3)!==\"mc:\")return;",
    "function send(m){m.mcp=1;m.n=n;try{parent.postMessage(m,\"*\")}catch(e){}}",
    "window.addEventListener(\"keydown\",function(e){",
    "if(e.key!==\"Escape\")return;",
    // This listener runs before the page's own, so wait until dispatch is
    // over: a page that handled Escape (preventDefault) keeps it.
    "setTimeout(function(){if(!e.defaultPrevented)send({type:\"escape\"})},0)});",
    // On window, so it runs after the page's own click handlers and a page
    // that handled the click (preventDefault) keeps it. Links to the preview's
    // own origin are the page's business; web and mail links go to the host,
    // because a sandboxed frame cannot open them and the app's CSP would turn
    // the navigation into a dead frame.
    "window.addEventListener(\"click\",function(e){",
    "if(e.defaultPrevented)return;",
    "var t=e.target,a=t&&t.closest?t.closest(\"a[href]\"):null;if(!a)return;",
    "var u;try{u=new URL(a.href)}catch(x){return}",
    "if(u.protocol!==\"https:\"&&u.protocol!==\"http:\"&&u.protocol!==\"mailto:\")return;",
    "if(u.origin===location.origin)return;",
    "e.preventDefault();send({type:\"open\",url:u.href})});",
    // Console output, uncaught errors and rejections, so the app can show the
    // page's problems and an agent can read them. Capped per page load; the
    // page's own console still gets every call.
    "var cap=0;",
    "function say(l,t){cap++;if(cap>301)return;",
    "if(cap===301){send({type:\"console\",level:\"warn\",text:\"(console output truncated)\"});return}",
    "send({type:\"console\",level:l,text:String(t).slice(0,2000)})}",
    "function fmt(v){if(typeof v===\"string\")return v;",
    "if(v instanceof Error)return(v.name||\"Error\")+\": \"+v.message;",
    "try{var j=JSON.stringify(v);if(j!==undefined)return j}catch(x){}",
    "try{return String(v)}catch(x){return\"[unprintable]\"}}",
    "[\"log\",\"info\",\"warn\",\"error\",\"debug\"].forEach(function(k){var o=console[k];",
    "if(typeof o!==\"function\")return;",
    "console[k]=function(){try{say(k,Array.prototype.map.call(arguments,fmt).join(\" \"))}catch(x){}",
    "return o.apply(console,arguments)}});",
    // Some engines (WebKit) hide the details of uncaught errors in sandboxed
    // pages and report only "Script error."; say so instead of leaving a riddle.
    "window.addEventListener(\"error\",function(e){var m=e.message||\"Error\";",
    "if(m===\"Script error.\")m+=\" (this browser hides the details of uncaught errors in sandboxed pages)\";",
    "say(\"error\",m+(e.filename?\" (\"+String(e.filename).split(\"/\").pop()+\":\"+e.lineno+\")\":\"\"))});",
    "window.addEventListener(\"unhandledrejection\",function(e){say(\"error\",\"Unhandled rejection: \"+fmt(e.reason))});",
    // Scroll position, so a reload can return to it: the host sends 'restore'
    // to the new page, applied as soon as it can take effect and once layout
    // has settled. Only the host (the parent window) may ask.
    "var st=0,sx=0,sy=0;",
    "window.addEventListener(\"scroll\",function(){sx=window.scrollX|0;sy=window.scrollY|0;if(st)return;",
    "st=setTimeout(function(){st=0;send({type:\"scroll\",x:sx,y:sy})},120)},{passive:true});",
    "var want=null;function apply(){if(want)window.scrollTo(want.x,want.y)}",
    "window.addEventListener(\"message\",function(e){var d=e.data;",
    "if(e.source!==parent||!d||d.mcp!==1||d.n!==n||d.type!==\"restore\")return;",
    "want={x:+d.x||0,y:+d.y||0};apply()});",
    "document.addEventListener(\"DOMContentLoaded\",apply);",
    "window.addEventListener(\"load\",function(){apply();want=null});",
    // The frame may not use the clipboard itself, so navigator.clipboard.writeText
    // asks the host, which writes only after a real click or key press.
    "try{Object.defineProperty(navigator,\"clipboard\",{configurable:true,value:{",
    "writeText:function(t){send({type:\"copy\",text:String(t).slice(0,100000)});return Promise.resolve()}}})}catch(x){}",
    // The page's content height, for fitting small pages. The root element's
    // own box is used: scrollHeight is never less than the viewport, so a short
    // page could not say it is short. Reports only changes, on the next frame.
    "var hv=-1,hq=0;",
    "function hrep(){hq=0;var d=document.documentElement,b=document.body;",
    "var h=Math.ceil(Math.max(d?d.getBoundingClientRect().height:0,b?b.scrollHeight:0));",
    "if(h!==hv){hv=h;send({type:\"height\",h:h})}}",
    "function hqueue(){if(!hq)hq=requestAnimationFrame(hrep)}",
    "document.addEventListener(\"DOMContentLoaded\",function(){",
    "if(window.ResizeObserver){var ro=new ResizeObserver(hqueue);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}",
    "if(window.MutationObserver&&document.body)new MutationObserver(hqueue).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});",
    "hqueue()});",
    "window.addEventListener(\"load\",hqueue);window.addEventListener(\"resize\",hqueue);",
    "send({type:\"ready\"})",
    "})();</script>"
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewRoot {
    Dir(PathBuf),
    Artifact(String),
    /// One page held in memory, e.g. a file read from a connected machine,
    /// which has no local folder to serve. `update_page` swaps its markup.
    Page(String),
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
            other => other,
        };
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(token.clone(), root);
        Ok(token)
    }

    /// Replace the markup of an in-memory page; false for any other root.
    pub fn update_page(&self, token: &str, html: String) -> bool {
        match self.lock().get_mut(token) {
            Some(PreviewRoot::Page(current)) => {
                *current = html;
                true
            }
            _ => false,
        }
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
#[cfg(test)]
pub fn serve(
    registry: &PreviewRegistry,
    path: &str,
    artifact_body: impl Fn(&str) -> Option<String>,
) -> http::Response<Vec<u8>> {
    serve_with_file(registry, path, artifact_body).0
}

/// Like `serve`, and also reports the token and file read from a folder, so the
/// watcher can follow exactly the files a page loads.
pub fn serve_with_file(
    registry: &PreviewRegistry,
    path: &str,
    artifact_body: impl Fn(&str) -> Option<String>,
) -> (http::Response<Vec<u8>>, Option<(String, PathBuf)>) {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let path = path.trim_start_matches('/');
    let (token, rel) = path.split_once('/').unwrap_or((path, ""));
    match registry.get(token) {
        Some(PreviewRoot::Dir(root)) => match resolve(&root, rel) {
            Some(file) => match std::fs::read(&file) {
                Ok(body) => {
                    let mime = mime_type(&file);
                    let body = if mime.starts_with("text/html") {
                        bootstrapped(body)
                    } else {
                        body
                    };
                    (respond(200, mime, body), Some((token.to_string(), file)))
                }
                Err(_) => (not_found(), None),
            },
            None => (not_found(), None),
        },
        Some(PreviewRoot::Artifact(id)) if rel.is_empty() || rel == "index.html" => {
            match artifact_body(&id) {
                Some(body) => (
                    respond(
                        200,
                        "text/html; charset=utf-8",
                        with_bootstrap(&body).into_bytes(),
                    ),
                    None,
                ),
                None => (not_found(), None),
            }
        }
        Some(PreviewRoot::Page(html)) if rel.is_empty() || rel == "index.html" => (
            respond(
                200,
                "text/html; charset=utf-8",
                with_bootstrap(&html).into_bytes(),
            ),
            None,
        ),
        _ => (not_found(), None),
    }
}

/// Put the bootstrap where it runs before author scripts without disturbing
/// the document: after `<head>`, else `<html>`, else after the doctype (which
/// must stay first or the page falls into quirks mode), else at the start.
fn with_bootstrap(html: &str) -> String {
    if html.contains(BOOTSTRAP_MARKER) {
        return html.to_string();
    }
    let at = bootstrap_offset(html);
    format!("{}{}{}", &html[..at], BOOTSTRAP, &html[at..])
}

fn bootstrap_offset(html: &str) -> usize {
    // ASCII lowercasing keeps every byte offset valid for slicing `html`.
    let lower = html.to_ascii_lowercase();
    let comments = comment_ranges(&lower);
    let in_comment = |at: usize| comments.iter().any(|&(start, end)| at >= start && at < end);
    for tag in ["<head", "<html"] {
        let mut from = 0;
        while let Some(found) = lower[from..].find(tag) {
            let start = from + found;
            from = start + tag.len();
            let boundary = lower[from..]
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c == '/' || c.is_ascii_whitespace());
            if boundary && !in_comment(start) {
                if let Some(end) = lower[start..].find('>') {
                    return start + end + 1;
                }
            }
        }
    }
    let leading = lower.len() - lower.trim_start().len();
    if lower[leading..].starts_with("<!doctype") {
        if let Some(end) = lower[leading..].find('>') {
            return leading + end + 1;
        }
    }
    0
}

fn comment_ranges(lower: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<!--") {
        let start = from + found;
        let end = lower[start + 4..]
            .find("-->")
            .map_or(lower.len(), |close| start + 4 + close + 3);
        ranges.push((start, end));
        from = end;
    }
    ranges
}

/// HTML documents get the bootstrap; text that is not valid UTF-8 is left
/// alone rather than corrupted.
fn bootstrapped(body: Vec<u8>) -> Vec<u8> {
    match String::from_utf8(body) {
        Ok(html) => with_bootstrap(&html).into_bytes(),
        Err(error) => error.into_bytes(),
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

/// Watches the files behind open previews and reports their tokens once per
/// debounced burst of changes.
///
/// A token follows exactly the files its page loaded (`watch_file`). An
/// `index.html` at a repository root must not put a watch on every directory of
/// the tree, and saving an unrelated file must not reload the page.
pub struct PreviewWatcher {
    shared: Arc<WatchShared>,
}

#[derive(Default)]
struct WatchState {
    /// Files each token's page loaded; their folders are watched non-recursively.
    files: HashMap<String, HashSet<PathBuf>>,
    /// Folders registered with the OS for `files`.
    file_dirs: HashSet<PathBuf>,
}

struct WatchShared {
    watcher: Mutex<RecommendedWatcher>,
    state: Arc<Mutex<WatchState>>,
}

impl PreviewWatcher {
    pub fn new(on_change: impl Fn(&str) + Send + 'static) -> Result<Self, String> {
        let state: Arc<Mutex<WatchState>> = Arc::default();
        let (tx, rx) = channel::<String>();
        let handler_state = state.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let state = handler_state.lock().unwrap_or_else(|p| p.into_inner());
            for (token, files) in state.files.iter() {
                if event.paths.iter().any(|path| files.contains(path)) {
                    let _ = tx.send(token.clone());
                }
            }
        })
        .map_err(|err| err.to_string())?;
        let dispatch_state = state.clone();
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
                        let live = {
                            let state = dispatch_state.lock().unwrap_or_else(|p| p.into_inner());
                            state.files.contains_key(&token)
                        };
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
                state,
            }),
        })
    }

    /// Follow one file a page loaded. Registers its folder once, non-recursively.
    pub fn watch_file(&self, token: &str, file: &Path) -> Result<(), String> {
        let file = file.canonicalize().map_err(|err| err.to_string())?;
        let dir = file
            .parent()
            .map(Path::to_path_buf)
            .ok_or("File has no folder")?;
        let needs_watch = {
            let mut state = self.shared.lock_state();
            let covered = state.file_dirs.contains(&dir);
            state
                .files
                .entry(token.to_string())
                .or_default()
                .insert(file.clone());
            !covered
        };
        if needs_watch {
            // The state lock is released first: the event handler takes it, and
            // some backends wait on their event thread while registering.
            let result = self
                .shared
                .lock_watcher()
                .watch(&dir, RecursiveMode::NonRecursive);
            match result {
                Ok(()) => {
                    self.shared.lock_state().file_dirs.insert(dir);
                }
                Err(err) => {
                    if let Some(files) = self.shared.lock_state().files.get_mut(token) {
                        files.remove(&file);
                    }
                    return Err(err.to_string());
                }
            }
        }
        Ok(())
    }

    /// Folders currently registered with the OS.
    #[cfg(test)]
    pub fn watched_dirs(&self) -> usize {
        self.shared.lock_state().file_dirs.len()
    }

    pub fn unwatch(&self, token: &str) {
        let release: Vec<PathBuf> = {
            let mut state = self.shared.lock_state();
            state.files.remove(token);
            let used: HashSet<PathBuf> = state
                .files
                .values()
                .flatten()
                .filter_map(|file| file.parent().map(Path::to_path_buf))
                .collect();
            let unused: Vec<PathBuf> = state
                .file_dirs
                .iter()
                .filter(|dir| !used.contains(*dir))
                .cloned()
                .collect();
            for dir in &unused {
                state.file_dirs.remove(dir);
            }
            unused
        };
        let mut watcher = self.shared.lock_watcher();
        for dir in release {
            let _ = watcher.unwatch(&dir);
        }
    }
}

impl WatchShared {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, WatchState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_watcher(&self) -> std::sync::MutexGuard<'_, RecommendedWatcher> {
        self.watcher.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// What a preview frame shows: a folder (sites resolve relative links inside
/// it) or one stored HTML artifact.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PreviewSource {
    Dir { path: String },
    Artifact { id: String },
    /// A page the app already holds, such as a file on a connected machine.
    Html { html: String },
}

/// Larger than any file the app opens as text, so a read page always fits.
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

fn checked_page(html: String) -> Result<String, String> {
    if html.len() > MAX_PAGE_BYTES {
        return Err("This page is too large to preview".into());
    }
    Ok(html)
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
            // No watch yet: the scheme handler follows each file the page loads.
            state
                .registry
                .register(PreviewRoot::Dir(expand_home(&path)))
        }
        PreviewSource::Artifact { id } => {
            validate_id(&id, "artifact")?;
            state.registry.register(PreviewRoot::Artifact(id))
        }
        PreviewSource::Html { html } => state
            .registry
            .register(PreviewRoot::Page(checked_page(html)?)),
    }
}

/// Show new markup in an open `Html` preview; its frame then reloads.
#[tauri::command(async)]
pub fn preview_update(
    state: State<'_, PreviewState>,
    token: String,
    html: String,
) -> Result<(), String> {
    if state.registry.update_page(&token, checked_page(html)?) {
        Ok(())
    } else {
        Err("Preview is not open".into())
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
        let (response, served) =
            serve_with_file(&state.registry, &path, |id| artifact_html(&app, id));
        if let (Some((token, file)), Some(watcher)) = (served, &state.watcher) {
            if let Err(err) = watcher.watch_file(&token, &file) {
                eprintln!("monocode: html preview watch failed: {err}");
            }
        }
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

#[cfg(test)]
mod page_tests {
    use super::*;

    fn no_artifacts(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_page_is_served_with_the_bootstrap_and_can_be_updated() {
        let registry = PreviewRegistry::default();
        let token = registry
            .register(PreviewRoot::Page("<html><head></head><h1>One</h1></html>".into()))
            .unwrap();
        for rel in ["", "index.html"] {
            let response = serve(&registry, &format!("/{token}/{rel}"), no_artifacts);
            assert_eq!(response.status(), 200);
            let body = String::from_utf8(response.body().clone()).unwrap();
            assert!(body.contains("<h1>One</h1>") && body.contains(BOOTSTRAP_MARKER));
        }
        assert!(registry.update_page(&token, "<h1>Two</h1>".into()));
        let body = serve(&registry, &format!("/{token}/"), no_artifacts).into_body();
        assert!(String::from_utf8(body).unwrap().contains("<h1>Two</h1>"));
    }

    #[test]
    fn a_page_serves_nothing_else_and_only_pages_update() {
        let registry = PreviewRegistry::default();
        let token = registry.register(PreviewRoot::Page("<p>x</p>".into())).unwrap();
        assert_eq!(
            serve(&registry, &format!("/{token}/secret.txt"), no_artifacts).status(),
            404
        );
        let artifact = registry.register(PreviewRoot::Artifact("a".into())).unwrap();
        assert!(!registry.update_page(&artifact, "<p>y</p>".into()));
        assert!(!registry.update_page("missing", "<p>y</p>".into()));
    }

    #[test]
    fn an_oversized_page_is_refused() {
        assert!(checked_page("x".repeat(MAX_PAGE_BYTES + 1)).is_err());
        assert!(checked_page("x".repeat(MAX_PAGE_BYTES)).is_ok());
    }
}
