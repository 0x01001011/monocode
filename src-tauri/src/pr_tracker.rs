//! Machine-wide pull request status tracker.
//!
//! One app instance at a time (SQLite lease) polls `gh api graphql` with
//! batched, aliased queries: one request per repo per cycle, at most
//! `MAX_ALIASES` aliases each. Discovery aliases find PRs on branches chats
//! worked on; refresh aliases update PRs chats already know. Results become
//! `pr_snapshots` rows and base-ref history, then `pr-set-changed` fires.
//! Failures never clear snapshots; they only change `status()`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pr_store::{
    self, Checks, Mergeable, PrSetView, PrSnapshot, PrState, PrSummary, Relation, Review,
    TrackerStatus,
};
use crate::session_store::{now_millis, validate_id, SessionStore};

/// Aliases per GraphQL request.
pub const MAX_ALIASES: usize = 20;
const CYCLE: Duration = Duration::from_secs(15);
const LEASE_TTL_MS: i64 = 60_000;
const HOT_MS: u64 = 30_000;
const FLEET_MS: u64 = 180_000;
const LOW_BUDGET_MS: u64 = 600_000;
const LOW_BUDGET: u32 = 500;
const DISCOVERY_HOT_MS: i64 = 60_000;
const DISCOVERY_FLEET_MS: i64 = 600_000;
/// Backoff assumed when GitHub reports a rate limit without a reset time.
const RATE_LIMIT_FALLBACK_MS: i64 = 60_000;

const PR_FIELDS: &str = "fragment PrFields on PullRequest { number url title state isDraft \
isCrossRepository headRepositoryOwner { login } headRefName baseRefName headRefOid \
author { login } mergeable reviewDecision \
commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } \
timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], first: 10) { nodes { \
... on BaseRefChangedEvent { previousRefName currentRefName createdAt } } } }";

/// One aliased lookup in a batched query. New lookup kinds (such as a branch
/// comparison) are added as variants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Discovery: recent PRs whose head is `branch`.
    Branch {
        alias: String,
        owner: String,
        name: String,
        branch: String,
    },
    /// Refresh: one known PR.
    Pr {
        alias: String,
        owner: String,
        name: String,
        number: u32,
    },
}

impl Target {
    fn alias(&self) -> &str {
        match self {
            Target::Branch { alias, .. } | Target::Pr { alias, .. } => alias,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseChange {
    pub previous: String,
    pub current: String,
    /// Milliseconds since the epoch.
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPr {
    pub snapshot: PrSnapshot,
    /// Oldest first.
    pub base_changes: Vec<BaseChange>,
    /// Owner of the head repository when the PR comes from a fork.
    pub fork_owner: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RateLimit {
    pub remaining: u32,
    /// Milliseconds since the epoch.
    pub reset_at: i64,
    pub cost: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedBatch {
    pub viewer: Option<String>,
    pub rate_limit: Option<RateLimit>,
    /// PRs per alias: at most one for `Target::Pr`, up to five for
    /// `Target::Branch`. A PR alias that failed has no entry.
    pub prs: HashMap<String, Vec<ParsedPr>>,
    /// GraphQL error message per alias whose lookup failed.
    pub errors: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrackerError {
    GhMissing,
    SignedOut,
    /// Backoff ends at this time (milliseconds since the epoch).
    RateLimited(i64),
    Offline,
    Other(String),
}

impl TrackerError {
    /// The tracker-wide status for errors that affect every request; `None`
    /// for errors scoped to one request.
    fn global_status(&self) -> Option<TrackerStatus> {
        match self {
            TrackerError::GhMissing => Some(TrackerStatus::GhMissing),
            TrackerError::SignedOut => Some(TrackerStatus::SignedOut),
            TrackerError::RateLimited(until) => Some(TrackerStatus::RateLimited { until: *until }),
            TrackerError::Offline => Some(TrackerStatus::Offline),
            TrackerError::Other(_) => None,
        }
    }
}

/// The network seam: runs one GraphQL query and returns the response JSON.
pub trait GhRunner {
    fn graphql(&self, cwd: &Path, query: &str) -> Result<String, String>;

    /// End of an active process-wide rate-limit backoff, in milliseconds.
    fn backoff_until(&self) -> Option<i64> {
        None
    }
}

/// GraphQL string literal for `value`.
fn gql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn valid_alias(alias: &str) -> bool {
    let mut chars = alias.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// One GraphQL document covering `targets`, plus `viewer` and `rateLimit`.
/// Targets with an alias that is not a GraphQL name are skipped.
pub fn build_query(targets: &[Target]) -> String {
    let mut query =
        String::from("query PrTracker { viewer { login } rateLimit { remaining resetAt cost }");
    for target in targets.iter().filter(|t| valid_alias(t.alias())) {
        match target {
            Target::Branch {
                alias,
                owner,
                name,
                branch,
            } => {
                let _ = write!(
                    query,
                    " {alias}: repository(owner: {}, name: {}) {{ nameWithOwner \
                     pullRequests(headRefName: {}, first: 5, states: [OPEN, MERGED, CLOSED], \
                     orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ ...PrFields }} }} }}",
                    gql_string(owner),
                    gql_string(name),
                    gql_string(branch),
                );
            }
            Target::Pr {
                alias,
                owner,
                name,
                number,
            } => {
                let _ = write!(
                    query,
                    " {alias}: repository(owner: {}, name: {}) {{ nameWithOwner \
                     pullRequest(number: {number}) {{ ...PrFields }} }}",
                    gql_string(owner),
                    gql_string(name),
                );
            }
        }
    }
    query.push_str(" } ");
    query.push_str(PR_FIELDS);
    query
}

fn rfc3339_ms(value: &str) -> Option<i64> {
    let at =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn parse_pr(repo: &str, pr: &Value, fetched_at: i64) -> Option<ParsedPr> {
    let number = pr["number"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)?;
    let state = match pr["state"].as_str()? {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => return None,
    };
    let base_changes: Vec<BaseChange> = pr["timelineItems"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|event| {
            Some(BaseChange {
                previous: event["previousRefName"].as_str()?.to_string(),
                current: event["currentRefName"].as_str()?.to_string(),
                at: rfc3339_ms(event["createdAt"].as_str()?)?,
            })
        })
        .collect();
    let base_ref = text(&pr["baseRefName"]);
    let original_base_ref = base_changes
        .first()
        .map(|change| change.previous.clone())
        .unwrap_or_else(|| base_ref.clone());
    let checks = match pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str() {
        Some("SUCCESS") => Checks::Passing,
        Some("FAILURE" | "ERROR") => Checks::Failing,
        Some("PENDING" | "EXPECTED") => Checks::Pending,
        _ => Checks::None,
    };
    let review = match pr["reviewDecision"].as_str() {
        Some("APPROVED") => Review::Approved,
        Some("CHANGES_REQUESTED") => Review::ChangesRequested,
        Some("REVIEW_REQUIRED") => Review::ReviewRequired,
        _ => Review::None,
    };
    let mergeable = match pr["mergeable"].as_str() {
        Some("MERGEABLE") => Mergeable::Mergeable,
        Some("CONFLICTING") => Mergeable::Conflicting,
        _ => Mergeable::Unknown,
    };
    let fork_owner = if pr["isCrossRepository"].as_bool() == Some(true) {
        pr["headRepositoryOwner"]["login"]
            .as_str()
            .map(str::to_string)
    } else {
        None
    };
    Some(ParsedPr {
        snapshot: PrSnapshot {
            repo: repo.to_string(),
            number,
            url: text(&pr["url"]),
            title: text(&pr["title"]),
            state,
            is_draft: pr["isDraft"].as_bool().unwrap_or(false),
            head_ref: text(&pr["headRefName"]),
            base_ref,
            original_base_ref,
            head_oid: text(&pr["headRefOid"]),
            author: pr["author"]["login"].as_str().map(str::to_string),
            checks,
            review,
            mergeable,
            behind_by: None,
            fetched_at,
        },
        base_changes,
        fork_owner,
    })
}

/// Maps a `gh api graphql` response to snapshots. Errors scoped to one alias
/// land in `errors`; a response without `data` is an error for the request.
pub fn parse_response(json: &str) -> Result<ParsedBatch, TrackerError> {
    let root: Value = serde_json::from_str(json)
        .map_err(|_| TrackerError::Other("GitHub returned an unreadable response".into()))?;
    let mut batch = ParsedBatch::default();
    let mut request_errors: Vec<(String, String)> = Vec::new();
    for error in root["errors"].as_array().into_iter().flatten() {
        let message = error["message"]
            .as_str()
            .unwrap_or("GitHub request failed")
            .to_string();
        match error["path"][0].as_str() {
            Some(alias) => {
                batch.errors.entry(alias.to_string()).or_insert(message);
            }
            None => request_errors.push((text(&error["type"]), message)),
        }
    }
    let Some(data) = root.get("data").and_then(Value::as_object) else {
        let (kind, message) = request_errors.into_iter().next().unwrap_or_else(|| {
            (
                String::new(),
                batch
                    .errors
                    .values()
                    .next()
                    .cloned()
                    .unwrap_or_else(|| "GitHub returned no data".into()),
            )
        });
        if kind == "RATE_LIMITED" {
            return Err(TrackerError::RateLimited(rate_limit_until(now_millis())));
        }
        return Err(classify_gh_error(&message));
    };
    batch.viewer = data
        .get("viewer")
        .and_then(|viewer| viewer["login"].as_str())
        .map(str::to_string);
    batch.rate_limit = data.get("rateLimit").and_then(|rate| {
        Some(RateLimit {
            remaining: u32::try_from(rate["remaining"].as_u64()?).ok()?,
            reset_at: rate["resetAt"].as_str().and_then(rfc3339_ms).unwrap_or(0),
            cost: rate["cost"]
                .as_u64()
                .and_then(|c| u32::try_from(c).ok())
                .unwrap_or(0),
        })
    });
    let fetched_at = now_millis();
    for (alias, value) in data {
        if alias == "viewer" || alias == "rateLimit" {
            continue;
        }
        let Some(repo) = value["nameWithOwner"].as_str().map(str::to_lowercase) else {
            batch
                .errors
                .entry(alias.clone())
                .or_insert_with(|| "Repository not found".into());
            continue;
        };
        let prs: Vec<ParsedPr> = if let Some(pr) = value.get("pullRequest") {
            if pr.is_null() {
                batch
                    .errors
                    .entry(alias.clone())
                    .or_insert_with(|| "Pull request not found".into());
                continue;
            }
            parse_pr(&repo, pr, fetched_at).into_iter().collect()
        } else {
            value["pullRequests"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|pr| parse_pr(&repo, pr, fetched_at))
                .collect()
        };
        batch.prs.insert(alias.clone(), prs);
    }
    Ok(batch)
}

fn system_time_ms(at: SystemTime) -> i64 {
    at.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// When the shared `gh` backoff ends, or a minute from `now` if none is set.
fn rate_limit_until(now: i64) -> i64 {
    crate::fs::github_rate_limit_until()
        .map(system_time_ms)
        .filter(|until| *until > now)
        .unwrap_or(now + RATE_LIMIT_FALLBACK_MS)
}

/// Sorts a failed `gh` run into the states the UI explains.
pub fn classify_gh_error(stderr: &str) -> TrackerError {
    let message = stderr.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| message.contains(needle));
    if has(&[
        "not installed",
        "executable file not found",
        "command not found",
    ]) {
        return TrackerError::GhMissing;
    }
    if has(&["rate limit", "abuse detection"]) {
        return TrackerError::RateLimited(rate_limit_until(now_millis()));
    }
    if has(&[
        "gh auth login",
        "bad credentials",
        "http 401",
        "not logged in",
        "authentication required",
    ]) {
        return TrackerError::SignedOut;
    }
    if has(&[
        "could not resolve host",
        "no such host",
        "error connecting to",
        "check your internet connection",
        "dial tcp",
        "connection refused",
        "connection reset",
        "network is unreachable",
        "i/o timeout",
        "tls handshake timeout",
    ]) {
        return TrackerError::Offline;
    }
    let first_line = stderr.trim().lines().next().unwrap_or_default().trim();
    let first_line = first_line.strip_prefix("gh: ").unwrap_or(first_line);
    TrackerError::Other(if first_line.is_empty() {
        "GitHub request failed".into()
    } else {
        first_line.to_string()
    })
}

/// How often to refresh a PR. `age_ms` is the snapshot's age, negative when
/// there is none yet. Terminal PRs are fetched once; `off` never polls.
pub fn tier_for(
    interest: &str,
    state: PrState,
    age_ms: i64,
    remaining: Option<u32>,
) -> Option<Duration> {
    if interest == "off" {
        return None;
    }
    if state != PrState::Open {
        return (age_ms < 0).then_some(Duration::ZERO);
    }
    let ms = if remaining.is_some_and(|left| left < LOW_BUDGET) {
        LOW_BUDGET_MS
    } else if interest == "hot" {
        HOT_MS
    } else {
        FLEET_MS
    };
    Some(Duration::from_millis(ms))
}

/// Takes or renews the machine-wide tracker lease. True when `holder` owns it
/// until `now + ttl_ms`.
pub fn acquire_lease(conn: &Connection, holder: &str, now: i64, ttl_ms: i64) -> bool {
    conn.execute(
        "INSERT INTO pr_tracker_lease (id, holder, expires_at) VALUES (1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE pr_tracker_lease.holder = excluded.holder OR pr_tracker_lease.expires_at <= ?3",
        params![holder, now.saturating_add(ttl_ms), now],
    )
    .map(|changed| changed == 1)
    .unwrap_or(false)
}

/// When each target was last attempted, so failures do not retry every cycle.
#[derive(Default)]
struct Timers {
    discovered: HashMap<(String, String), i64>,
    refreshed: HashMap<(String, u32), i64>,
    /// Sessions whose targets are due on the next cycle regardless of tier.
    forced: HashSet<String>,
}

pub struct Tracker {
    status: Mutex<TrackerStatus>,
    /// Last `rateLimit.remaining`; negative while unknown.
    remaining: AtomicI64,
    timers: Mutex<Timers>,
    /// Last lookup error per PR, cleared by the next successful fetch.
    errors: Mutex<HashMap<(String, u32), String>>,
    wake: Mutex<bool>,
    wake_cv: Condvar,
}

impl Tracker {
    fn new() -> Self {
        Self {
            status: Mutex::new(TrackerStatus::Idle),
            remaining: AtomicI64::new(-1),
            timers: Mutex::new(Timers::default()),
            errors: Mutex::new(HashMap::new()),
            wake: Mutex::new(false),
            wake_cv: Condvar::new(),
        }
    }

    fn status(&self) -> TrackerStatus {
        self.status
            .lock()
            .map(|s| *s)
            .unwrap_or(TrackerStatus::Idle)
    }

    fn set_status(&self, status: TrackerStatus) {
        if let Ok(mut slot) = self.status.lock() {
            *slot = status;
        }
    }

    fn remaining(&self) -> Option<u32> {
        u32::try_from(self.remaining.load(Ordering::Relaxed)).ok()
    }

    fn force(&self, session_id: &str) {
        if let Ok(mut timers) = self.timers.lock() {
            timers.forced.insert(session_id.to_string());
        }
    }

    fn set_error(&self, repo: &str, number: u32, error: Option<&str>) {
        if let Ok(mut errors) = self.errors.lock() {
            let key = (repo.to_string(), number);
            match error {
                Some(message) => {
                    errors.insert(key, message.to_string());
                }
                None => {
                    errors.remove(&key);
                }
            }
        }
    }

    fn error(&self, repo: &str, number: u32) -> Option<String> {
        self.errors
            .lock()
            .ok()?
            .get(&(repo.to_string(), number))
            .cloned()
    }

    fn wake(&self) {
        if let Ok(mut flag) = self.wake.lock() {
            *flag = true;
            self.wake_cv.notify_all();
        }
    }

    /// Sleeps up to `timeout` or until `wake`.
    fn wait(&self, timeout: Duration) {
        let Ok(flag) = self.wake.lock() else {
            std::thread::sleep(timeout);
            return;
        };
        if let Ok((mut flag, _)) = self
            .wake_cv
            .wait_timeout_while(flag, timeout, |woken| !*woken)
        {
            *flag = false;
        }
    }
}

static TRACKER: LazyLock<Tracker> = LazyLock::new(Tracker::new);

/// Process-wide tracker health, set by the polling loop.
pub fn status() -> TrackerStatus {
    TRACKER.status()
}

/// The last lookup error for a PR, if its most recent fetch failed.
pub fn pr_error(repo: &str, number: u32) -> Option<String> {
    TRACKER.error(repo, number)
}

struct RepoRequest {
    repo: String,
    targets: Vec<Target>,
}

struct Plan {
    requests: Vec<RepoRequest>,
    /// Non-off sessions that worked on each `(repo, branch)`.
    branch_sessions: HashMap<(String, String), Vec<String>>,
}

#[derive(Default)]
struct Want {
    hot: bool,
    forced: bool,
    sessions: Vec<String>,
}

enum Due {
    Branch(String),
    Pr(u32),
}

/// Picks this cycle's targets: per repo, forced first, then the most overdue,
/// at most `MAX_ALIASES`. Consumes `timers.forced`.
fn plan_cycle(
    conn: &Connection,
    timers: &mut Timers,
    remaining: Option<u32>,
    now: i64,
) -> rusqlite::Result<Plan> {
    let levels: HashMap<String, String> = pr_store::interest_levels(conn)?.into_iter().collect();
    let forced = std::mem::take(&mut timers.forced);
    let mut branches: BTreeMap<(String, String), Want> = BTreeMap::new();
    let mut prs: BTreeMap<(String, u32), Want> = BTreeMap::new();
    for session in pr_store::tracked_sessions(conn)? {
        let level = levels.get(&session).map_or("fleet", String::as_str);
        if level == "off" {
            continue;
        }
        let hot = level == "hot";
        let is_forced = forced.contains(&session);
        for key in pr_store::session_branches(conn, &session)? {
            let want = branches.entry(key).or_default();
            want.hot |= hot;
            want.forced |= is_forced;
            want.sessions.push(session.clone());
        }
        for (repo, number, _, _) in pr_store::session_pr_keys(conn, &session)? {
            let want = prs.entry((repo, number)).or_default();
            want.hot |= hot;
            want.forced |= is_forced;
        }
    }

    // (forced, overdue ms, target) per repo.
    let mut due: BTreeMap<String, Vec<(bool, i64, Due)>> = BTreeMap::new();
    for ((repo, branch), want) in &branches {
        let low_budget = remaining.is_some_and(|left| left < LOW_BUDGET);
        let interval = if want.hot && !low_budget {
            DISCOVERY_HOT_MS
        } else {
            DISCOVERY_FLEET_MS
        };
        let overdue = timers
            .discovered
            .get(&(repo.clone(), branch.clone()))
            .map_or(i64::MAX, |at| now - at - interval);
        if want.forced || overdue >= 0 {
            due.entry(repo.clone()).or_default().push((
                want.forced,
                overdue,
                Due::Branch(branch.clone()),
            ));
        }
    }
    for ((repo, number), want) in &prs {
        let snapshot = pr_store::load_snapshot(conn, repo, *number);
        let state = snapshot.as_ref().map_or(PrState::Open, |s| s.state);
        let age = snapshot.as_ref().map_or(-1, |s| now - s.fetched_at);
        let interest = if want.hot { "hot" } else { "fleet" };
        let tier = tier_for(interest, state, age, remaining);
        if tier.is_none() && !want.forced {
            continue;
        }
        let interval = tier.map_or(0, |t| i64::try_from(t.as_millis()).unwrap_or(i64::MAX));
        let last = snapshot
            .map(|s| s.fetched_at)
            .into_iter()
            .chain(timers.refreshed.get(&(repo.clone(), *number)).copied())
            .max();
        let overdue = last.map_or(i64::MAX, |at| now - at - interval);
        if want.forced || overdue >= 0 {
            due.entry(repo.clone())
                .or_default()
                .push((want.forced, overdue, Due::Pr(*number)));
        }
    }

    let mut requests = Vec::new();
    for (repo, mut items) in due {
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        items.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let targets = items
            .into_iter()
            .take(MAX_ALIASES)
            .enumerate()
            .map(|(i, (_, _, item))| match item {
                Due::Branch(branch) => Target::Branch {
                    alias: format!("b{i}"),
                    owner: owner.to_string(),
                    name: name.to_string(),
                    branch,
                },
                Due::Pr(number) => Target::Pr {
                    alias: format!("p{i}"),
                    owner: owner.to_string(),
                    name: name.to_string(),
                    number,
                },
            })
            .collect();
        requests.push(RepoRequest { repo, targets });
    }
    let branch_sessions = branches
        .into_iter()
        .map(|(key, want)| (key, want.sessions))
        .collect();
    Ok(Plan {
        requests,
        branch_sessions,
    })
}

fn mark_attempted(tracker: &Tracker, request: &RepoRequest, now: i64) {
    let Ok(mut timers) = tracker.timers.lock() else {
        return;
    };
    for target in &request.targets {
        match target {
            Target::Branch { branch, .. } => {
                timers
                    .discovered
                    .insert((request.repo.clone(), branch.clone()), now);
            }
            Target::Pr { number, .. } => {
                timers
                    .refreshed
                    .insert((request.repo.clone(), *number), now);
            }
        }
    }
}

/// Writes one fetched PR under the request's repo key. Keeps `behind_by`
/// while head and base are unchanged and appends unseen base changes.
fn write_pr(conn: &Connection, repo: &str, pr: &ParsedPr, now: i64) -> rusqlite::Result<()> {
    let mut snapshot = pr.snapshot.clone();
    snapshot.repo = repo.to_string();
    snapshot.fetched_at = now;
    if let Some(old) = pr_store::load_snapshot(conn, repo, snapshot.number) {
        if old.head_oid == snapshot.head_oid && old.base_ref == snapshot.base_ref {
            snapshot.behind_by = old.behind_by;
        }
    }
    pr_store::upsert_snapshot(conn, &snapshot)?;
    let history = pr_store::base_history(conn, repo, snapshot.number)?;
    for change in &pr.base_changes {
        let known = history
            .iter()
            .any(|(name, at)| *name == change.current && *at == change.at);
        if !known {
            pr_store::record_base_change(conn, repo, snapshot.number, &change.current, change.at)?;
        }
    }
    Ok(())
}

/// Applies one repo's response; returns the sessions whose PR set changed.
fn apply_batch(
    conn: &Connection,
    tracker: &Tracker,
    plan: &Plan,
    request: &RepoRequest,
    batch: &ParsedBatch,
    now: i64,
) -> rusqlite::Result<BTreeSet<String>> {
    let repo = request.repo.as_str();
    let mut touched: BTreeSet<u32> = BTreeSet::new();
    for target in &request.targets {
        let found = batch.prs.get(target.alias());
        match target {
            Target::Pr { alias, number, .. } => {
                for pr in found.into_iter().flatten() {
                    write_pr(conn, repo, pr, now)?;
                }
                let error = batch.errors.get(alias).map(String::as_str);
                tracker.set_error(repo, *number, error);
                touched.insert(*number);
            }
            Target::Branch { branch, .. } => {
                let sessions = plan
                    .branch_sessions
                    .get(&(repo.to_string(), branch.clone()))
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                for pr in found.into_iter().flatten() {
                    // A same-named branch in a stranger's fork is not this
                    // chat's branch.
                    if let Some(fork_owner) = &pr.fork_owner {
                        let mine = batch
                            .viewer
                            .as_deref()
                            .is_some_and(|viewer| viewer.eq_ignore_ascii_case(fork_owner));
                        if !mine {
                            continue;
                        }
                    }
                    // Only a URL the chat itself recorded makes a PR Owned;
                    // record_pr never downgrades it, so everything found on a
                    // branch, by the viewer or anyone else, is Existing.
                    for session in sessions {
                        pr_store::record_pr(
                            conn,
                            session,
                            repo,
                            pr.snapshot.number,
                            Relation::Existing,
                            "branch",
                            now,
                        )?;
                    }
                    write_pr(conn, repo, pr, now)?;
                    tracker.set_error(repo, pr.snapshot.number, None);
                    touched.insert(pr.snapshot.number);
                }
            }
        }
    }
    let mut changed = BTreeSet::new();
    for number in touched {
        changed.extend(pr_store::owners_of(conn, repo, number)?);
    }
    Ok(changed)
}

#[derive(Debug, Default)]
struct CycleOutcome {
    /// Sessions whose snapshots were written or whose PR errors changed.
    changed: BTreeSet<String>,
    status_changed: bool,
}

/// One polling pass. Never clears snapshots: a failed request only updates
/// the status and per-PR errors.
fn run_cycle(
    store: &SessionStore,
    runner: &dyn GhRunner,
    tracker: &Tracker,
    now: i64,
) -> CycleOutcome {
    let before = tracker.status();
    let mut outcome = CycleOutcome::default();
    if let Some(until) = runner.backoff_until().filter(|until| *until > now) {
        tracker.set_status(TrackerStatus::RateLimited { until });
        outcome.status_changed = tracker.status() != before;
        return outcome;
    }
    let plan = {
        let (Ok(conn), Ok(mut timers)) = (store.lock_conn(), tracker.timers.lock()) else {
            return outcome;
        };
        match plan_cycle(&conn, &mut timers, tracker.remaining(), now) {
            Ok(plan) => plan,
            Err(err) => {
                eprintln!("[pr_tracker] could not plan a cycle: {err}");
                return outcome;
            }
        }
    };
    let cwd = std::env::temp_dir();
    let mut status = None;
    for (index, request) in plan.requests.iter().enumerate() {
        mark_attempted(tracker, request, now);
        let query = build_query(&request.targets);
        let result = runner
            .graphql(&cwd, &query)
            .map_err(|stderr| classify_gh_error(&stderr))
            .and_then(|json| parse_response(&json));
        match result {
            Ok(batch) => {
                if let Some(rate) = &batch.rate_limit {
                    tracker
                        .remaining
                        .store(i64::from(rate.remaining), Ordering::Relaxed);
                }
                let applied = store
                    .lock_conn()
                    .map_err(|e| e.to_string())
                    .and_then(|conn| {
                        apply_batch(&conn, tracker, &plan, request, &batch, now)
                            .map_err(|e| e.to_string())
                    });
                match applied {
                    Ok(changed) => outcome.changed.extend(changed),
                    Err(err) => eprintln!("[pr_tracker] could not save {}: {err}", request.repo),
                }
                status.get_or_insert(TrackerStatus::Ok);
            }
            Err(err) => {
                if let Some(global) = err.global_status() {
                    // Every other request would fail the same way; wait for
                    // the targets' next turn instead of retrying each cycle.
                    for rest in &plan.requests[index + 1..] {
                        mark_attempted(tracker, rest, now);
                    }
                    status = Some(global);
                    break;
                }
                let TrackerError::Other(message) = err else {
                    continue;
                };
                eprintln!("[pr_tracker] {} failed: {message}", request.repo);
                for target in &request.targets {
                    if let Target::Pr { number, .. } = target {
                        tracker.set_error(&request.repo, *number, Some(&message));
                    }
                }
                status.get_or_insert(TrackerStatus::Ok);
            }
        }
    }
    if let Some(status) = status {
        tracker.set_status(status);
    }
    outcome.status_changed = tracker.status() != before;
    outcome
}

/// `gh` through the shared rate-limit backoff in `fs.rs`.
struct GhCli;

impl GhRunner for GhCli {
    fn graphql(&self, cwd: &Path, query: &str) -> Result<String, String> {
        let field = format!("query={query}");
        crate::fs::gh_with_backoff(
            &crate::fs::GITHUB_RATE_LIMIT_BACKOFF,
            &["api", "graphql", "-f", &field],
            false,
            |args, _| run_gh_graphql(cwd, args),
        )
    }

    fn backoff_until(&self) -> Option<i64> {
        crate::fs::github_rate_limit_until().map(system_time_ms)
    }
}

/// Like `fs::gh_run_raw`, but a GraphQL response that carries `data` is a
/// success even though `gh` exits non-zero for its partial errors.
fn run_gh_graphql(cwd: &Path, args: &[&str]) -> Result<String, String> {
    const MISSING: &str = "GitHub CLI (`gh`) is not installed.";
    let program = crate::harness::resolve_gui_binary("gh").ok_or_else(|| MISSING.to_string())?;
    let mut cmd = Command::new(&program);
    cmd.current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GIT_PAGER", "cat");
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    let output = cmd.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MISSING.to_string()
        } else {
            error.to_string()
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let has_data = serde_json::from_str::<Value>(&stdout)
        .ok()
        .is_some_and(|json| json.get("data").is_some_and(Value::is_object));
    if output.status.success() || has_data {
        return if stdout.is_empty() {
            Err("gh returned no output".into())
        } else {
            Ok(stdout)
        };
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "gh api graphql failed".into()
    })
}

fn tick(app: &AppHandle, holder: &str) {
    let Some(store) = app.try_state::<SessionStore>() else {
        return;
    };
    let now = now_millis();
    let leased = store
        .lock_conn()
        .map(|conn| acquire_lease(&conn, holder, now, LEASE_TTL_MS))
        .unwrap_or(false);
    if !leased {
        return;
    }
    let outcome = run_cycle(&store, &GhCli, &TRACKER, now);
    // An empty list means "everything": a status change affects every chat.
    let session_ids: Vec<String> = if outcome.status_changed {
        Vec::new()
    } else if outcome.changed.is_empty() {
        return;
    } else {
        outcome.changed.into_iter().collect()
    };
    let _ = app.emit(
        "pr-set-changed",
        serde_json::json!({ "sessionIds": session_ids }),
    );
}

/// Starts the polling loop. It works only while this process holds the
/// lease, so concurrent app instances do not double the GitHub traffic.
pub fn start(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let random = uuid::Uuid::new_v4().simple().to_string();
    let holder = format!("{}-{}", std::process::id(), &random[..12]);
    let spawned = std::thread::Builder::new()
        .name("pr-tracker".into())
        .spawn(move || loop {
            let _ = catch_unwind(AssertUnwindSafe(|| tick(&app, &holder)));
            TRACKER.wait(CYCLE);
        });
    if spawned.is_err() {
        STARTED.store(false, Ordering::SeqCst);
    }
}

#[tauri::command(async)]
pub fn pr_set_interest(
    store: State<'_, SessionStore>,
    session_id: String,
    level: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if !matches!(level.as_str(), "hot" | "fleet" | "off") {
        return Err("Unknown interest level".into());
    }
    {
        let conn = store.lock_conn()?;
        pr_store::set_interest(&conn, &session_id, &level, now_millis())
            .map_err(|e| e.to_string())?;
    }
    TRACKER.wake();
    Ok(())
}

/// Makes every target of the session due now, terminal PRs included.
#[tauri::command(async)]
pub fn pr_refresh(session_id: String) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    TRACKER.force(&session_id);
    TRACKER.wake();
    Ok(())
}

/// The chat's PRs and their stack neighbors. The live branch is the chat's
/// stored branch in the repo behind its checkout; unknown when either is
/// missing.
#[tauri::command(async)]
pub fn pr_session_set(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<PrSetView, String> {
    validate_id(&session_id, "session")?;
    let record = {
        let conn = store.lock_conn()?;
        crate::session_store::get_session_metadata(&conn, &session_id).map_err(|e| e.to_string())?
    };
    // Resolving the repo runs git; keep it outside the database lock.
    let live = record.and_then(|record| {
        let branch = record.branch?;
        let cwd = record.worktree_cwd.unwrap_or(record.cwd);
        let repo = crate::pr_attribution::repo_slug_for(&crate::fs::expand_home(&cwd))?;
        Some((repo, branch))
    });
    let conn = store.lock_conn()?;
    Ok(pr_store::build_set_view(
        &conn,
        &session_id,
        live.as_ref()
            .map(|(repo, branch)| (repo.as_str(), branch.as_str())),
        status(),
        now_millis(),
    ))
}

#[tauri::command(async)]
pub fn pr_summaries(store: State<'_, SessionStore>) -> Result<HashMap<String, PrSummary>, String> {
    let conn = store.lock_conn()?;
    Ok(pr_store::build_summaries(&conn, now_millis()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pr_store::{self, Checks, Mergeable, Relation, Review};
    use std::collections::VecDeque;

    const OPEN_FAILING_PARTIAL: &str =
        include_str!("pr_tracker_fixtures/open_failing_partial.json");
    const BASE_CHANGED: &str = include_str!("pr_tracker_fixtures/base_changed.json");
    const NO_CHECKS_NULL_AUTHOR: &str =
        include_str!("pr_tracker_fixtures/no_checks_null_author.json");
    const DISCOVERY_FOREIGN: &str = include_str!("pr_tracker_fixtures/discovery_foreign.json");

    const NOW: i64 = 1_791_000_000_000;

    struct FakeRunner {
        responses: Mutex<VecDeque<Result<String, String>>>,
        queries: Mutex<Vec<String>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<Result<&str, &str>>) -> Self {
            Self {
                responses: Mutex::new(
                    responses
                        .into_iter()
                        .map(|r| r.map(String::from).map_err(String::from))
                        .collect(),
                ),
                queries: Mutex::new(Vec::new()),
            }
        }

        fn queries(&self) -> Vec<String> {
            self.queries.lock().unwrap().clone()
        }
    }

    impl GhRunner for FakeRunner {
        fn graphql(&self, _cwd: &Path, query: &str) -> Result<String, String> {
            self.queries.lock().unwrap().push(query.to_string());
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("fake runner has no response".into()))
        }
    }

    fn add_session(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at)
             VALUES (?1, '/work', 'claude', 'm', 'default', 't', 1, 1)",
            [id],
        )
        .unwrap();
    }

    fn ms(rfc3339: &str) -> i64 {
        (time::OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339)
            .unwrap()
            .unix_timestamp_nanos()
            / 1_000_000) as i64
    }

    #[test]
    fn parse_response_maps_open_pr_with_failing_checks() {
        let batch = parse_response(OPEN_FAILING_PARTIAL).unwrap();
        let pr = &batch.prs["p0"][0];
        let s = &pr.snapshot;
        assert_eq!(s.repo, "cli/cli");
        assert_eq!(s.number, 14148);
        assert_eq!(s.url, "https://github.com/cli/cli/pull/14148");
        assert_eq!(s.title, "Update glamour to v2");
        assert_eq!(s.state, PrState::Open);
        assert!(s.is_draft);
        assert_eq!(s.head_ref, "issue3718");
        assert_eq!(s.base_ref, "trunk");
        assert_eq!(s.original_base_ref, "trunk");
        assert_eq!(s.head_oid, "82b0f3e997c6ba18f429de3772bc2867cf759ed8");
        assert_eq!(s.author.as_deref(), Some("heaths"));
        assert_eq!(s.checks, Checks::Failing);
        assert_eq!(s.review, Review::ReviewRequired);
        assert_eq!(s.mergeable, Mergeable::Mergeable);
        assert_eq!(s.behind_by, None);
        assert!(pr.base_changes.is_empty());
        assert_eq!(pr.fork_owner.as_deref(), Some("heaths"));
    }

    #[test]
    fn parse_response_uses_first_base_change_as_original_base() {
        let batch = parse_response(BASE_CHANGED).unwrap();
        let pr = &batch.prs["p0"][0];
        assert_eq!(pr.snapshot.repo, "vercel/next.js");
        assert_eq!(pr.snapshot.state, PrState::Merged);
        assert_eq!(pr.snapshot.mergeable, Mergeable::Conflicting);
        assert_eq!(pr.snapshot.review, Review::Approved);
        assert_eq!(pr.snapshot.checks, Checks::Passing);
        assert_eq!(
            pr.snapshot.base_ref,
            "codex/turbo-tasks-snapshot-persist-failure"
        );
        assert_eq!(
            pr.snapshot.original_base_ref,
            "codex/turbo-tasks-snapshot-encode-cow"
        );
        assert_eq!(
            pr.base_changes,
            vec![BaseChange {
                previous: "codex/turbo-tasks-snapshot-encode-cow".into(),
                current: "codex/turbo-tasks-snapshot-persist-failure".into(),
                at: ms("2026-10-06T15:41:07Z"),
            }]
        );
        assert_eq!(pr.fork_owner, None);

        // Several retargets: the first event names the original base.
        let two = r#"{"data":{"p0":{"nameWithOwner":"O/R","pullRequest":{
            "number":3,"url":"u","title":"t","state":"OPEN","isDraft":false,
            "headRefName":"c","baseRefName":"main","headRefOid":"x","author":{"login":"a"},
            "mergeable":"MERGEABLE","reviewDecision":null,"commits":{"nodes":[]},
            "timelineItems":{"nodes":[
              {"previousRefName":"a","currentRefName":"b","createdAt":"2026-01-01T00:00:00Z"},
              {"previousRefName":"b","currentRefName":"main","createdAt":"2026-01-02T00:00:00Z"}]}}}}}"#;
        let batch = parse_response(two).unwrap();
        let pr = &batch.prs["p0"][0];
        assert_eq!(pr.snapshot.repo, "o/r");
        assert_eq!(pr.snapshot.original_base_ref, "a");
        assert_eq!(pr.snapshot.base_ref, "main");
        assert_eq!(pr.base_changes.len(), 2);
    }

    #[test]
    fn parse_response_handles_no_checks_and_null_author() {
        let batch = parse_response(NO_CHECKS_NULL_AUTHOR).unwrap();
        let s = &batch.prs["p0"][0].snapshot;
        assert_eq!(s.repo, "eficodedemoorg/mythapi-demo");
        assert_eq!(s.author, None);
        assert_eq!(s.checks, Checks::None);
        assert_eq!(s.review, Review::None);
        assert_eq!(s.mergeable, Mergeable::Unknown);
        // No commits at all also means no checks.
        let s = &batch.prs["p1"][0].snapshot;
        assert_eq!(s.number, 25);
        assert_eq!(s.checks, Checks::None);
    }

    #[test]
    fn parse_response_reports_partial_errors_per_alias() {
        let batch = parse_response(OPEN_FAILING_PARTIAL).unwrap();
        assert_eq!(batch.viewer.as_deref(), Some("0x01001011"));
        assert_eq!(
            batch.rate_limit,
            Some(RateLimit {
                remaining: 4969,
                reset_at: ms("2026-10-09T16:44:32Z"),
                cost: 1,
            })
        );
        assert_eq!(batch.errors.len(), 1);
        assert!(batch.errors["p1"].contains("Could not resolve to a PullRequest"));
        assert!(!batch.prs.contains_key("p1"));
        assert_eq!(batch.prs["p0"].len(), 1);
        let discovered = &batch.prs["b2"];
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].snapshot.number, 14571);
        assert_eq!(discovered[0].snapshot.author.as_deref(), Some("BagToad"));

        // A response without data is a whole-request failure.
        assert!(matches!(
            parse_response(
                r#"{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}"#
            ),
            Err(TrackerError::RateLimited(_))
        ));
        assert!(matches!(
            parse_response("not json"),
            Err(TrackerError::Other(_))
        ));
    }

    #[test]
    fn classify_gh_error_cases() {
        // Messages below are what gh and fs.rs actually print.
        assert_eq!(
            classify_gh_error("GitHub CLI (`gh`) is not installed."),
            TrackerError::GhMissing
        );
        assert_eq!(
            classify_gh_error(
                "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token."
            ),
            TrackerError::SignedOut
        );
        assert_eq!(
            classify_gh_error("gh: Bad credentials (HTTP 401)"),
            TrackerError::SignedOut
        );
        assert!(matches!(
            classify_gh_error("gh: API rate limit exceeded for user ID 1. (HTTP 403)"),
            TrackerError::RateLimited(until) if until > 0
        ));
        assert!(matches!(
            classify_gh_error("gh: You have exceeded a secondary rate limit."),
            TrackerError::RateLimited(_)
        ));
        assert_eq!(
            classify_gh_error("could not resolve host: api.github.com"),
            TrackerError::Offline
        );
        assert_eq!(
            classify_gh_error(
                "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com"
            ),
            TrackerError::Offline
        );
        assert_eq!(
            classify_gh_error(
                "Post \"https://api.github.com/graphql\": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused"
            ),
            TrackerError::Offline
        );
        assert_eq!(
            classify_gh_error("gh: Something odd (HTTP 502)"),
            TrackerError::Other("Something odd (HTTP 502)".into())
        );
    }

    #[test]
    fn tier_for_table() {
        let s = Duration::from_secs;
        assert_eq!(tier_for("hot", PrState::Open, 0, Some(4000)), Some(s(30)));
        assert_eq!(
            tier_for("fleet", PrState::Open, 0, Some(4000)),
            Some(s(180))
        );
        assert_eq!(tier_for("fleet", PrState::Open, 0, None), Some(s(180)));
        assert_eq!(tier_for("unknown", PrState::Open, 0, None), Some(s(180)));
        assert_eq!(tier_for("hot", PrState::Open, 0, Some(499)), Some(s(600)));
        assert_eq!(tier_for("fleet", PrState::Open, 0, Some(10)), Some(s(600)));
        assert_eq!(tier_for("fleet", PrState::Open, 0, Some(500)), Some(s(180)));
        // Terminal PRs are fetched once.
        assert_eq!(tier_for("hot", PrState::Merged, 5, Some(4000)), None);
        assert_eq!(tier_for("fleet", PrState::Closed, 0, None), None);
        assert_eq!(
            tier_for("fleet", PrState::Merged, -1, None),
            Some(Duration::ZERO)
        );
        assert_eq!(tier_for("off", PrState::Open, 0, Some(4000)), None);
        assert_eq!(tier_for("off", PrState::Merged, -1, None), None);
    }

    #[test]
    fn lease_is_exclusive_until_expiry() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        assert!(acquire_lease(&conn, "a", 0, 60_000));
        assert!(!acquire_lease(&conn, "b", 1_000, 60_000));
        // Renewal by the holder pushes the expiry out.
        assert!(acquire_lease(&conn, "a", 30_000, 60_000));
        assert!(!acquire_lease(&conn, "b", 61_000, 60_000));
        assert!(acquire_lease(&conn, "b", 90_000, 60_000));
        assert!(!acquire_lease(&conn, "a", 90_001, 60_000));
        assert!(acquire_lease(&conn, "b", 90_002, 60_000));
    }

    #[test]
    fn build_query_batches_aliases_and_escapes_branch_names() {
        let branch = "feat/\"quoted\"\\path\n-\u{65E5}\u{672C}-\u{1F680}";
        let query = build_query(&[
            Target::Branch {
                alias: "b0".into(),
                owner: "o".into(),
                name: "r".into(),
                branch: branch.into(),
            },
            Target::Pr {
                alias: "p1".into(),
                owner: "O".into(),
                name: "R".into(),
                number: 7,
            },
            Target::Pr {
                alias: "x y { evil".into(),
                owner: "o".into(),
                name: "r".into(),
                number: 8,
            },
        ]);
        assert!(
            query.contains(
                "b0: repository(owner: \"o\", name: \"r\") { nameWithOwner pullRequests(headRefName: \"feat/\\\"quoted\\\"\\\\path\\n-\u{65E5}\u{672C}-\u{1F680}\", first: 5, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC})"
            ),
            "{query}"
        );
        assert!(query.contains(
            "p1: repository(owner: \"O\", name: \"R\") { nameWithOwner pullRequest(number: 7) { ...PrFields } }"
        ));
        assert!(!query.contains("evil"), "invalid alias must be dropped");
        assert!(!query.contains('\n'), "newlines must be escaped");
        for part in [
            "viewer { login }",
            "rateLimit { remaining resetAt cost }",
            "fragment PrFields on PullRequest",
            "author { login }",
            "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }",
            "timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], first: 10)",
            "... on BaseRefChangedEvent { previousRefName currentRefName createdAt }",
            "mergeable reviewDecision",
        ] {
            assert!(query.contains(part), "missing {part}");
        }
        assert_eq!(query.matches("repository(").count(), 2);
        assert_eq!(query.matches('{').count(), query.matches('}').count());

        // The planner sends one request per repo with at most MAX_ALIASES.
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        add_session(&conn, "s1");
        for n in 1..=45 {
            pr_store::record_pr(&conn, "s1", "o/r", n, Relation::Owned, "create", 1).unwrap();
        }
        pr_store::record_pr(&conn, "s1", "o/s", 1, Relation::Owned, "create", 1).unwrap();
        let mut timers = Timers::default();
        let plan = plan_cycle(&conn, &mut timers, None, NOW).unwrap();
        assert_eq!(plan.requests.len(), 2);
        let big = plan.requests.iter().find(|r| r.repo == "o/r").unwrap();
        assert_eq!(big.targets.len(), MAX_ALIASES);
        let aliases: HashSet<&str> = big
            .targets
            .iter()
            .map(|t| match t {
                Target::Branch { alias, .. } | Target::Pr { alias, .. } => alias.as_str(),
            })
            .collect();
        assert_eq!(aliases.len(), MAX_ALIASES);
        assert_eq!(
            build_query(&big.targets).matches("repository(").count(),
            MAX_ALIASES
        );
    }

    #[test]
    fn discovery_creates_existing_relation_for_foreign_authored_pr() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_branch(&conn, "s1", "cli/cli", "bagtoad/artifact-edit", "trace2", 1)
                .unwrap();
        }
        let runner = FakeRunner::new(vec![Ok(DISCOVERY_FOREIGN)]);
        let tracker = Tracker::new();
        let outcome = run_cycle(&store, &runner, &tracker, NOW);
        let queries = runner.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].contains("b0: repository(owner: \"cli\", name: \"cli\")"));
        assert!(queries[0].contains("headRefName: \"bagtoad/artifact-edit\""));
        {
            let conn = store.lock_conn().unwrap();
            assert_eq!(
                pr_store::session_pr_keys(&conn, "s1").unwrap(),
                vec![("cli/cli".to_string(), 14571, Relation::Existing, false)]
            );
            let snap = pr_store::load_snapshot(&conn, "cli/cli", 14571).unwrap();
            assert_eq!(snap.author.as_deref(), Some("BagToad"));
            assert_eq!(snap.fetched_at, NOW);
        }
        assert!(outcome.changed.contains("s1"));
        assert_eq!(tracker.status(), TrackerStatus::Ok);
        assert_eq!(tracker.remaining(), Some(4967));

        // Within the ten-minute discovery window nothing is asked again, but
        // the discovered PR itself is now refreshed on its fleet tier.
        run_cycle(&store, &runner, &tracker, NOW + 60_000);
        assert_eq!(runner.queries().len(), 1);
    }

    #[test]
    fn discovery_ignores_prs_from_strangers_forks() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_branch(&conn, "s1", "cli/cli", "bagtoad/artifact-edit", "save", 1)
                .unwrap();
        }
        let forked = DISCOVERY_FOREIGN.replace(
            r#""isCrossRepository":false,"headRepositoryOwner":{"login":"cli"}"#,
            r#""isCrossRepository":true,"headRepositoryOwner":{"login":"stranger"}"#,
        );
        assert_ne!(forked, DISCOVERY_FOREIGN);
        let runner = FakeRunner::new(vec![Ok(&forked)]);
        run_cycle(&store, &runner, &Tracker::new(), NOW);
        let conn = store.lock_conn().unwrap();
        assert!(pr_store::session_pr_keys(&conn, "s1").unwrap().is_empty());
        assert_eq!(pr_store::load_snapshot(&conn, "cli/cli", 14571), None);
    }

    #[test]
    fn cycle_persists_snapshots_and_sets_status_on_error() {
        let store = SessionStore::open_in_memory().unwrap();
        let old = {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(&conn, "s1", "cli/cli", 14148, Relation::Owned, "create", 1)
                .unwrap();
            let mut old = parse_response(OPEN_FAILING_PARTIAL).unwrap().prs["p0"][0]
                .snapshot
                .clone();
            old.fetched_at = 5;
            pr_store::upsert_snapshot(&conn, &old).unwrap();
            old
        };
        let runner = FakeRunner::new(vec![Err(
            "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
        )]);
        let outcome = run_cycle(&store, &runner, &TRACKER, NOW);
        assert_eq!(runner.queries().len(), 1);
        assert!(outcome.status_changed);
        assert_eq!(status(), TrackerStatus::SignedOut);
        let conn = store.lock_conn().unwrap();
        assert_eq!(
            pr_store::load_snapshot(&conn, "cli/cli", 14148),
            Some(old),
            "last snapshot must survive with its fetched_at"
        );
    }

    #[test]
    fn cycle_refresh_records_snapshot_and_base_history_once() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(
                &conn,
                "s1",
                "vercel/next.js",
                99649,
                Relation::Owned,
                "create",
                1,
            )
            .unwrap();
        }
        let runner = FakeRunner::new(vec![Ok(BASE_CHANGED), Ok(BASE_CHANGED)]);
        let tracker = Tracker::new();
        let outcome = run_cycle(&store, &runner, &tracker, NOW);
        assert!(outcome.changed.contains("s1"));
        assert!(runner.queries()[0].contains("pullRequest(number: 99649)"));
        let history = |store: &SessionStore| {
            let conn = store.lock_conn().unwrap();
            pr_store::base_history(&conn, "vercel/next.js", 99649).unwrap()
        };
        assert_eq!(
            history(&store),
            vec![(
                "codex/turbo-tasks-snapshot-persist-failure".to_string(),
                ms("2026-10-06T15:41:07Z")
            )]
        );
        // A forced refresh fetches the merged PR again without duplicating history.
        tracker.force("s1");
        run_cycle(&store, &runner, &tracker, NOW + 1_000);
        assert_eq!(runner.queries().len(), 2);
        assert_eq!(history(&store).len(), 1);
        // Unforced, a terminal PR with a snapshot is never polled again.
        run_cycle(&store, &runner, &tracker, NOW + 3_600_000);
        assert_eq!(runner.queries().len(), 2);
    }

    /// Sends a real query built by `build_query` through `gh`. Run with
    /// `cargo test pr_tracker -- --ignored` on a machine signed in to gh.
    #[test]
    #[ignore = "needs network and a signed-in gh"]
    fn live_query_parses_against_github() {
        let query = build_query(&[
            Target::Pr {
                alias: "p0".into(),
                owner: "cli".into(),
                name: "cli".into(),
                number: 14148,
            },
            Target::Pr {
                alias: "p1".into(),
                owner: "cli".into(),
                name: "cli".into(),
                number: 999_999_999,
            },
            Target::Branch {
                alias: "b2".into(),
                owner: "cli".into(),
                name: "cli".into(),
                branch: "bagtoad/artifact-edit".into(),
            },
        ]);
        let json = GhCli.graphql(&std::env::temp_dir(), &query).unwrap();
        let batch = parse_response(&json).unwrap();
        assert!(batch.viewer.is_some());
        assert!(batch.rate_limit.is_some());
        assert_eq!(batch.prs["p0"][0].snapshot.number, 14148);
        assert!(batch.errors.contains_key("p1"));
        assert!(batch.prs.contains_key("b2"));
    }

    #[test]
    fn off_sessions_are_not_polled() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_branch(&conn, "s1", "o/r", "feat/a", "save", 1).unwrap();
            pr_store::record_pr(&conn, "s1", "o/r", 3, Relation::Owned, "create", 1).unwrap();
            pr_store::set_interest(&conn, "s1", "off", 1).unwrap();
        }
        let runner = FakeRunner::new(vec![]);
        let tracker = Tracker::new();
        tracker.force("s1");
        run_cycle(&store, &runner, &tracker, NOW);
        assert!(runner.queries().is_empty());
        assert_eq!(tracker.status(), TrackerStatus::Idle);
    }
}
