//! Watches skill roots and tells the frontend when the local catalog changed.
//!
//! Filesystem events are debounced, then the skills revision is bumped and a
//! `skills-changed` event is emitted. Every failure degrades to a log line:
//! without a watcher the catalog is simply refreshed the old way.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dirs_home;
use crate::fs::expand_home;
use crate::skills::{bump_revision, PROVIDER_SKILL_DIRS};

/// Debounce between the last filesystem event and the `skills-changed` event.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// A steady stream of events still flushes after this many debounce windows.
const MAX_DEBOUNCE_WINDOWS: u32 = 10;
/// Bounds the watches opened on behalf of projects the user has browsed.
const MAX_PROJECT_ROOTS: usize = 256;

#[derive(Serialize, Clone)]
struct SkillsChanged {
    revision: u64,
}

/// Roots `list_skills` scans under the home directory.
fn user_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![home.join(".agents/skills")];
    roots.extend(PROVIDER_SKILL_DIRS.iter().map(|(dir, _)| home.join(dir)));
    roots.push(home.join(".pi/agent/skills"));
    roots.push(home.join(".omp/agent/skills"));
    roots.push(home.join(".gemini/antigravity/skills"));
    // Plugin skill roots come from installed_plugins.json, so its directory is
    // watched non-recursively instead of the whole plugin cache.
    roots.push(home.join(".claude/plugins"));
    roots
}

/// Roots `list_skills` scans under a project directory.
fn project_roots(project: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project.join(".agents/skills")];
    roots.extend(PROVIDER_SKILL_DIRS.iter().map(|(dir, _)| project.join(dir)));
    roots
}

/// Canonicalizes the nearest existing ancestor and re-appends the rest, so a
/// root that does not exist yet still compares equal to event paths (macOS
/// reports `/private/var/...` for `/var/...`).
fn canonical_form(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if let Ok(canon) = std::fs::canonicalize(current) {
            return missing.iter().rev().fold(canon, |acc, part| acc.join(part));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_os_string());
                current = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn nearest_existing_dir(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf)
}

struct Shared {
    watcher: Mutex<RecommendedWatcher>,
    state: Arc<Mutex<WatchState>>,
}

#[derive(Default)]
struct WatchState {
    /// Every root asked for, in raw and canonical spelling, for event filtering.
    roots: HashSet<PathBuf>,
    /// Raw roots in request order, so they can be re-checked on change.
    requested: Vec<PathBuf>,
    /// Paths with an active OS watch, and whether it is recursive.
    watched: HashSet<(PathBuf, bool)>,
}

impl WatchState {
    fn is_relevant(&self, path: &Path) -> bool {
        self.roots
            .iter()
            .any(|root| path.starts_with(root) || root.starts_with(path))
    }
}

impl Shared {
    /// Existing roots get a recursive watch. Missing roots fall back to their
    /// nearest existing ancestor (non-recursive) so creation is noticed, and
    /// are upgraded by the next call once they exist.
    fn apply(&self, roots: &[PathBuf]) {
        let targets: Vec<(PathBuf, bool)> = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            for root in roots {
                if !state.requested.contains(root) {
                    state.requested.push(root.clone());
                }
                state.roots.insert(root.clone());
                state.roots.insert(canonical_form(root));
            }
            state
                .requested
                .iter()
                .filter_map(|root| {
                    if root.is_dir() {
                        // The plugins directory holds whole plugin caches; only
                        // its registry file matters.
                        Some((root.clone(), !root.ends_with(".claude/plugins")))
                    } else {
                        nearest_existing_dir(root).map(|ancestor| (ancestor, false))
                    }
                })
                .filter(|target| !state.watched.contains(target))
                .collect()
        };
        // The state lock is released before talking to the OS: the event
        // handler takes it, and some backends wait on their event thread.
        for (target, recursive) in targets {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            let result = self
                .watcher
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .watch(&target, mode);
            match result {
                Ok(()) => {
                    self.state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .watched
                        .insert((target, recursive));
                }
                Err(err) => eprintln!("monocode: skills watch {}: {err}", target.display()),
            }
        }
    }
}

pub(crate) struct SkillsWatcher {
    shared: Arc<Shared>,
}

impl SkillsWatcher {
    /// `on_change` runs on a background thread once per debounced burst of
    /// events that touched a watched root.
    pub(crate) fn new(
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let (tx, rx) = channel::<()>();
        let state = Arc::new(Mutex::new(WatchState::default()));
        let handler_state = state.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let relevant = {
                let state = handler_state.lock().unwrap_or_else(|p| p.into_inner());
                event.paths.iter().any(|p| state.is_relevant(p))
            };
            if relevant {
                let _ = tx.send(());
            }
        })?;
        let shared = Arc::new(Shared {
            watcher: Mutex::new(watcher),
            state,
        });
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("skills-watch".into())
            .spawn(move || {
                // Ends when the watcher (and with it the sender) is dropped.
                while rx.recv().is_ok() {
                    let started = Instant::now();
                    loop {
                        if started.elapsed() >= debounce * MAX_DEBOUNCE_WINDOWS {
                            break;
                        }
                        match rx.recv_timeout(debounce) {
                            Ok(()) => {}
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    let Some(shared) = weak.upgrade() else { return };
                    let requested = shared
                        .state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .requested
                        .clone();
                    // A root created by this change now needs a real watch.
                    shared.apply(&requested);
                    drop(shared);
                    on_change();
                }
            })
            .map_err(notify::Error::io)?;
        Ok(Self { shared })
    }

    pub(crate) fn watch_roots(&self, roots: &[PathBuf]) {
        self.shared.apply(roots);
    }
}

/// Tauri-managed handle; `None` when the OS watcher could not start.
pub struct SkillsWatchState {
    watcher: Option<SkillsWatcher>,
    project_roots: Mutex<usize>,
}

/// Starts watching the user-level skill roots and manages the state that
/// `skills_watch_project` adds project roots to.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    let watcher = match SkillsWatcher::new(DEBOUNCE, move || {
        let revision = bump_revision();
        let _ = handle.emit("skills-changed", SkillsChanged { revision });
    }) {
        Ok(watcher) => Some(watcher),
        Err(err) => {
            eprintln!("monocode: skills watcher unavailable: {err}");
            None
        }
    };
    if let (Some(watcher), Some(home)) = (&watcher, dirs_home()) {
        watcher.watch_roots(&user_roots(Path::new(&home)));
    }
    app.manage(SkillsWatchState {
        watcher,
        project_roots: Mutex::new(0),
    });
}

/// Adds a project's skill roots to the watcher. Idempotent and best effort.
#[tauri::command(async)]
pub fn skills_watch_project(state: State<'_, SkillsWatchState>, cwd: String) {
    let Some(watcher) = &state.watcher else {
        return;
    };
    let project = expand_home(&cwd);
    if !project.is_dir() {
        return;
    }
    let roots = project_roots(&project);
    let mut count = state
        .project_roots
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let known = {
        let st = watcher
            .shared
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        roots.iter().all(|r| st.requested.contains(r))
    };
    if known {
        return;
    }
    if *count + roots.len() > MAX_PROJECT_ROOTS {
        return;
    }
    *count += roots.len();
    drop(count);
    watcher.watch_roots(&roots);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{bump_revision, skills_revision};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn wait_for(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        done()
    }

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-skills-watch-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn watcher_bumps_revision_on_new_skill() {
        let root = temp_root("new-skill");
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = fired.clone();
        let watcher = SkillsWatcher::new(Duration::from_millis(20), move || {
            counter.fetch_add(1, Ordering::SeqCst);
            bump_revision();
        })
        .unwrap();
        watcher.watch_roots(std::slice::from_ref(&root));

        let before = skills_revision();
        std::fs::create_dir_all(root.join("foo")).unwrap();
        std::fs::write(
            root.join("foo/SKILL.md"),
            "---\nname: foo\ndescription: Foo\n---\n",
        )
        .unwrap();

        assert!(wait_for(|| fired.load(Ordering::SeqCst) > 0));
        assert!(skills_revision() > before);
        let _ = std::fs::remove_dir_all(&root);
    }
}
