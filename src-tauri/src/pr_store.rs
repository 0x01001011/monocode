//! Persistence and wire types for per-chat pull request tracking.
//!
//! Tables are unversioned (`CREATE TABLE IF NOT EXISTS`, no `schema_migrations`
//! row) because other builds share this database and own those numbers.

// Later tracking modules consume these items; until they land the non-test
// build sees them as unused.
#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Checks {
    Passing,
    Failing,
    Pending,
    None,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // names fixed by the wire contract
pub enum Review {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // names fixed by the wire contract
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

/// Owned: created by this chat. Existing: on its branch but not created by it.
/// Other: belongs to another chat or user.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    Owned,
    Existing,
    Other,
}

impl Relation {
    fn as_str(self) -> &'static str {
        match self {
            Relation::Owned => "owned",
            Relation::Existing => "existing",
            Relation::Other => "other",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "owned" => Relation::Owned,
            "other" => Relation::Other,
            _ => Relation::Existing,
        }
    }
}

/// Dot on the chip: `Block` is filled, `Action` is a ring.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Attention {
    None,
    Pending,
    Action,
    Block,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Tracking {
    Full,
    Limited,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TrackerStatus {
    Ok,
    GhMissing,
    SignedOut,
    RateLimited { until: i64 },
    Offline,
    Idle,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrSnapshot {
    pub repo: String,
    pub number: u32,
    pub url: String,
    pub title: String,
    pub state: PrState,
    pub is_draft: bool,
    pub head_ref: String,
    pub base_ref: String,
    pub original_base_ref: String,
    pub head_oid: String,
    pub author: Option<String>,
    pub checks: Checks,
    pub review: Review,
    pub mergeable: Mergeable,
    pub behind_by: Option<u32>,
    /// Milliseconds since the epoch.
    pub fetched_at: i64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrEntry {
    pub snapshot: PrSnapshot,
    pub relation: Relation,
    pub owner_session_id: Option<String>,
    pub on_live_branch: bool,
    /// PR number in the same repo this one is stacked on.
    pub parent: Option<u32>,
    pub attention: Attention,
    /// For example "Checks failing", "Merge conflict", "Needs restack".
    pub attention_reason: Option<String>,
    pub dismissed: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrStackGroup {
    pub repo: String,
    pub base_ref: String,
    /// Base first, tip last.
    pub members: Vec<u32>,
    pub merged_count: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrSetView {
    pub session_id: String,
    pub entries: Vec<PrEntry>,
    pub stacks: Vec<PrStackGroup>,
    pub tracking: Tracking,
    pub status: TrackerStatus,
    pub refreshed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub count: u32,
    pub primary_number: u32,
    pub primary_state: PrState,
    pub primary_is_draft: bool,
    pub attention: Attention,
    pub stale: bool,
}

pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_branches (
           session_id TEXT NOT NULL,
           repo TEXT NOT NULL,
           branch TEXT NOT NULL,
           source TEXT NOT NULL,
           first_seen INTEGER NOT NULL,
           last_seen INTEGER NOT NULL,
           PRIMARY KEY (session_id, repo, branch)
         );
         CREATE TABLE IF NOT EXISTS session_prs (
           session_id TEXT NOT NULL,
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           relation TEXT NOT NULL,
           source TEXT NOT NULL,
           dismissed INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (session_id, repo, number)
         );
         CREATE INDEX IF NOT EXISTS session_prs_by_pr
           ON session_prs (repo, number);
         CREATE TABLE IF NOT EXISTS pr_snapshots (
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           snapshot_json TEXT NOT NULL,
           fetched_at INTEGER NOT NULL,
           PRIMARY KEY (repo, number)
         );
         CREATE TABLE IF NOT EXISTS pr_base_history (
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           ref_name TEXT NOT NULL,
           at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS pr_base_history_by_pr
           ON pr_base_history (repo, number, at);
         CREATE TABLE IF NOT EXISTS pr_interest (
           session_id TEXT PRIMARY KEY,
           level TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pr_tracker_lease (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           holder TEXT NOT NULL,
           expires_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pr_compare (
           repo TEXT NOT NULL,
           head_oid TEXT NOT NULL,
           base_oid TEXT NOT NULL,
           behind_by INTEGER NOT NULL,
           PRIMARY KEY (repo, head_oid, base_oid)
         );",
    )
}

/// Upsert: keeps `first_seen`, bumps `last_seen`.
pub fn record_branch(
    conn: &Connection,
    session_id: &str,
    repo: &str,
    branch: &str,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_branches (session_id, repo, branch, source, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (session_id, repo, branch)
         DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)",
        params![session_id, repo, branch, source, now],
    )?;
    Ok(())
}

/// `(repo, branch)` pairs, oldest first.
pub fn session_branches(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT repo, branch FROM session_branches
         WHERE session_id = ?1 ORDER BY first_seen, repo, branch",
    )?;
    let rows = stmt.query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Never downgrades `Owned` to a weaker relation and never clears `dismissed`.
pub fn record_pr(
    conn: &Connection,
    session_id: &str,
    repo: &str,
    number: u32,
    relation: Relation,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_prs (session_id, repo, number, relation, source, dismissed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT (session_id, repo, number)
         DO UPDATE SET relation = CASE
           WHEN session_prs.relation = 'owned' THEN 'owned'
           ELSE excluded.relation END",
        params![session_id, repo, number, relation.as_str(), source, now],
    )?;
    Ok(())
}

/// `(repo, number, relation, dismissed)`, in the order the chat first saw them.
pub fn session_pr_keys(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<(String, u32, Relation, bool)>> {
    let mut stmt = conn.prepare(
        "SELECT repo, number, relation, dismissed FROM session_prs
         WHERE session_id = ?1 ORDER BY created_at, repo, number",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let relation: String = row.get(2)?;
        Ok((
            row.get(0)?,
            row.get(1)?,
            Relation::parse(&relation),
            row.get::<_, i64>(3)? != 0,
        ))
    })?;
    rows.collect()
}

pub fn set_dismissed(
    conn: &Connection,
    session_id: &str,
    repo: &str,
    number: u32,
    dismissed: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE session_prs SET dismissed = ?4
         WHERE session_id = ?1 AND repo = ?2 AND number = ?3",
        params![session_id, repo, number, dismissed as i64],
    )?;
    Ok(())
}

pub fn upsert_snapshot(conn: &Connection, snapshot: &PrSnapshot) -> rusqlite::Result<()> {
    let json = serde_json::to_string(snapshot)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO pr_snapshots (repo, number, snapshot_json, fetched_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (repo, number)
         DO UPDATE SET snapshot_json = excluded.snapshot_json,
                       fetched_at = excluded.fetched_at",
        params![snapshot.repo, snapshot.number, json, snapshot.fetched_at],
    )?;
    Ok(())
}

/// A missing row and an unreadable row both yield `None`.
pub fn load_snapshot(conn: &Connection, repo: &str, number: u32) -> Option<PrSnapshot> {
    let json: String = conn
        .query_row(
            "SELECT snapshot_json FROM pr_snapshots WHERE repo = ?1 AND number = ?2",
            params![repo, number],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    serde_json::from_str(&json).ok()
}

/// Appends a row each time the PR's base ref is observed to have changed.
pub fn record_base_change(
    conn: &Connection,
    repo: &str,
    number: u32,
    ref_name: &str,
    at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO pr_base_history (repo, number, ref_name, at) VALUES (?1, ?2, ?3, ?4)",
        params![repo, number, ref_name, at],
    )?;
    Ok(())
}

pub fn set_interest(
    conn: &Connection,
    session_id: &str,
    level: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO pr_interest (session_id, level, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (session_id)
         DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at",
        params![session_id, level, now],
    )?;
    Ok(())
}

/// `(session_id, level)` for every session that declared interest.
pub fn interest_levels(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT session_id, level FROM pr_interest ORDER BY session_id")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Every session id that claims this PR.
pub fn owners_of(conn: &Connection, repo: &str, number: u32) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT session_id FROM session_prs
         WHERE repo = ?1 AND number = ?2 ORDER BY session_id",
    )?;
    let rows = stmt.query_map(params![repo, number], |row| row.get(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::SessionStore;

    fn snap(repo: &str, number: u32) -> PrSnapshot {
        PrSnapshot {
            repo: repo.into(),
            number,
            url: format!("https://github.com/{repo}/pull/{number}"),
            title: "Add thing \u{1F680} \u{65E5}\u{672C}".into(),
            state: PrState::Open,
            is_draft: true,
            head_ref: "feat/a".into(),
            base_ref: "main".into(),
            original_base_ref: "main".into(),
            head_oid: "abc123".into(),
            author: Some("octocat".into()),
            checks: Checks::Failing,
            review: Review::ChangesRequested,
            mergeable: Mergeable::Conflicting,
            behind_by: Some(3),
            fetched_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        for table in [
            "session_branches",
            "session_prs",
            "pr_snapshots",
            "pr_base_history",
            "pr_interest",
            "pr_tracker_lease",
            "pr_compare",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} missing");
        }
    }

    #[test]
    fn record_branch_keeps_first_seen_and_updates_last_seen() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "git", 100).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "hint", 250).unwrap();
        let (first, last): (i64, i64) = conn
            .query_row(
                "SELECT first_seen, last_seen FROM session_branches
                 WHERE session_id = 's1' AND repo = 'o/r' AND branch = 'feat/a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((first, last), (100, 250));
        assert_eq!(
            session_branches(&conn, "s1").unwrap(),
            vec![("o/r".to_string(), "feat/a".to_string())]
        );
    }

    #[test]
    fn two_sessions_same_branch_stay_independent() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_branch(&conn, "s1", "o/r", "shared", "git", 1).unwrap();
        record_branch(&conn, "s2", "o/r", "other", "git", 2).unwrap();
        record_branch(&conn, "s2", "o/r", "shared", "git", 3).unwrap();
        assert_eq!(session_branches(&conn, "s1").unwrap().len(), 1);
        assert_eq!(session_branches(&conn, "s2").unwrap().len(), 2);
        assert!(session_branches(&conn, "s3").unwrap().is_empty());
    }

    #[test]
    fn record_pr_never_downgrades_owned() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_pr(&conn, "s1", "o/r", 7, Relation::Owned, "url", 1).unwrap();
        record_pr(&conn, "s1", "o/r", 7, Relation::Existing, "branch", 2).unwrap();
        assert_eq!(
            session_pr_keys(&conn, "s1").unwrap(),
            vec![("o/r".to_string(), 7, Relation::Owned, false)]
        );
        // Upgrading is allowed.
        record_pr(&conn, "s1", "o/r", 8, Relation::Existing, "branch", 3).unwrap();
        record_pr(&conn, "s1", "o/r", 8, Relation::Owned, "url", 4).unwrap();
        let keys = session_pr_keys(&conn, "s1").unwrap();
        assert!(keys.contains(&("o/r".to_string(), 8, Relation::Owned, false)));
    }

    #[test]
    fn snapshot_roundtrips_all_fields() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut s = snap("o/r", 5);
        upsert_snapshot(&conn, &s).unwrap();
        assert_eq!(load_snapshot(&conn, "o/r", 5), Some(s.clone()));
        assert_eq!(load_snapshot(&conn, "o/r", 6), None);
        s.state = PrState::Merged;
        s.author = None;
        s.behind_by = None;
        s.fetched_at += 5;
        upsert_snapshot(&conn, &s).unwrap();
        assert_eq!(load_snapshot(&conn, "o/r", 5), Some(s));
    }

    #[test]
    fn wire_names_match_contract() {
        assert_eq!(
            serde_json::to_string(&Review::ChangesRequested).unwrap(),
            "\"changesRequested\""
        );
        assert_eq!(
            serde_json::to_string(&Review::ReviewRequired).unwrap(),
            "\"reviewRequired\""
        );
        assert_eq!(serde_json::to_string(&Checks::None).unwrap(), "\"none\"");
        let v = serde_json::to_value(snap("o/r", 1)).unwrap();
        assert_eq!(v["isDraft"], true);
        assert_eq!(v["originalBaseRef"], "main");
        assert_eq!(v["fetchedAt"], 1_700_000_000_000_i64);
    }

    #[test]
    fn dismiss_flag_persists() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_pr(&conn, "s1", "o/r", 7, Relation::Existing, "branch", 1).unwrap();
        set_dismissed(&conn, "s1", "o/r", 7, true).unwrap();
        assert!(session_pr_keys(&conn, "s1").unwrap()[0].3);
        // Re-recording must not resurrect a dismissed PR.
        record_pr(&conn, "s1", "o/r", 7, Relation::Existing, "branch", 2).unwrap();
        assert!(session_pr_keys(&conn, "s1").unwrap()[0].3);
        set_dismissed(&conn, "s1", "o/r", 7, false).unwrap();
        assert!(!session_pr_keys(&conn, "s1").unwrap()[0].3);
    }

    #[test]
    fn owners_of_returns_every_session_claiming_pr() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_pr(&conn, "s1", "o/r", 7, Relation::Owned, "url", 1).unwrap();
        record_pr(&conn, "s2", "o/r", 7, Relation::Existing, "branch", 2).unwrap();
        record_pr(&conn, "s3", "o/r", 8, Relation::Owned, "url", 3).unwrap();
        let mut owners = owners_of(&conn, "o/r", 7).unwrap();
        owners.sort();
        assert_eq!(owners, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn base_history_and_interest() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_base_change(&conn, "o/r", 7, "main", 10).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pr_base_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        set_interest(&conn, "s1", "hot", 1).unwrap();
        set_interest(&conn, "s1", "fleet", 2).unwrap();
        set_interest(&conn, "s2", "off", 3).unwrap();
        let mut levels = interest_levels(&conn).unwrap();
        levels.sort();
        assert_eq!(
            levels,
            vec![
                ("s1".to_string(), "fleet".to_string()),
                ("s2".to_string(), "off".to_string())
            ]
        );
    }
}
