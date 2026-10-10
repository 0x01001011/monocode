//! Attributes git activity to chats through git's trace2 event stream.
//!
//! Harness and terminal children get `GIT_TRACE2_EVENT` pointing at a unix
//! datagram socket owned by this module and `GIT_TRACE2_PARENT_SID` set to
//! `monocode-<session id>`. Git then prefixes every event's `sid` with that
//! value, so a datagram tells us which chat ran which git command where.
//! Failure to bind degrades silently to save-time attribution.

// `socket_path` is the listener's public contract (terminals will use it).
#[cfg(unix)]
#[allow(unused_imports)]
pub use unix::{socket_path, start, trace2_env};

#[cfg(not(unix))]
#[allow(unused_imports)]
pub use fallback::{socket_path, start, trace2_env};

#[cfg(not(unix))]
mod fallback {
    use std::path::PathBuf;
    use tauri::AppHandle;

    pub fn socket_path() -> Option<PathBuf> {
        None
    }

    pub fn trace2_env(_session_id: &str) -> Option<[(&'static str, String); 2]> {
        None
    }

    pub fn start(_app: &AppHandle) {}
}

#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixDatagram;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};

    use serde::Deserialize;
    use tauri::{AppHandle, Manager};

    use crate::session_store::{validate_id, SessionStore};

    /// Git commands after which the checked-out branch or its remote state may
    /// have changed.
    const RELEVANT_CMDS: &[&str] = &[
        "checkout", "switch", "branch", "push", "commit", "worktree", "rebase", "merge",
    ];
    /// At most one attribution per (chat, worktree) in this window; the last
    /// suppressed event is replayed when the window ends.
    const THROTTLE_WINDOW: Duration = Duration::from_secs(2);
    /// Stay well below `sun_path` (104 bytes on macOS, 108 on Linux).
    const MAX_SOCKET_PATH_BYTES: usize = 100;
    const MAX_PENDING_SIDS: usize = 1024;
    const MAX_THROTTLE_KEYS: usize = 256;
    const MAX_SESSION_ID_BYTES: usize = 128;
    const POLL_INTERVAL: Duration = Duration::from_millis(250);

    static SOCKET: OnceLock<PathBuf> = OnceLock::new();
    static NEVER_STOP: AtomicBool = AtomicBool::new(false);

    /// Where git should send trace2 events; `None` until `start` bound it, and
    /// forever if binding failed.
    pub fn socket_path() -> Option<PathBuf> {
        SOCKET.get().cloned()
    }

    /// Environment that makes git report its activity for `session_id`.
    pub fn trace2_env(session_id: &str) -> Option<[(&'static str, String); 2]> {
        trace2_env_for(socket_path().as_deref(), session_id)
    }

    pub(super) fn trace2_env_for(
        socket: Option<&Path>,
        session_id: &str,
    ) -> Option<[(&'static str, String); 2]> {
        let socket = socket?;
        if !is_safe_session_id(session_id) {
            return None;
        }
        Some([
            (
                "GIT_TRACE2_EVENT",
                format!("af_unix:dgram:{}", socket.display()),
            ),
            ("GIT_TRACE2_PARENT_SID", format!("monocode-{session_id}")),
        ])
    }

    fn is_safe_session_id(id: &str) -> bool {
        id.len() <= MAX_SESSION_ID_BYTES && validate_id(id, "session").is_ok()
    }

    /// One datagram, reduced to what attribution needs.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct TraceEvent {
        pub session_id: String,
        /// Full trace2 sid; identifies one git process.
        pub sid: String,
        /// Command name for `cmd_name` events, empty otherwise.
        pub cmd: String,
        /// Worktree root for `def_repo` events.
        pub worktree: Option<String>,
        /// True for the `exit` event.
        pub exit: bool,
    }

    /// A git command of interest finished in `worktree` on behalf of a chat.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Action {
        pub session_id: String,
        pub worktree: String,
    }

    #[derive(Deserialize)]
    struct Raw {
        event: String,
        sid: String,
        name: Option<String>,
        worktree: Option<String>,
    }

    /// Parses one trace2 JSON datagram. Only `def_repo`, `cmd_name` and `exit`
    /// events carrying a `monocode-<id>/...` sid are interesting.
    pub fn parse_event(line: &str) -> Option<TraceEvent> {
        let raw: Raw = serde_json::from_str(line.trim()).ok()?;
        let session_id = raw
            .sid
            .strip_prefix("monocode-")?
            .split_once('/')
            .map(|(id, _)| id)?;
        if !is_safe_session_id(session_id) {
            return None;
        }
        let session_id = session_id.to_string();
        let mut event = TraceEvent {
            session_id,
            sid: raw.sid,
            cmd: String::new(),
            worktree: None,
            exit: false,
        };
        match raw.event.as_str() {
            "cmd_name" => event.cmd = raw.name.filter(|name| !name.is_empty())?,
            "def_repo" => event.worktree = Some(raw.worktree.filter(|path| !path.is_empty())?),
            "exit" => event.exit = true,
            _ => return None,
        }
        Some(event)
    }

    #[derive(Default)]
    struct Pending {
        worktree: Option<String>,
        relevant: bool,
    }

    /// Joins the separate `def_repo`, `cmd_name` and `exit` datagrams of one git
    /// process. The branch only changes while the command runs, so the action
    /// fires at `exit`.
    #[derive(Default)]
    pub struct Correlator {
        pending: HashMap<String, Pending>,
    }

    impl Correlator {
        pub fn feed(&mut self, event: TraceEvent) -> Option<Action> {
            if !self.pending.contains_key(&event.sid) && self.pending.len() >= MAX_PENDING_SIDS {
                self.pending.clear();
            }
            if event.exit {
                let done = self.pending.remove(&event.sid)?;
                let worktree = done.worktree.filter(|path| Path::new(path).is_absolute())?;
                return done.relevant.then_some(Action {
                    session_id: event.session_id,
                    worktree,
                });
            }
            if !event.cmd.is_empty() {
                if RELEVANT_CMDS.contains(&event.cmd.as_str()) {
                    self.pending.entry(event.sid).or_default().relevant = true;
                } else {
                    self.pending.remove(&event.sid);
                }
                return None;
            }
            if let Some(worktree) = event.worktree {
                self.pending.entry(event.sid).or_default().worktree = Some(worktree);
            }
            None
        }

        #[cfg(test)]
        pub fn len(&self) -> usize {
            self.pending.len()
        }
    }

    type Key = (String, String);

    /// Leading-edge throttle per (chat, worktree) that remembers the latest
    /// suppressed action so a quick `checkout a; checkout b` still ends on `b`.
    pub struct Throttle {
        window: Duration,
        last: HashMap<Key, Instant>,
        deferred: HashMap<Key, Action>,
    }

    impl Throttle {
        pub fn new(window: Duration) -> Self {
            Self {
                window,
                last: HashMap::new(),
                deferred: HashMap::new(),
            }
        }

        /// Returns the action when it may run now; otherwise defers it.
        pub fn offer(&mut self, action: Action, now: Instant) -> Option<Action> {
            let key = (action.session_id.clone(), action.worktree.clone());
            if let Some(last) = self.last.get(&key) {
                if now.saturating_duration_since(*last) < self.window {
                    self.deferred.insert(key, action);
                    return None;
                }
            }
            if self.last.len() >= MAX_THROTTLE_KEYS {
                let window = self.window;
                let deferred = &self.deferred;
                self.last.retain(|k, at| {
                    deferred.contains_key(k) || now.saturating_duration_since(*at) < window
                });
            }
            self.deferred.remove(&key);
            self.last.insert(key, now);
            Some(action)
        }

        /// Deferred actions whose window has ended; each opens a new window.
        pub fn take_due(&mut self, now: Instant) -> Vec<Action> {
            if self.deferred.is_empty() {
                return Vec::new();
            }
            let due: Vec<Key> = self
                .deferred
                .keys()
                .filter(|key| {
                    self.last
                        .get(*key)
                        .is_none_or(|at| now.saturating_duration_since(*at) >= self.window)
                })
                .cloned()
                .collect();
            let mut out = Vec::new();
            for key in due {
                if let Some(action) = self.deferred.remove(&key) {
                    self.last.insert(key, now);
                    out.push(action);
                }
            }
            out
        }
    }

    pub(super) fn socket_path_in(dir: &Path, pid: u32) -> Option<PathBuf> {
        use std::os::unix::ffi::OsStrExt;
        let path = dir.join(format!("{pid}.sock"));
        (path.as_os_str().as_bytes().len() <= MAX_SOCKET_PATH_BYTES).then_some(path)
    }

    /// Reads datagrams until `stop`, handing each action that survives
    /// correlation and throttling to `handle`. Never panics: malformed input is
    /// skipped and a panicking handler is contained.
    pub(super) fn run(sock: &UnixDatagram, stop: &AtomicBool, mut handle: impl FnMut(Action)) {
        if sock.set_read_timeout(Some(POLL_INTERVAL)).is_err() {
            return;
        }
        let mut buf = vec![0u8; 64 * 1024];
        let mut correlator = Correlator::default();
        let mut throttle = Throttle::new(THROTTLE_WINDOW);
        let mut dispatch = |action: Action| {
            let _ = catch_unwind(AssertUnwindSafe(|| handle(action)));
        };
        while !stop.load(Ordering::Relaxed) {
            match sock.recv(&mut buf) {
                Ok(n) => {
                    let action = std::str::from_utf8(&buf[..n])
                        .ok()
                        .and_then(parse_event)
                        .and_then(|event| correlator.feed(event))
                        .and_then(|action| throttle.offer(action, Instant::now()));
                    if let Some(action) = action {
                        dispatch(action);
                    }
                }
                Err(err)
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => std::thread::sleep(POLL_INTERVAL),
            }
            for action in throttle.take_due(Instant::now()) {
                dispatch(action);
            }
        }
    }

    /// Binds the trace2 socket and starts attributing git activity. Silent on
    /// failure: chats then fall back to save-time attribution.
    pub fn start(app: &AppHandle) {
        if SOCKET.get().is_some() {
            return;
        }
        let Some((sock, path)) = bind_socket() else {
            return;
        };
        let (tx, rx) = mpsc::channel::<Action>();
        let reader = std::thread::Builder::new()
            .name("pr-trace".into())
            .spawn(move || {
                run(&sock, &NEVER_STOP, |action| {
                    let _ = tx.send(action);
                })
            });
        if reader.is_err() {
            return;
        }
        // Git subprocesses run on their own thread so the reader keeps draining
        // the socket buffer.
        let app = app.clone();
        let worker = std::thread::Builder::new()
            .name("pr-trace-worker".into())
            .spawn(move || {
                for action in rx {
                    let _ = catch_unwind(AssertUnwindSafe(|| attribute(&app, &action)));
                }
            });
        if worker.is_ok() {
            let _ = SOCKET.set(path);
        }
    }

    /// Records the branch git ran on; the UI hears about it only when that
    /// added or changed a branch row (a repeat sighting changes nothing).
    fn attribute(app: &AppHandle, action: &Action) {
        let branch = crate::fs::git_head_branch(Path::new(&action.worktree));
        let Some(store) = app.try_state::<SessionStore>() else {
            return;
        };
        let changed = store.lock_conn().is_ok_and(|conn| {
            crate::pr_attribution::note_branch_trace(
                &conn,
                &action.session_id,
                &action.worktree,
                branch.as_deref(),
            )
        });
        if changed {
            crate::pr_tracker::notify_session_changed(app, &action.session_id);
        }
    }

    fn bind_socket() -> Option<(UnixDatagram, PathBuf)> {
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let pid = std::process::id();
        for base in [std::env::temp_dir(), PathBuf::from("/tmp")] {
            let Some(dir) = private_dir(&base.join(format!("mc-t2-{uid}")), uid) else {
                continue;
            };
            let Some(path) = socket_path_in(&dir, pid) else {
                continue;
            };
            sweep_stale_sockets(&dir, pid, uid);
            if let Ok(meta) = std::fs::symlink_metadata(&path) {
                if !meta.file_type().is_socket() || std::fs::remove_file(&path).is_err() {
                    continue;
                }
            }
            let Ok(sock) = UnixDatagram::bind(&path) else {
                continue;
            };
            if std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_err() {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            grow_receive_buffer(&sock);
            return Some((sock, path));
        }
        None
    }

    /// A directory only we can enter, so no other user can reach the socket or
    /// plant a lookalike at its path.
    fn private_dir(dir: &Path, uid: u32) -> Option<PathBuf> {
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        let _ = builder.create(dir);
        let meta = std::fs::symlink_metadata(dir).ok()?;
        if !meta.is_dir() || meta.uid() != uid {
            return None;
        }
        if meta.mode() & 0o077 != 0 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).ok()?;
        }
        Some(dir.to_path_buf())
    }

    /// Removes `<pid>.sock` files left by app instances that no longer run.
    fn sweep_stale_sockets(dir: &Path, own_pid: u32, uid: u32) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name
                .to_str()
                .and_then(|name| name.strip_suffix(".sock"))
                .and_then(|pid| pid.parse::<i32>().ok())
            else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if pid as u32 == own_pid || !meta.file_type().is_socket() || meta.uid() != uid {
                continue;
            }
            // SAFETY: signal 0 only probes for the process.
            let gone = unsafe { libc::kill(pid, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if gone {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Git emits dozens of events per command; the default datagram queue is
    /// only a few kilobytes on macOS and would drop the ones we need.
    fn grow_receive_buffer(sock: &UnixDatagram) {
        let size: libc::c_int = 1 << 20;
        // SAFETY: `size` outlives the call and the length matches its type.
        unsafe {
            libc::setsockopt(
                sock.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::net::UnixDatagram;
        use std::sync::atomic::Ordering;
        use std::sync::{mpsc, Arc};

        const SID: &str = "monocode-sess-1/20261009T153100.971726Z-Hf306f7cf-P0000e6cc";
        const DEF_REPO: &str = r#"{"event":"def_repo","sid":"monocode-sess-1/20261009T153100.971726Z-Hf306f7cf-P0000e6cc","thread":"main","time":"2026-10-09T15:31:00.974893Z","file":"repository.c","line":237,"repo":1,"worktree":"/private/tmp/t2cap/repo"}
"#;
        const CMD_NAME: &str = r#"{"event":"cmd_name","sid":"monocode-sess-1/20261009T153100.971726Z-Hf306f7cf-P0000e6cc","thread":"main","time":"2026-10-09T15:31:00.975793Z","file":"git.c","line":503,"name":"checkout","hierarchy":"checkout"}
"#;
        const EXIT: &str = r#"{"event":"exit","sid":"monocode-sess-1/20261009T153100.971726Z-Hf306f7cf-P0000e6cc","thread":"main","time":"2026-10-09T15:31:01.008341Z","file":"git.c","line":782,"t_abs":0.038494,"code":0}
"#;
        const FOREIGN: &str = r#"{"event":"cmd_name","sid":"20261009T153100.971726Z-Hf306f7cf-P0000e6cc","thread":"main","file":"git.c","line":503,"name":"checkout","hierarchy":"checkout"}
"#;

        fn ev(
            session: &str,
            sid: &str,
            cmd: &str,
            worktree: Option<&str>,
            exit: bool,
        ) -> TraceEvent {
            TraceEvent {
                session_id: session.into(),
                sid: sid.into(),
                cmd: cmd.into(),
                worktree: worktree.map(Into::into),
                exit,
            }
        }

        #[test]
        fn parse_event_extracts_session_cmd_and_worktree() {
            assert_eq!(
                parse_event(CMD_NAME),
                Some(ev("sess-1", SID, "checkout", None, false))
            );
            assert_eq!(
                parse_event(DEF_REPO),
                Some(ev(
                    "sess-1",
                    SID,
                    "",
                    Some("/private/tmp/t2cap/repo"),
                    false
                ))
            );
            assert_eq!(parse_event(EXIT), Some(ev("sess-1", SID, "", None, true)));
        }

        #[test]
        fn parse_event_ignores_foreign_sid_noise_and_other_events() {
            assert_eq!(parse_event(FOREIGN), None);
            assert_eq!(parse_event("not json"), None);
            assert_eq!(parse_event(""), None);
            assert_eq!(
                parse_event(r#"{"event":"region_enter","sid":"monocode-s/x"}"#),
                None
            );
            assert_eq!(parse_event(r#"{"event":"exit","sid":"monocode-/x"}"#), None);
            assert_eq!(
                parse_event(r#"{"event":"exit","sid":"monocode-a b/x"}"#),
                None
            );
            assert_eq!(
                parse_event(r#"{"event":"exit","sid":"monocode-onlyparent"}"#),
                None
            );
            assert_eq!(parse_event(r#"{"event":"exit"}"#), None);
        }

        #[test]
        fn correlator_fires_on_exit_for_relevant_commands_in_any_arrival_order() {
            let action = Some(Action {
                session_id: "sess-1".into(),
                worktree: "/w".into(),
            });
            let mut c = Correlator::default();
            assert_eq!(c.feed(ev("sess-1", "a", "", Some("/w"), false)), None);
            assert_eq!(c.feed(ev("sess-1", "a", "checkout", None, false)), None);
            assert_eq!(c.feed(ev("sess-1", "a", "", None, true)), action);
            // The entry is gone after exit.
            assert_eq!(c.feed(ev("sess-1", "a", "", None, true)), None);

            assert_eq!(c.feed(ev("sess-1", "b", "push", None, false)), None);
            assert_eq!(c.feed(ev("sess-1", "b", "", Some("/w"), false)), None);
            assert_eq!(c.feed(ev("sess-1", "b", "", None, true)), action);
        }

        #[test]
        fn correlator_ignores_irrelevant_commands_and_unknown_worktrees() {
            let mut c = Correlator::default();
            c.feed(ev("s", "a", "", Some("/w"), false));
            c.feed(ev("s", "a", "status", None, false));
            assert_eq!(c.feed(ev("s", "a", "", None, true)), None);
            // Outside a repository there is no def_repo.
            c.feed(ev("s", "b", "checkout", None, false));
            assert_eq!(c.feed(ev("s", "b", "", None, true)), None);
        }

        #[test]
        fn correlator_stays_bounded() {
            let mut c = Correlator::default();
            for i in 0..5000 {
                c.feed(ev("s", &format!("sid{i}"), "", Some("/w"), false));
            }
            assert!(c.len() <= 1024);
        }

        #[test]
        fn throttle_allows_one_event_per_window() {
            let window = Duration::from_secs(2);
            let mut t = Throttle::new(window);
            let a = Action {
                session_id: "s".into(),
                worktree: "/w".into(),
            };
            let other_wt = Action {
                session_id: "s".into(),
                worktree: "/x".into(),
            };
            let other_session = Action {
                session_id: "t".into(),
                worktree: "/w".into(),
            };
            let t0 = Instant::now();
            assert_eq!(t.offer(a.clone(), t0), Some(a.clone()));
            assert_eq!(t.offer(a.clone(), t0 + Duration::from_millis(900)), None);
            assert_eq!(t.offer(a.clone(), t0 + Duration::from_millis(1900)), None);
            // Independent keys do not share a window.
            assert_eq!(t.offer(other_wt.clone(), t0), Some(other_wt));
            assert_eq!(t.offer(other_session.clone(), t0), Some(other_session));
            assert_eq!(
                t.offer(a.clone(), t0 + Duration::from_millis(2100)),
                Some(a)
            );
        }

        #[test]
        fn throttle_replays_the_last_suppressed_event_once_the_window_ends() {
            let mut t = Throttle::new(Duration::from_secs(2));
            let a = Action {
                session_id: "s".into(),
                worktree: "/w".into(),
            };
            let t0 = Instant::now();
            t.offer(a.clone(), t0);
            t.offer(a.clone(), t0 + Duration::from_millis(500));
            t.offer(a.clone(), t0 + Duration::from_millis(600));
            assert!(t.take_due(t0 + Duration::from_millis(1000)).is_empty());
            assert_eq!(
                t.take_due(t0 + Duration::from_millis(2100)),
                vec![a.clone()]
            );
            assert!(t.take_due(t0 + Duration::from_millis(2200)).is_empty());
            // The replay opened a new window.
            assert_eq!(t.offer(a.clone(), t0 + Duration::from_millis(2500)), None);
        }

        #[test]
        fn socket_path_fits_sun_path_limit() {
            let path = socket_path_in(
                Path::new("/var/folders/ab/cdef0123456789/T/mc-t2-501"),
                4_000_000,
            )
            .unwrap();
            assert!(path.as_os_str().len() <= 100, "{path:?}");
            let too_long = "/x".repeat(60);
            assert_eq!(socket_path_in(Path::new(&too_long), 1), None);
        }

        #[test]
        fn bind_socket_creates_a_private_socket_within_the_path_limit() {
            let (_sock, path) = bind_socket().expect("bind");
            assert!(path.as_os_str().len() <= MAX_SOCKET_PATH_BYTES, "{path:?}");
            let meta = std::fs::symlink_metadata(&path).unwrap();
            assert!(meta.file_type().is_socket());
            assert_eq!(meta.mode() & 0o777, 0o600);
            let dir_meta = std::fs::metadata(path.parent().unwrap()).unwrap();
            assert_eq!(dir_meta.mode() & 0o077, 0);
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn trace2_env_is_set_only_with_a_socket_and_a_safe_session_id() {
            let sock = Path::new("/tmp/mc-t2-1/42.sock");
            assert_eq!(
                trace2_env_for(Some(sock), "sess-1"),
                Some([
                    (
                        "GIT_TRACE2_EVENT",
                        "af_unix:dgram:/tmp/mc-t2-1/42.sock".to_string()
                    ),
                    ("GIT_TRACE2_PARENT_SID", "monocode-sess-1".to_string()),
                ])
            );
            assert_eq!(trace2_env_for(None, "sess-1"), None);
            assert_eq!(trace2_env_for(Some(sock), "a/b"), None);
            assert_eq!(trace2_env_for(Some(sock), ""), None);
        }

        #[test]
        fn real_git_checkout_reaches_the_listener() {
            let dir =
                std::env::temp_dir().join(format!("mc-t2-git-{}", uuid::Uuid::new_v4().simple()));
            let repo = dir.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            let git = |args: &[&str], env: &[(&str, String)]| {
                let status = std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_SYSTEM", "/dev/null")
                    .output()
                    .unwrap()
                    .status;
                assert!(status.success(), "git {args:?}");
            };
            git(&["init", "-q"], &[]);
            git(
                &[
                    "-c",
                    "user.email=a@b",
                    "-c",
                    "user.name=n",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    "init",
                ],
                &[],
            );
            let path = dir.join("l.sock");
            let server = UnixDatagram::bind(&path).unwrap();
            grow_receive_buffer(&server);
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::channel();
            let thread = {
                let stop = stop.clone();
                std::thread::spawn(move || run(&server, &stop, |a| tx.send(a).unwrap()))
            };
            let env = trace2_env_for(Some(&path), "chat-9").unwrap();
            git(&["checkout", "-q", "-b", "feat/x"], &env);
            let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(got.session_id, "chat-9");
            assert_eq!(
                std::fs::canonicalize(&got.worktree).unwrap(),
                std::fs::canonicalize(&repo).unwrap()
            );
            stop.store(true, Ordering::SeqCst);
            thread.join().unwrap();
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn listener_turns_datagrams_into_actions() {
            let dir =
                std::env::temp_dir().join(format!("mc-t2-test-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("l.sock");
            let server = UnixDatagram::bind(&path).unwrap();
            grow_receive_buffer(&server);
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::channel();
            let thread = {
                let stop = stop.clone();
                std::thread::spawn(move || run(&server, &stop, |a| tx.send(a).unwrap()))
            };
            let client = UnixDatagram::unbound().unwrap();
            for line in [DEF_REPO, "garbage", FOREIGN, CMD_NAME, EXIT] {
                client.send_to(line.as_bytes(), &path).unwrap();
            }
            let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                got,
                Action {
                    session_id: "sess-1".into(),
                    worktree: "/private/tmp/t2cap/repo".into()
                }
            );
            stop.store(true, Ordering::SeqCst);
            thread.join().unwrap();
            assert!(rx.try_recv().is_err());
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
