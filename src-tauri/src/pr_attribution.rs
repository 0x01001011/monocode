//! Attributes git branches and pull requests to the chat that produced them.
//!
//! Three signals feed `pr_store`: the live branch seen on every session save
//! (`note_branch`), PR URLs a chat created (`pr_record_url`) and PR numbers the
//! frontend scraped from transcripts (`pr_record_hints`). Attribution is
//! best-effort: it must never fail or slow down a session save.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tauri::{AppHandle, State};

use crate::pr_store::{self, Relation};
use crate::session_store::{now_millis, validate_id, SessionStore};

const MAX_HINTS: usize = 50;
const REPO_FACTS_TTL: Duration = Duration::from_secs(60);

/// What we learn about a checkout once per minute: its GitHub slug and the
/// branch pull requests normally target.
#[derive(Debug, Clone, Default)]
struct RepoFacts {
    slug: Option<String>,
    default_branch: Option<String>,
}

static REPO_FACTS_CACHE: Mutex<Option<HashMap<PathBuf, (Instant, RepoFacts)>>> = Mutex::new(None);

/// Lowercase "owner/name" of the GitHub repo behind `cwd`. GitHub treats slugs
/// case-insensitively, so the lowercase form is the repo key everywhere.
pub fn repo_slug_for(cwd: &Path) -> Option<String> {
    repo_facts_for(cwd).slug
}

fn repo_facts_for(cwd: &Path) -> RepoFacts {
    if let Ok(mut guard) = REPO_FACTS_CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.retain(|_, (at, _)| at.elapsed() < REPO_FACTS_TTL);
        if let Some((_, facts)) = cache.get(cwd) {
            return facts.clone();
        }
    }
    let facts = repo_facts_uncached(cwd);
    if let Ok(mut guard) = REPO_FACTS_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(cwd.to_path_buf(), (Instant::now(), facts.clone()));
    }
    facts
}

fn repo_facts_uncached(cwd: &Path) -> RepoFacts {
    let remote = crate::fs::gh_resolved_remote(cwd).or_else(|| crate::fs::git_remote_name(cwd));
    let slug = remote
        .as_deref()
        .and_then(|name| crate::fs::git_stdout(cwd, &["remote", "get-url", name]))
        .and_then(|url| parse_github_slug(&url));
    let default_branch = crate::fs::git_default_branch(cwd, remote.as_deref());
    RepoFacts {
        slug,
        default_branch,
    }
}

/// Extracts lowercase "owner/name" from an https, ssh:// or scp-style GitHub remote URL.
fn parse_github_slug(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.split_once("://").map(|(_, rest)| rest) {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    } else {
        // scp-style: git@github.com:owner/name.git
        let (authority, path) = url.split_once(':')?;
        let host = authority.rsplit('@').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("{owner}/{name}").to_lowercase())
}

/// `(lowercase repo, number)` from `https://github.com/o/r/pull/12`, ignoring
/// any trailing path, query or fragment.
pub fn parse_pr_url(url: &str) -> Option<(String, u32)> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("https://www.github.com/"))?;
    let rest = rest.split(['?', '#']).next()?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|part| !part.is_empty())?;
    let name = parts.next().filter(|part| !part.is_empty())?;
    if parts.next()? != "pull" {
        return None;
    }
    let number: u32 = parts.next()?.parse().ok().filter(|n| *n > 0)?;
    Some((format!("{owner}/{name}").to_lowercase(), number))
}

/// Records `branch` as one the chat worked on. No-op for no branch, a detached
/// HEAD, the repo's default branch or a checkout without a GitHub remote.
pub fn note_branch(conn: &Connection, session_id: &str, cwd: &str, branch: Option<&str>) {
    note_branch_as(conn, session_id, cwd, branch, "save");
}

/// `note_branch` for a branch seen through git trace2 events. True when a
/// branch row was added or changed.
pub fn note_branch_trace(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    branch: Option<&str>,
) -> bool {
    note_branch_as(conn, session_id, cwd, branch, "trace2")
}

fn note_branch_as(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    branch: Option<&str>,
    source: &str,
) -> bool {
    let Some(name) = usable_branch(branch) else {
        return false;
    };
    let root = crate::fs::expand_home(cwd);
    // `git_info_for` reports a short commit id when HEAD is detached.
    if looks_like_commit_id(name) && crate::fs::git_head_branch(&root).is_none() {
        return false;
    }
    if repo_facts_for(&root).default_branch.as_deref() == Some(name) {
        return false;
    }
    note_branch_with_source(conn, session_id, cwd, branch, source, repo_slug_for)
}

/// `note_branch` with the repo lookup injected so tests need no git.
#[cfg(test)]
pub fn note_branch_with(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    branch: Option<&str>,
    resolve: impl Fn(&Path) -> Option<String>,
) {
    note_branch_with_source(conn, session_id, cwd, branch, "save", resolve);
}

/// `note_branch_with` that also names the signal (`save`, `trace2`) behind
/// it. True when a branch row was added or changed.
pub fn note_branch_with_source(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    branch: Option<&str>,
    source: &str,
    resolve: impl Fn(&Path) -> Option<String>,
) -> bool {
    let Some(name) = usable_branch(branch) else {
        return false;
    };
    let Some(repo) = resolve(&crate::fs::expand_home(cwd)) else {
        return false;
    };
    match pr_store::record_branch(conn, session_id, &repo, name, source, now_millis()) {
        Ok(changed) => changed,
        Err(err) => {
            eprintln!("[pr_attribution] could not record branch {name} for {session_id}: {err}");
            false
        }
    }
}

/// A branch worth attributing: not empty, not a detached marker, not the
/// conventional default.
fn usable_branch(branch: Option<&str>) -> Option<&str> {
    branch
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| !matches!(*name, "HEAD" | "main" | "master"))
}

fn looks_like_commit_id(name: &str) -> bool {
    (7..=40).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_hexdigit())
}

fn record_url(conn: &Connection, session_id: &str, url: &str) -> Result<(), String> {
    let (repo, number) =
        parse_pr_url(url).ok_or_else(|| "Not a GitHub pull request URL".to_string())?;
    pr_store::record_pr(
        conn,
        session_id,
        &repo,
        number,
        Relation::Owned,
        "create",
        now_millis(),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Hints carry the repo of the URL they came from when the frontend knows
/// it; numbers from another repo must not land on the checkout's repo.
fn hint_repo_matches(claimed: Option<&str>, checkout: &str) -> bool {
    claimed.is_none_or(|repo| repo.trim().eq_ignore_ascii_case(checkout))
}

/// Drops 0 and repeats, keeping at most `MAX_HINTS` numbers in order.
fn bounded_hints(numbers: &[u32]) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for number in numbers.iter().copied().filter(|n| *n != 0) {
        if out.len() == MAX_HINTS {
            break;
        }
        if !out.contains(&number) {
            out.push(number);
        }
    }
    out
}

fn record_hints(
    conn: &Connection,
    session_id: &str,
    repo: &str,
    numbers: &[u32],
) -> rusqlite::Result<()> {
    let now = now_millis();
    for number in bounded_hints(numbers) {
        pr_store::record_pr(
            conn,
            session_id,
            repo,
            number,
            Relation::Existing,
            "hint",
            now,
        )?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn pr_record_url(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_id: String,
    url: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    {
        let conn = store.lock_conn()?;
        record_url(&conn, &session_id, &url)?;
    }
    after_attribution(&app, &session_id);
    Ok(())
}

/// A chat gained a PR or hint: refresh its targets now and tell the UI.
fn after_attribution(app: &AppHandle, session_id: &str) {
    crate::pr_tracker::refresh_session_after_attribution(session_id);
    crate::pr_tracker::notify_session_changed(app, session_id);
}

#[tauri::command(async)]
pub fn pr_record_hints(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_id: String,
    cwd: String,
    numbers: Vec<u32>,
    repo: Option<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let claimed = repo;
    let Some(repo) = repo_slug_for(&crate::fs::expand_home(&cwd)) else {
        return Ok(());
    };
    if !hint_repo_matches(claimed.as_deref(), &repo) {
        return Ok(());
    }
    {
        let conn = store.lock_conn()?;
        record_hints(&conn, &session_id, &repo, &numbers).map_err(|e| e.to_string())?;
    }
    after_attribution(&app, &session_id);
    Ok(())
}

#[tauri::command(async)]
pub fn pr_dismiss(
    app: AppHandle,
    store: State<'_, SessionStore>,
    session_id: String,
    repo: String,
    number: u32,
    dismissed: bool,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    {
        let conn = store.lock_conn()?;
        pr_store::set_dismissed(&conn, &session_id, &repo, number, dismissed)
            .map_err(|e| e.to_string())?;
    }
    crate::pr_tracker::notify_session_changed(&app, &session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        pr_store::ensure_schema(&conn).unwrap();
        conn
    }

    fn repo(_: &Path) -> Option<String> {
        Some("Octo/Repo".to_string())
    }

    #[test]
    fn hint_repo_must_match_the_checkout_when_given() {
        assert!(hint_repo_matches(None, "octo/repo"));
        assert!(hint_repo_matches(Some("Octo/Repo"), "octo/repo"));
        assert!(hint_repo_matches(Some(" octo/repo "), "Octo/Repo"));
        assert!(!hint_repo_matches(Some("octo/other"), "octo/repo"));
        assert!(!hint_repo_matches(Some(""), "octo/repo"));
    }

    #[test]
    fn parse_pr_url_accepts_pull_urls_and_rejects_others() {
        assert_eq!(
            parse_pr_url("https://github.com/o/r/pull/12"),
            Some(("o/r".into(), 12))
        );
        assert_eq!(
            parse_pr_url("https://github.com/Octo/Re-po.x/pull/7/files?diff=split#top"),
            Some(("octo/re-po.x".into(), 7))
        );
        assert_eq!(
            parse_pr_url("  https://github.com/o/r/pull/12/  "),
            Some(("o/r".into(), 12))
        );
        assert_eq!(
            parse_pr_url("https://github.com/MixedCase/Repo/pull/3"),
            Some(("mixedcase/repo".into(), 3))
        );
        assert_eq!(parse_pr_url("https://github.com/o/r/issues/12"), None);
        assert_eq!(parse_pr_url("https://gitlab.com/o/r/pull/12"), None);
        assert_eq!(parse_pr_url("https://github.com.evil.io/o/r/pull/12"), None);
        assert_eq!(parse_pr_url("https://github.com/o/r/pull/abc"), None);
        assert_eq!(parse_pr_url("https://github.com/o/r/pull/0"), None);
        assert_eq!(parse_pr_url("https://github.com/o/pull/12"), None);
        assert_eq!(parse_pr_url("not a url"), None);
    }

    #[test]
    fn parse_github_slug_handles_https_and_ssh_remotes() {
        for url in [
            "https://github.com/Octo/Repo.git",
            "https://github.com/Octo/Repo",
            "https://user:token@github.com/Octo/Repo.git/",
            "git@github.com:Octo/Repo.git",
            "ssh://git@github.com/Octo/Repo.git",
        ] {
            assert_eq!(
                parse_github_slug(url).as_deref(),
                Some("octo/repo"),
                "{url}"
            );
        }
        assert_eq!(parse_github_slug("git@gitlab.com:o/r.git"), None);
        assert_eq!(parse_github_slug("/local/path/repo"), None);
    }

    #[test]
    fn note_branch_ignores_default_and_detached() {
        let conn = conn();
        for branch in [
            None,
            Some(""),
            Some("  "),
            Some("main"),
            Some("master"),
            Some("HEAD"),
        ] {
            note_branch_with(&conn, "s1", "/work", branch, repo);
        }
        assert!(pr_store::session_branches(&conn, "s1").unwrap().is_empty());
    }

    #[test]
    fn note_branch_ignores_checkout_without_github_remote() {
        let conn = conn();
        note_branch_with(&conn, "s1", "/work", Some("feat/a"), |_| None);
        assert!(pr_store::session_branches(&conn, "s1").unwrap().is_empty());
    }

    #[test]
    fn note_branch_records_non_default_branch_once_per_branch_with_repo() {
        let conn = conn();
        note_branch_with(&conn, "s1", "/work", Some("feat/a"), repo);
        note_branch_with(&conn, "s1", "/work", Some("feat/a"), repo);
        assert_eq!(
            pr_store::session_branches(&conn, "s1").unwrap(),
            vec![("Octo/Repo".to_string(), "feat/a".to_string())]
        );
        let source: String = conn
            .query_row("SELECT source FROM session_branches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "save");
    }

    #[test]
    fn note_branch_with_source_records_the_given_source() {
        let conn = conn();
        assert!(note_branch_with_source(
            &conn,
            "s1",
            "/work",
            Some("feat/a"),
            "trace2",
            repo
        ));
        let source: String = conn
            .query_row("SELECT source FROM session_branches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "trace2");
        // Seeing the same branch again changes nothing a PR set shows.
        assert!(!note_branch_with_source(
            &conn,
            "s1",
            "/work",
            Some("feat/a"),
            "trace2",
            repo
        ));
        assert!(!note_branch_with_source(
            &conn,
            "s1",
            "/work",
            Some("main"),
            "trace2",
            repo
        ));
        assert!(!note_branch_with_source(
            &conn,
            "s1",
            "/work",
            Some("feat/b"),
            "trace2",
            |_| None
        ));
    }

    #[test]
    fn switching_branches_keeps_both_branches_for_session() {
        let conn = conn();
        note_branch_with(&conn, "s1", "/work", Some("feat/a"), repo);
        note_branch_with(&conn, "s1", "/work", Some("feat/b"), repo);
        note_branch_with(&conn, "s2", "/work", Some("feat/c"), repo);
        let mut branches: Vec<String> = pr_store::session_branches(&conn, "s1")
            .unwrap()
            .into_iter()
            .map(|(_, branch)| branch)
            .collect();
        branches.sort();
        assert_eq!(branches, vec!["feat/a", "feat/b"]);
        assert_eq!(pr_store::session_branches(&conn, "s2").unwrap().len(), 1);
    }

    #[test]
    fn record_url_marks_owned() {
        let conn = conn();
        record_url(&conn, "s1", "https://github.com/o/r/pull/12").unwrap();
        assert_eq!(
            pr_store::session_pr_keys(&conn, "s1").unwrap(),
            vec![("o/r".to_string(), 12, Relation::Owned, false)]
        );
        let source: String = conn
            .query_row("SELECT source FROM session_prs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "create");
        assert!(record_url(&conn, "s1", "https://github.com/o/r/issues/3").is_err());
    }

    #[test]
    fn bounded_hints_drops_zero_and_caps_list() {
        assert_eq!(bounded_hints(&[0, 5, 0, 5, 7]), vec![5, 7]);
        let many: Vec<u32> = (0..200).collect();
        let bounded = bounded_hints(&many);
        assert_eq!(bounded.len(), MAX_HINTS);
        assert_eq!(bounded.first(), Some(&1));
        assert_eq!(bounded.last(), Some(&50));
    }

    #[test]
    fn record_hints_skips_zero_and_caps_at_fifty() {
        let conn = conn();
        let many: Vec<u32> = (0..200).collect();
        record_hints(&conn, "s1", "o/r", &many).unwrap();
        let keys = pr_store::session_pr_keys(&conn, "s1").unwrap();
        assert_eq!(keys.len(), MAX_HINTS);
        assert!(keys.iter().all(|(_, n, _, _)| *n != 0));
    }

    #[test]
    fn record_hints_marks_existing_without_downgrading_owned() {
        let conn = conn();
        record_url(&conn, "s1", "https://github.com/o/r/pull/12").unwrap();
        record_hints(&conn, "s1", "o/r", &[12, 13, 13]).unwrap();
        assert_eq!(
            pr_store::session_pr_keys(&conn, "s1").unwrap(),
            vec![
                ("o/r".to_string(), 12, Relation::Owned, false),
                ("o/r".to_string(), 13, Relation::Existing, false),
            ]
        );
    }
}
