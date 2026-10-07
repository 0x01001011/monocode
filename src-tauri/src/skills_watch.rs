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
    // Plugin enablement lives in settings.json here.
    roots.push(home.join(SETTINGS_DIR));
    roots
}

/// Roots `list_skills` scans under a project directory.
fn project_roots(project: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project.join(".agents/skills")];
    roots.extend(PROVIDER_SKILL_DIRS.iter().map(|(dir, _)| project.join(dir)));
    // Project settings can enable or disable plugins too.
    roots.push(project.join(SETTINGS_DIR));
    roots
}

/// Holds the settings files that enable or disable Claude plugins. Watched
/// non-recursively, and only its settings files count as changes: Claude Code
/// writes plenty of unrelated files here.
const SETTINGS_DIR: &str = ".claude";
const SETTINGS_FILES: [&str; 2] = ["settings.json", "settings.local.json"];

fn is_settings_dir(root: &Path) -> bool {
    root.file_name().is_some_and(|name| name == SETTINGS_DIR)
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
    /// Settings directories, in raw and canonical spelling. Only their
    /// settings files are relevant.
    settings_dirs: HashSet<PathBuf>,
    /// Raw roots in request order, so they can be re-checked on change.
    requested: Vec<PathBuf>,
    /// Paths with an active OS watch, and whether it is recursive.
    watched: HashSet<(PathBuf, bool)>,
}

impl WatchState {
    fn is_relevant(&self, path: &Path) -> bool {
        let settings_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| SETTINGS_FILES.contains(&name))
            && path
                .parent()
                .is_some_and(|dir| self.settings_dirs.contains(dir));
        settings_file
            || self
                .roots
                .iter()
                .any(|root| path.starts_with(root) || root.starts_with(path))
    }
}

impl Shared {
    /// Existing roots get a recursive watch. Missing roots fall back to their
    /// nearest existing ancestor (non-recursive) so creation is noticed, and
    /// are upgraded by the next call once they exist. Watches whose directory
    /// has since been deleted are dropped first: on some platforms the OS
    /// watch dies with the directory, and a recreated root must be re-added.
    ///
    /// Returns true when every root in `roots` is covered by a live watch.
    fn apply(&self, roots: &[PathBuf]) -> bool {
        let (stale, targets): (Vec<PathBuf>, Vec<(PathBuf, bool)>) = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let stale: Vec<PathBuf> = state
                .watched
                .iter()
                .filter(|(path, _)| !path.is_dir())
                .map(|(path, _)| path.clone())
                .collect();
            state.watched.retain(|(path, _)| !stale.contains(path));
            for root in roots {
                if !state.requested.contains(root) {
                    state.requested.push(root.clone());
                }
                let filter = if is_settings_dir(root) {
                    &mut state.settings_dirs
                } else {
                    &mut state.roots
                };
                filter.insert(root.clone());
                filter.insert(canonical_form(root));
            }
            let targets = state
                .requested
                .iter()
                .filter_map(|root| watch_target(root))
                .filter(|target| !state.watched.contains(target))
                .collect();
            (stale, targets)
        };
        // The state lock is released before talking to the OS: the event
        // handler takes it, and some backends wait on their event thread.
        {
            let mut watcher = self.watcher.lock().unwrap_or_else(|p| p.into_inner());
            for path in &stale {
                let _ = watcher.unwatch(path);
            }
        }
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
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        roots
            .iter()
            .all(|root| watch_target(root).is_some_and(|target| state.watched.contains(&target)))
    }
}

/// The OS watch that covers `root`: the root itself when it exists, otherwise
/// its nearest existing ancestor.
fn watch_target(root: &Path) -> Option<(PathBuf, bool)> {
    if root.is_dir() {
        // The plugins directory holds whole plugin caches; only its registry
        // file matters. Settings directories only matter for their own files.
        let recursive = !root.ends_with(".claude/plugins") && !is_settings_dir(root);
        Some((root.to_path_buf(), recursive))
    } else {
        nearest_existing_dir(root).map(|ancestor| (ancestor, false))
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

    /// Returns true when every root is covered by a live OS watch.
    pub(crate) fn watch_roots(&self, roots: &[PathBuf]) -> bool {
        self.shared.apply(roots)
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

/// Adds a project's skill roots to the watcher. Returns true only when every
/// root is covered by a live watch; false tells the frontend to fall back to
/// refreshing that project's catalog on demand.
#[tauri::command(async)]
pub fn skills_watch_project(state: State<'_, SkillsWatchState>, cwd: String) -> bool {
    let project = expand_home(&cwd);
    if !project.is_dir() {
        return false;
    }
    register_project(
        state.watcher.as_ref(),
        &state.project_roots,
        &project_roots(&project),
    )
}

fn register_project(
    watcher: Option<&SkillsWatcher>,
    count: &Mutex<usize>,
    roots: &[PathBuf],
) -> bool {
    let Some(watcher) = watcher else {
        return false;
    };
    let known = {
        let st = watcher
            .shared
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        roots.iter().all(|r| st.requested.contains(r))
    };
    if !known {
        let mut count = count.lock().unwrap_or_else(|p| p.into_inner());
        if *count + roots.len() > MAX_PROJECT_ROOTS {
            return false;
        }
        *count += roots.len();
    }
    // Idempotent: also retries roots whose earlier registration failed.
    watcher.watch_roots(roots)
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

    fn counting_watcher() -> (SkillsWatcher, Arc<AtomicUsize>) {
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = fired.clone();
        let watcher = SkillsWatcher::new(Duration::from_millis(20), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        (watcher, fired)
    }

    #[test]
    fn recreated_root_is_watched_again() {
        let root = temp_root("recreate");
        let (watcher, fired) = counting_watcher();
        assert!(watcher.watch_roots(std::slice::from_ref(&root)));

        std::fs::remove_dir_all(&root).unwrap();
        assert!(wait_for(|| fired.load(Ordering::SeqCst) > 0));
        std::thread::sleep(Duration::from_millis(300));
        let after_delete = fired.load(Ordering::SeqCst);

        std::fs::create_dir_all(&root).unwrap();
        assert!(wait_for(|| fired.load(Ordering::SeqCst) > after_delete));
        std::thread::sleep(Duration::from_millis(300));
        let after_recreate = fired.load(Ordering::SeqCst);

        std::fs::create_dir_all(root.join("foo")).unwrap();
        std::fs::write(
            root.join("foo/SKILL.md"),
            "---\nname: foo\ndescription: Foo\n---\n",
        )
        .unwrap();
        assert!(wait_for(|| fired.load(Ordering::SeqCst) > after_recreate));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_prunes_watches_for_deleted_directories() {
        let root = temp_root("prune");
        let (watcher, _fired) = counting_watcher();
        assert!(watcher.watch_roots(std::slice::from_ref(&root)));
        let watched = |w: &SkillsWatcher| {
            w.shared
                .state
                .lock()
                .unwrap()
                .watched
                .contains(&(root.clone(), true))
        };
        assert!(watched(&watcher));

        std::fs::remove_dir_all(&root).unwrap();
        watcher.watch_roots(&[]);
        assert!(
            !watched(&watcher),
            "deleted root must leave the watched set"
        );

        std::fs::create_dir_all(&root).unwrap();
        assert!(watcher.watch_roots(&[]));
        assert!(watched(&watcher), "recreated root must be watched again");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plugin_settings_edits_bump_the_revision() {
        let project = temp_root("settings");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        let (watcher, fired) = counting_watcher();
        assert!(watcher.watch_roots(&project_roots(&project)));

        std::fs::write(
            project.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"demo@market":false}}"#,
        )
        .unwrap();
        assert!(wait_for(|| fired.load(Ordering::SeqCst) > 0));
        std::thread::sleep(Duration::from_millis(300));
        let after_settings = fired.load(Ordering::SeqCst);

        std::fs::write(project.join(".claude/settings.local.json"), "{}").unwrap();
        assert!(wait_for(|| fired.load(Ordering::SeqCst) > after_settings));
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn only_settings_files_in_a_settings_dir_are_relevant() {
        let project = temp_root("settings-filter");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        let (watcher, _fired) = counting_watcher();
        watcher.watch_roots(&project_roots(&project));
        let state = watcher.shared.state.lock().unwrap();
        let dir = canonical_form(&project.join(".claude"));
        assert!(state.is_relevant(&dir.join("settings.json")));
        assert!(state.is_relevant(&dir.join("settings.local.json")));
        assert!(state.is_relevant(&project.join(".claude/settings.json")));
        // Claude Code writes plenty of other files here; they never matter.
        assert!(!state.is_relevant(&dir.join("history.jsonl")));
        assert!(!state.is_relevant(&dir.join("projects/x/settings.json")));
        assert!(!state.is_relevant(&dir.join("settings.json.tmp")));
        // The skill roots under it are still watched as before.
        assert!(state.is_relevant(&dir.join("skills/foo/SKILL.md")));
        drop(state);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn settings_dirs_are_watched_non_recursively() {
        let home = temp_root("settings-home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        assert!(user_roots(&home).contains(&home.join(".claude")));
        assert_eq!(
            watch_target(&home.join(".claude")),
            Some((home.join(".claude"), false))
        );
        let project = temp_root("settings-project");
        assert!(project_roots(&project).contains(&project.join(".claude")));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn project_registration_reports_false_without_a_live_watch() {
        let project = temp_root("register");
        let roots = project_roots(&project);
        let count = Mutex::new(0);
        assert!(!register_project(None, &count, &roots));

        let (watcher, _fired) = counting_watcher();
        let full = Mutex::new(MAX_PROJECT_ROOTS);
        assert!(!register_project(Some(&watcher), &full, &roots));

        assert!(register_project(Some(&watcher), &count, &roots));
        // Idempotent: a second call neither double-counts nor fails.
        assert!(register_project(Some(&watcher), &count, &roots));
        assert_eq!(*count.lock().unwrap(), roots.len());
        let _ = std::fs::remove_dir_all(&project);
    }
}
