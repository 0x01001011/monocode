//! Persistence and wire types for per-chat pull request tracking.
//!
//! Tables are unversioned (`CREATE TABLE IF NOT EXISTS`, no `schema_migrations`
//! row) because other builds share this database and own those numbers.

// Later tracking modules consume these items; until they land the non-test
// build sees them as unused.
#![allow(dead_code)]

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::pr_stack;

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
/// Ordered by urgency: `None < Pending < Action < Block`.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
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
    /// `"owner/repo#N"` (repo lowercased) for every PR counted in `count`,
    /// so the sidebar can match a linked PR without loading the set.
    pub members: Vec<String>,
}

/// One member of a stack as the Inbox rail shows it.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrEntryLite {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PrState,
    pub is_draft: bool,
    pub head_ref: String,
    pub base_ref: String,
    pub checks: Checks,
    pub attention: Attention,
    pub attention_reason: Option<String>,
    /// Chats this PR is attributed to (created it, or worked on its head).
    pub owner_session_ids: Vec<String>,
    /// Not the viewed PR and shares no chat with it.
    pub is_neighbor: bool,
}

/// The stack holding one PR, with an entry per member in `group.members` order.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrStackView {
    pub group: PrStackGroup,
    pub entries: Vec<PrEntryLite>,
}

/// What `pr_stack::stack_view_for` needs from storage for one repo.
#[derive(Default)]
pub struct RepoStackInputs {
    pub snapshots: Vec<PrSnapshot>,
    /// `(session_id, number, relation)` rows of `session_prs`.
    pub claims: Vec<(String, u32, Relation)>,
    /// `(session_id, branch)` rows of `session_branches`.
    pub branches: Vec<(String, String)>,
}

/// Snapshots and attribution rows of one (lowercase) repo. Cheap reads only,
/// so the caller can release the lock before deriving stacks.
pub fn repo_stack_inputs(conn: &Connection, repo: &str) -> RepoStackInputs {
    let claims = conn
        .prepare("SELECT session_id, number, relation FROM session_prs WHERE repo = ?1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([repo], |row| {
                let relation: String = row.get(2)?;
                Ok((row.get(0)?, row.get(1)?, Relation::parse(&relation)))
            })?;
            rows.collect()
        })
        .unwrap_or_default();
    let branches = conn
        .prepare("SELECT session_id, branch FROM session_branches WHERE repo = ?1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([repo], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        })
        .unwrap_or_default();
    RepoStackInputs {
        snapshots: repo_snapshots(conn, repo),
        claims,
        branches,
    }
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

/// Upsert: keeps `first_seen`, bumps `last_seen`. A `trace2` sighting upgrades
/// the row's source so "git activity is observed for this chat" stays visible
/// even when a save recorded the branch first.
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
         DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen),
                       source = CASE WHEN excluded.source = 'trace2' THEN 'trace2' ELSE source END",
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

/// `(ref_name, at)` rows recorded for a PR, oldest first.
pub fn base_history(
    conn: &Connection,
    repo: &str,
    number: u32,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT ref_name, at FROM pr_base_history
         WHERE repo = ?1 AND number = ?2 ORDER BY at, rowid",
    )?;
    let rows = stmt.query_map(params![repo, number], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Chats that still exist, are not archived and have a branch or PR on record.
pub fn tracked_sessions(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM sessions
         WHERE archived = 0
           AND (id IN (SELECT session_id FROM session_branches)
                OR id IN (SELECT session_id FROM session_prs))
         ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// True when git activity of this chat was observed through trace2.
pub fn session_has_trace2(conn: &Connection, session_id: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM session_branches
                        WHERE session_id = ?1 AND source = 'trace2')",
        [session_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found != 0)
    .unwrap_or(false)
}

/// `(repo, branch)` the chat touched most recently.
pub fn last_branch(conn: &Connection, session_id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT repo, branch FROM session_branches
         WHERE session_id = ?1 ORDER BY last_seen DESC, rowid DESC LIMIT 1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// Cached `behindBy` of `head_oid` against `base_oid`.
pub fn load_compare(conn: &Connection, repo: &str, head_oid: &str, base_oid: &str) -> Option<u32> {
    conn.query_row(
        "SELECT behind_by FROM pr_compare
         WHERE repo = ?1 AND head_oid = ?2 AND base_oid = ?3",
        params![repo, head_oid, base_oid],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|n| u32::try_from(n).ok())
}

pub fn store_compare(
    conn: &Connection,
    repo: &str,
    head_oid: &str,
    base_oid: &str,
    behind_by: u32,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO pr_compare (repo, head_oid, base_oid, behind_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (repo, head_oid, base_oid) DO UPDATE SET behind_by = excluded.behind_by",
        params![repo, head_oid, base_oid, behind_by],
    )?;
    Ok(())
}

/// Every stored snapshot of one repo; unreadable rows are skipped.
fn repo_snapshots(conn: &Connection, repo: &str) -> Vec<PrSnapshot> {
    let Ok(mut stmt) = conn.prepare("SELECT snapshot_json FROM pr_snapshots WHERE repo = ?1")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([repo], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|json| serde_json::from_str(&json).ok())
        .collect()
}

fn make_entry(
    snapshot: PrSnapshot,
    relation: Relation,
    owner_session_id: Option<String>,
    dismissed: bool,
    live_branch: Option<(&str, &str)>,
) -> PrEntry {
    // Another chat's PR is never "this chat's live branch".
    let on_live_branch = relation != Relation::Other
        && live_branch.is_some_and(|(repo, branch)| {
            snapshot.repo.eq_ignore_ascii_case(repo) && snapshot.head_ref == branch
        });
    let error = crate::pr_tracker::pr_error(&snapshot.repo, snapshot.number);
    PrEntry {
        snapshot,
        relation,
        owner_session_id,
        on_live_branch,
        parent: None,
        attention: Attention::None,
        attention_reason: None,
        dismissed,
        error,
    }
}

/// The chat's own PR rows that already have a snapshot, in first-seen order.
/// Whether a `session_prs` row counts as "from this chat": every PR the chat
/// created, and any other only when its head is a branch the chat worked on
/// in that repo. A PR merely mentioned in a transcript stays out.
fn is_attributed(relation: Relation, snapshot: &PrSnapshot, branches: &[(String, String)]) -> bool {
    relation == Relation::Owned
        || branches
            .iter()
            .any(|(repo, branch)| *repo == snapshot.repo && *branch == snapshot.head_ref)
}

/// The chat's own rows with a snapshot, filtered by `is_attributed`. Both
/// `build_set_view` and (through it) `build_summaries` read only these.
fn own_entries(
    conn: &Connection,
    session_id: &str,
    live_branch: Option<(&str, &str)>,
) -> Vec<PrEntry> {
    let branches = session_branches(conn, session_id).unwrap_or_default();
    session_pr_keys(conn, session_id)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(repo, number, relation, dismissed)| {
            let snapshot = load_snapshot(conn, &repo, number)?;
            is_attributed(relation, &snapshot, &branches)
                .then(|| make_entry(snapshot, relation, None, dismissed, live_branch))
        })
        .collect()
}

/// PR numbers connected to `seeds` by walking stack edges up and down.
fn stack_neighbors(
    pool: &[PrSnapshot],
    repo: &str,
    seeds: &[u32],
) -> std::collections::BTreeSet<u32> {
    let parents = pr_stack::derive_parents(pool);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for ((parent_repo, child), parent) in &parents {
        if parent_repo == repo {
            children.entry(*parent).or_default().push(*child);
        }
    }
    let mut wanted = std::collections::BTreeSet::new();
    for &seed in seeds {
        let mut seen = std::collections::HashSet::from([seed]);
        let mut current = seed;
        while let Some(&parent) = parents.get(&(repo.to_string(), current)) {
            if !seen.insert(parent) {
                break;
            }
            wanted.insert(parent);
            current = parent;
        }
        let mut pending = vec![seed];
        while let Some(number) = pending.pop() {
            for &child in children.get(&number).into_iter().flatten() {
                if seen.insert(child) {
                    wanted.insert(child);
                    pending.push(child);
                }
            }
        }
    }
    wanted
}

/// The PRs of one chat plus their stack neighbors. `live_branch` is
/// `(repo, branch)` of the chat's current checkout. Rows that have no
/// snapshot yet are omitted; the caller shows a confirming state from the
/// empty list and `status`. Storage errors degrade to a smaller list.
pub fn build_set_view(
    conn: &Connection,
    session_id: &str,
    live_branch: Option<(&str, &str)>,
    status: TrackerStatus,
    _now: i64,
) -> PrSetView {
    let mut entries = own_entries(conn, session_id, live_branch);

    let own: std::collections::HashSet<(String, u32)> = entries
        .iter()
        .map(|e| (e.snapshot.repo.clone(), e.snapshot.number))
        .collect();
    let repos: std::collections::BTreeSet<String> =
        entries.iter().map(|e| e.snapshot.repo.clone()).collect();
    for repo in repos {
        let pool = repo_snapshots(conn, &repo);
        let seeds: Vec<u32> = own
            .iter()
            .filter(|(r, _)| *r == repo)
            .map(|(_, n)| *n)
            .collect();
        for number in stack_neighbors(&pool, &repo, &seeds) {
            if own.contains(&(repo.clone(), number)) {
                continue;
            }
            let Some(snapshot) = pool.iter().find(|s| s.number == number).cloned() else {
                continue;
            };
            let owner = owners_of(conn, &repo, number)
                .unwrap_or_default()
                .into_iter()
                .find(|id| id != session_id);
            entries.push(make_entry(
                snapshot,
                Relation::Other,
                owner,
                false,
                live_branch,
            ));
        }
    }

    let snapshots: Vec<PrSnapshot> = entries.iter().map(|e| e.snapshot.clone()).collect();
    let parents = pr_stack::derive_parents(&snapshots);
    for entry in &mut entries {
        entry.parent = parents
            .get(&(entry.snapshot.repo.clone(), entry.snapshot.number))
            .copied();
        let parent = entry.parent.and_then(|number| {
            snapshots
                .iter()
                .find(|s| s.repo == entry.snapshot.repo && s.number == number)
        });
        let (attention, reason) = pr_stack::attention_for(&pr_stack::PrEntryInputs {
            snapshot: &entry.snapshot,
            parent,
            base_ref_label: entry.snapshot.base_ref.clone(),
        });
        entry.attention = attention;
        entry.attention_reason = reason;
    }
    entries.sort_by(|a, b| {
        let key = |e: &PrEntry| {
            (
                !e.on_live_branch,
                e.snapshot.state != PrState::Open,
                std::cmp::Reverse(e.snapshot.number),
                e.snapshot.repo.clone(),
            )
        };
        key(a).cmp(&key(b))
    });

    let has_branches = session_branches(conn, session_id).is_ok_and(|b| !b.is_empty());
    PrSetView {
        session_id: session_id.to_string(),
        refreshed_at: entries.iter().map(|e| e.snapshot.fetched_at).max(),
        stacks: pr_stack::group_stacks(&snapshots, &parents),
        tracking: pr_stack::tracking_for(session_has_trace2(conn, session_id), has_branches),
        entries,
        status,
    }
}

/// Primary entry for a chat: the one on its live branch, else the newest open
/// one, else the newest. Dismissed and `Other` entries never qualify.
pub fn pick_primary(entries: &[PrEntry]) -> Option<&PrEntry> {
    let eligible = || {
        entries
            .iter()
            .filter(|e| !e.dismissed && e.relation != Relation::Other)
    };
    eligible()
        .filter(|e| e.on_live_branch)
        .max_by_key(|e| (e.snapshot.state == PrState::Open, e.snapshot.number))
        .or_else(|| {
            eligible()
                .filter(|e| e.snapshot.state == PrState::Open)
                .max_by_key(|e| e.snapshot.number)
        })
        .or_else(|| eligible().max_by_key(|e| e.snapshot.number))
}

/// A summary is stale when its freshest snapshot is older than this.
const STALE_AFTER_MS: i64 = 10 * 60 * 1000;

/// One summary per live (not archived) chat with at least one visible
/// snapshot-backed PR. The primary PR agrees with the chip: the live branch
/// is the chat's stored `sessions.branch`, matched by head branch name.
/// `attention` is the most urgent one among the visible PRs.
pub fn build_summaries(conn: &Connection, now: i64) -> HashMap<String, PrSummary> {
    let chats: Vec<(String, Option<String>)> = conn
        .prepare(
            "SELECT s.id, s.branch FROM sessions s
             WHERE s.archived = 0
               AND s.id IN (SELECT session_id FROM session_prs)",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        })
        .unwrap_or_default();
    let mut summaries = HashMap::new();
    for (id, branch) in chats {
        // Status is not part of a summary; the view is only used for its
        // entries, which carry stack-aware attention.
        let view = build_set_view(conn, &id, None, TrackerStatus::Idle, now);
        let entries: Vec<PrEntry> = view
            .entries
            .into_iter()
            .filter(|e| !e.dismissed && e.relation != Relation::Other)
            .map(|mut e| {
                e.on_live_branch = branch.as_deref() == Some(e.snapshot.head_ref.as_str());
                e
            })
            .collect();
        let Some(primary) = pick_primary(&entries) else {
            continue;
        };
        let freshest = entries.iter().map(|e| e.snapshot.fetched_at).max();
        summaries.insert(
            id,
            PrSummary {
                count: entries.len() as u32,
                primary_number: primary.snapshot.number,
                primary_state: primary.snapshot.state,
                primary_is_draft: primary.snapshot.is_draft,
                attention: entries
                    .iter()
                    .map(|e| e.attention)
                    .max()
                    .unwrap_or(Attention::None),
                stale: freshest.is_some_and(|at| now - at > STALE_AFTER_MS),
                members: entries
                    .iter()
                    .map(|e| format!("{}#{}", e.snapshot.repo.to_lowercase(), e.snapshot.number))
                    .collect(),
            },
        );
    }
    summaries
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
    fn record_branch_upgrades_source_to_trace2_but_never_back() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let source = |conn: &Connection| -> String {
            conn.query_row("SELECT source FROM session_branches", [], |r| r.get(0))
                .unwrap()
        };
        record_branch(&conn, "s1", "o/r", "feat/a", "save", 1).unwrap();
        assert_eq!(source(&conn), "save");
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 2).unwrap();
        assert_eq!(source(&conn), "trace2");
        record_branch(&conn, "s1", "o/r", "feat/a", "save", 3).unwrap();
        assert_eq!(source(&conn), "trace2");
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

    fn pr_snap(
        repo: &str,
        number: u32,
        head: &str,
        base: &str,
        original_base: &str,
        state: PrState,
        fetched_at: i64,
    ) -> PrSnapshot {
        PrSnapshot {
            head_ref: head.into(),
            base_ref: base.into(),
            original_base_ref: original_base.into(),
            state,
            is_draft: false,
            checks: Checks::Passing,
            review: Review::None,
            mergeable: Mergeable::Mergeable,
            behind_by: None,
            fetched_at,
            ..snap(repo, number)
        }
    }

    fn put(conn: &Connection, session: &str, snapshot: &PrSnapshot, relation: Relation) {
        upsert_snapshot(conn, snapshot).unwrap();
        record_pr(
            conn,
            session,
            &snapshot.repo,
            snapshot.number,
            relation,
            "url",
            1,
        )
        .unwrap();
    }

    fn numbers(view: &PrSetView) -> Vec<u32> {
        view.entries.iter().map(|e| e.snapshot.number).collect()
    }

    #[test]
    fn two_sessions_same_checkout_see_only_their_prs() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        // Both chats work in one checkout and both visited `shared`.
        record_branch(&conn, "s1", "o/r", "shared", "trace2", 1).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 2).unwrap();
        record_branch(&conn, "s2", "o/r", "shared", "trace2", 1).unwrap();
        record_branch(&conn, "s2", "o/r", "feat/b", "trace2", 3).unwrap();
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 1, "feat/a", "main", "main", PrState::Open, 10),
            Relation::Owned,
        );
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 2, "feat/b", "main", "main", PrState::Open, 10),
            Relation::Owned,
        );

        let v1 = build_set_view(&conn, "s1", Some(("o/r", "feat/a")), TrackerStatus::Ok, 100);
        let v2 = build_set_view(&conn, "s2", Some(("o/r", "feat/b")), TrackerStatus::Ok, 100);
        assert_eq!(numbers(&v1), vec![1]);
        assert_eq!(numbers(&v2), vec![2]);
        assert!(v1.entries[0].on_live_branch);
        assert_eq!(v1.entries[0].relation, Relation::Owned);
        // Unrelated PRs of the same repo are not stack neighbors.
        assert!(v1.stacks.is_empty());
        assert_eq!(v1.session_id, "s1");
        let none = build_set_view(&conn, "s3", None, TrackerStatus::Idle, 100);
        assert!(none.entries.is_empty());
        assert_eq!(none.refreshed_at, None);
        assert_eq!(none.status, TrackerStatus::Idle);
    }

    #[test]
    fn branch_switch_twice_lists_both_prs_including_merged() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 1).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 2).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/c", "trace2", 3).unwrap();
        // #1 merged; #2 was retargeted to main by GitHub but began on feat/a.
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 1, "feat/a", "main", "main", PrState::Merged, 10),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/b", "main", "feat/a", PrState::Open, 20),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 3, "feat/c", "feat/b", "feat/b", PrState::Open, 30),
            Relation::Owned,
        );
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 9, "other", "main", "main", PrState::Open, 40),
            Relation::Owned,
        );

        let view = build_set_view(&conn, "s1", Some(("o/r", "feat/c")), TrackerStatus::Ok, 100);
        // Live branch first, then open before merged, higher number first.
        assert_eq!(numbers(&view), vec![3, 2, 1]);
        assert!(view.entries[0].on_live_branch);
        assert!(!view.entries[1].on_live_branch);
        assert_eq!(view.entries[2].snapshot.state, PrState::Merged);
        assert_eq!(view.entries[1].parent, Some(1));
        assert_eq!(view.entries[0].parent, Some(2));
        assert_eq!(view.entries[2].parent, None);
        assert_eq!(view.stacks.len(), 1);
        assert_eq!(view.stacks[0].members, vec![1, 2, 3]);
        assert_eq!(view.stacks[0].merged_count, 1);
        assert_eq!(view.stacks[0].base_ref, "main");
        assert_eq!(view.refreshed_at, Some(30));
        assert_eq!(view.tracking, Tracking::Full);
        // #2's parent merged: it needs a restack; the others are healthy.
        assert_eq!(view.entries[1].attention, Attention::Action);
        assert_eq!(
            view.entries[1].attention_reason.as_deref(),
            Some("Needs restack")
        );
        assert_eq!(view.entries[0].attention, Attention::None);
        assert_eq!(view.entries[2].attention, Attention::None);
    }

    #[test]
    fn live_branch_in_another_repo_is_not_marked_live() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 1, "feat/a", "main", "main", PrState::Open, 10),
            Relation::Owned,
        );
        let view = build_set_view(
            &conn,
            "s1",
            Some(("fork/r", "feat/a")),
            TrackerStatus::Ok,
            100,
        );
        assert!(!view.entries[0].on_live_branch);
    }

    #[test]
    fn rows_without_snapshot_are_omitted_and_dismissed_are_kept() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_pr(&conn, "s1", "o/r", 1, Relation::Owned, "url", 1).unwrap();
        // Found on a branch the chat worked on.
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 1).unwrap();
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/b", "main", "main", PrState::Open, 10),
            Relation::Existing,
        );
        set_dismissed(&conn, "s1", "o/r", 2, true).unwrap();
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Offline, 100);
        assert_eq!(numbers(&view), vec![2]);
        assert!(view.entries[0].dismissed);
        assert_eq!(view.entries[0].relation, Relation::Existing);
        assert_eq!(view.status, TrackerStatus::Offline);
    }

    #[test]
    fn stack_neighbors_of_other_chats_are_added_as_other() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        // s1 owns the middle PR; s2 owns the merged parent; nobody owns the child.
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 1, "feat/a", "main", "main", PrState::Merged, 10),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/b", "main", "feat/a", PrState::Open, 20),
            Relation::Owned,
        );
        upsert_snapshot(
            &conn,
            &pr_snap("o/r", 3, "feat/c", "feat/b", "feat/b", PrState::Open, 30),
        )
        .unwrap();
        // A sibling of the parent and a stranger in another repo are not neighbors.
        upsert_snapshot(
            &conn,
            &pr_snap("o/r", 4, "feat/d", "feat/a", "feat/a", PrState::Open, 30),
        )
        .unwrap();
        upsert_snapshot(
            &conn,
            &pr_snap("x/y", 5, "feat/a", "main", "main", PrState::Open, 30),
        )
        .unwrap();

        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, 100);
        assert_eq!(numbers(&view), vec![3, 2, 1]);
        let by = |n: u32| {
            view.entries
                .iter()
                .find(|e| e.snapshot.number == n)
                .unwrap()
        };
        assert_eq!(by(2).relation, Relation::Owned);
        assert_eq!(by(1).relation, Relation::Other);
        assert_eq!(by(1).owner_session_id.as_deref(), Some("s2"));
        assert_eq!(by(3).relation, Relation::Other);
        assert_eq!(by(3).owner_session_id, None);
        assert_eq!(view.stacks[0].members, vec![1, 2, 3]);
        // s2 sees its own PR plus the child chain, owned by s1.
        let v2 = build_set_view(&conn, "s2", None, TrackerStatus::Ok, 100);
        let o2 = v2.entries.iter().find(|e| e.snapshot.number == 2).unwrap();
        assert_eq!(o2.relation, Relation::Other);
        assert_eq!(o2.owner_session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn closed_fork_pr_without_checks_builds_a_valid_entry() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut closed = pr_snap("o/r", 1, "patch-1", "main", "main", PrState::Closed, 10);
        closed.checks = Checks::None;
        closed.review = Review::None;
        closed.mergeable = Mergeable::Unknown;
        closed.author = None;
        record_branch(&conn, "s1", "o/r", "patch-1", "trace2", 1).unwrap();
        put(&conn, "s1", &closed, Relation::Existing);
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, 100);
        assert_eq!(view.entries[0].attention, Attention::None);
        assert_eq!(view.entries[0].attention_reason, None);
        assert_eq!(view.entries[0].error, None);
        assert!(view.stacks.is_empty());
    }

    #[test]
    fn tracking_is_limited_without_trace2() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "save", 1).unwrap();
        assert!(!session_has_trace2(&conn, "s1"));
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, 100);
        assert_eq!(view.tracking, Tracking::Limited);
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 2).unwrap();
        assert!(session_has_trace2(&conn, "s1"));
        assert!(!session_has_trace2(&conn, "s2"));
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, 100);
        assert_eq!(view.tracking, Tracking::Full);
    }

    #[test]
    fn last_branch_is_the_most_recently_seen() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert_eq!(last_branch(&conn, "s1"), None);
        record_branch(&conn, "s1", "o/r", "feat/a", "git", 1).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/b", "git", 5).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "git", 3).unwrap();
        assert_eq!(
            last_branch(&conn, "s1"),
            Some(("o/r".to_string(), "feat/b".to_string()))
        );
    }

    fn entry(
        number: u32,
        state: PrState,
        relation: Relation,
        live: bool,
        dismissed: bool,
    ) -> PrEntry {
        PrEntry {
            snapshot: pr_snap("o/r", number, "h", "main", "main", state, 10),
            relation,
            owner_session_id: None,
            on_live_branch: live,
            parent: None,
            attention: Attention::None,
            attention_reason: None,
            dismissed,
            error: None,
        }
    }

    #[test]
    fn pick_primary_prefers_live_then_newest_open_then_newest() {
        let live_merged = entry(1, PrState::Merged, Relation::Owned, true, false);
        let open_old = entry(2, PrState::Open, Relation::Owned, false, false);
        let open_new = entry(3, PrState::Open, Relation::Owned, false, false);
        let closed_newest = entry(4, PrState::Closed, Relation::Owned, false, false);
        let all = [
            live_merged.clone(),
            open_old.clone(),
            open_new.clone(),
            closed_newest.clone(),
        ];
        assert_eq!(pick_primary(&all).unwrap().snapshot.number, 1);
        assert_eq!(pick_primary(&all[1..]).unwrap().snapshot.number, 3);
        assert_eq!(pick_primary(&all[3..]).unwrap().snapshot.number, 4);
        // Dismissed and foreign entries never qualify.
        let skipped = [
            entry(5, PrState::Open, Relation::Owned, true, true),
            entry(6, PrState::Open, Relation::Other, true, false),
            open_old,
        ];
        assert_eq!(pick_primary(&skipped).unwrap().snapshot.number, 2);
        assert!(pick_primary(&skipped[..2]).is_none());
        assert!(pick_primary(&[]).is_none());
    }

    #[test]
    fn only_owned_prs_or_prs_on_tracked_branches_count_as_from_this_chat() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let now = 10_000_000;
        add_session(&conn, "s1", Some("feat/a"), false);
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 1).unwrap();
        // Owned always shows, whatever its branch.
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 1, "elsewhere", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        // Existing on a branch the chat worked on: shows.
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/a", "main", "main", PrState::Open, now),
            Relation::Existing,
        );
        // A transcript hint for someone else's PR: never "from this chat".
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 3, "their/branch", "main", "main", PrState::Open, now),
            Relation::Existing,
        );
        // Same branch name, other repo: not tracked there.
        put(
            &conn,
            "s1",
            &pr_snap("x/y", 4, "feat/a", "main", "main", PrState::Open, now),
            Relation::Existing,
        );
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, now);
        let mut shown = numbers(&view);
        shown.sort();
        assert_eq!(shown, vec![1, 2]);
        let summary = &build_summaries(&conn, now)["s1"];
        assert_eq!(summary.count, 2);
        assert_eq!(
            summary.members,
            vec!["o/r#2".to_string(), "o/r#1".to_string()]
        );
    }

    #[test]
    fn summary_members_list_own_visible_prs_lowercased() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let now = 10_000_000;
        add_session(&conn, "s1", None, false);
        put(
            &conn,
            "s1",
            &pr_snap("Octo/Repo", 9, "a", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap("Octo/Repo", 8, "b", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        set_dismissed(&conn, "s1", "Octo/Repo", 8, true).unwrap();
        let summary = &build_summaries(&conn, now)["s1"];
        assert_eq!(summary.members, vec!["octo/repo#9".to_string()]);
        let v = serde_json::to_value(summary).unwrap();
        assert_eq!(v["members"], serde_json::json!(["octo/repo#9"]));
        assert_eq!(v["primaryIsDraft"], false);
    }

    #[test]
    fn summaries_pick_live_or_newest_open_as_primary() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let now = 10_000_000;
        add_session(&conn, "s1", Some("feat/a"), false);
        add_session(&conn, "s2", None, false);
        // s1: live branch is feat/a whose PR is merged; it stays primary.
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 1).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 2).unwrap();
        put(
            &conn,
            "s1",
            &pr_snap(
                "o/r",
                1,
                "feat/a",
                "main",
                "main",
                PrState::Merged,
                now - 1000,
            ),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap(
                "o/r",
                2,
                "feat/b",
                "main",
                "main",
                PrState::Open,
                now - 1000,
            ),
            Relation::Owned,
        );
        // s2: no branch on record, so the newest open PR wins; one is dismissed.
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 3, "x", "main", "main", PrState::Open, now - 700_000),
            Relation::Owned,
        );
        put(
            &conn,
            "s2",
            &pr_snap(
                "o/r",
                4,
                "y",
                "main",
                "main",
                PrState::Closed,
                now - 700_000,
            ),
            Relation::Owned,
        );
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 5, "z", "main", "main", PrState::Open, now - 700_000),
            Relation::Owned,
        );
        set_dismissed(&conn, "s2", "o/r", 5, true).unwrap();
        // s3: a row without a snapshot only; s4: only dismissed.
        record_pr(&conn, "s3", "o/r", 6, Relation::Owned, "url", 1).unwrap();
        put(
            &conn,
            "s4",
            &pr_snap("o/r", 7, "w", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        set_dismissed(&conn, "s4", "o/r", 7, true).unwrap();

        let summaries = build_summaries(&conn, now);
        assert_eq!(summaries.len(), 2);
        let s1 = &summaries["s1"];
        assert_eq!((s1.count, s1.primary_number), (2, 1));
        assert_eq!(s1.primary_state, PrState::Merged);
        assert!(!s1.stale);
        assert_eq!(s1.attention, Attention::None);
        let s2 = &summaries["s2"];
        assert_eq!((s2.count, s2.primary_number), (2, 3));
        assert_eq!(s2.primary_state, PrState::Open);
        assert!(s2.stale);
    }

    fn add_session(conn: &Connection, id: &str, branch: Option<&str>, archived: bool) {
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at,
                                   updated_at, branch, archived)
             VALUES (?1, '/work', 'claude', 'm', 'default', 't', 1, 1, ?2, ?3)",
            params![id, branch, archived as i64],
        )
        .unwrap();
    }

    #[test]
    fn compare_cache_roundtrips_by_oid_pair() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert_eq!(load_compare(&conn, "o/r", "h1", "b1"), None);
        store_compare(&conn, "o/r", "h1", "b1", 3).unwrap();
        assert_eq!(load_compare(&conn, "o/r", "h1", "b1"), Some(3));
        assert_eq!(load_compare(&conn, "o/r", "h1", "b2"), None);
        assert_eq!(load_compare(&conn, "x/y", "h1", "b1"), None);
        store_compare(&conn, "o/r", "h1", "b1", 5).unwrap();
        assert_eq!(load_compare(&conn, "o/r", "h1", "b1"), Some(5));
    }

    #[test]
    fn dismissed_entries_do_not_raise_summary_attention() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let now = 10_000_000;
        add_session(&conn, "s1", Some("feat/a"), false);
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 1, "feat/a", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        let mut failing = pr_snap("o/r", 2, "feat/b", "main", "main", PrState::Open, now);
        failing.checks = Checks::Failing;
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 1).unwrap();
        put(&conn, "s1", &failing, Relation::Existing);
        set_dismissed(&conn, "s1", "o/r", 2, true).unwrap();
        assert_eq!(build_summaries(&conn, now)["s1"].attention, Attention::None);

        let mut running = pr_snap("o/r", 3, "feat/c", "main", "main", PrState::Open, now);
        running.checks = Checks::Pending;
        put(&conn, "s1", &running, Relation::Owned);
        assert_eq!(
            build_summaries(&conn, now)["s1"].attention,
            Attention::Pending
        );

        set_dismissed(&conn, "s1", "o/r", 2, false).unwrap();
        assert_eq!(
            build_summaries(&conn, now)["s1"].attention,
            Attention::Block
        );
        // The set view still reports the dismissed entry's own attention.
        set_dismissed(&conn, "s1", "o/r", 2, true).unwrap();
        let view = build_set_view(&conn, "s1", None, TrackerStatus::Ok, now);
        let two = view
            .entries
            .iter()
            .find(|e| e.snapshot.number == 2)
            .unwrap();
        assert!(two.dismissed);
        assert_eq!(two.attention, Attention::Block);
        assert_eq!(two.attention_reason.as_deref(), Some("Checks failing"));
    }

    #[test]
    fn summary_primary_follows_session_branch_and_skips_archived() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let now = 10_000_000;
        // The stored live branch is feat/b, but the chat touched feat/a last.
        add_session(&conn, "s1", Some("feat/b"), false);
        record_branch(&conn, "s1", "o/r", "feat/b", "trace2", 1).unwrap();
        record_branch(&conn, "s1", "o/r", "feat/a", "trace2", 2).unwrap();
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/b", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 3, "feat/a", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        // Archived chats and deleted chats get no summary.
        add_session(&conn, "s2", Some("x"), true);
        put(
            &conn,
            "s2",
            &pr_snap("o/r", 4, "x", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        put(
            &conn,
            "gone",
            &pr_snap("o/r", 5, "y", "main", "main", PrState::Open, now),
            Relation::Owned,
        );
        let summaries = build_summaries(&conn, now);
        assert_eq!(summaries.len(), 1, "{summaries:?}");
        assert_eq!(summaries["s1"].primary_number, 2);
        assert_eq!(summaries["s1"].count, 2);
    }

    #[test]
    fn other_entries_are_never_on_live_branch() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        put(
            &conn,
            "s1",
            &pr_snap("o/r", 2, "feat/b", "main", "main", PrState::Open, 20),
            Relation::Owned,
        );
        upsert_snapshot(
            &conn,
            &pr_snap("o/r", 3, "feat/c", "feat/b", "feat/b", PrState::Open, 30),
        )
        .unwrap();
        let view = build_set_view(&conn, "s1", Some(("o/r", "feat/c")), TrackerStatus::Ok, 100);
        let three = view
            .entries
            .iter()
            .find(|e| e.snapshot.number == 3)
            .unwrap();
        assert_eq!(three.relation, Relation::Other);
        assert!(!three.on_live_branch);
        assert!(view.entries.iter().all(|e| !e.on_live_branch));
    }
}
