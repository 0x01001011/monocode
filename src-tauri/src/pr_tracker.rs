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
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
/// Longest a single `gh` child may run before it is killed.
const GH_DEADLINE: Duration = Duration::from_secs(45);
/// Minimum gap between two forced refreshes of one chat.
const REFRESH_THROTTLE_MS: i64 = 5_000;
/// Error text for a killed `gh` child; `classify_gh_error` reads it as offline.
const GH_TIMED_OUT: &str = "GitHub request timed out";

const PR_FIELDS: &str = "fragment PrFields on PullRequest { number url title state isDraft \
isCrossRepository headRepositoryOwner { login } headRefName baseRefName headRefOid \
baseRef { target { oid } } author { login } mergeable reviewDecision \
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
    /// How far the open PR `number`'s head branch is behind its base branch.
    Compare {
        alias: String,
        owner: String,
        name: String,
        number: u32,
        base: String,
        head: String,
    },
}

impl Target {
    fn alias(&self) -> &str {
        match self {
            Target::Branch { alias, .. }
            | Target::Pr { alias, .. }
            | Target::Compare { alias, .. } => alias,
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
    /// Current tip of the base branch (`baseRef.target.oid`), when it exists.
    pub base_oid: Option<String>,
}

/// One `Target::Compare` answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompareResult {
    /// Tip of the base branch the comparison ran against.
    pub base_oid: String,
    /// Tip of the head branch the comparison ran against.
    pub head_oid: String,
    pub behind_by: u32,
    pub ahead_by: u32,
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
    /// Comparison per `Target::Compare` alias that resolved.
    pub compares: HashMap<String, CompareResult>,
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
            Target::Compare {
                alias,
                owner,
                name,
                base,
                head,
                ..
            } => {
                let _ = write!(
                    query,
                    " {alias}: repository(owner: {}, name: {}) {{ nameWithOwner \
                     ref(qualifiedName: {}) {{ target {{ oid }} \
                     compare(headRef: {}) {{ behindBy aheadBy headTarget {{ oid }} }} }} }}",
                    gql_string(owner),
                    gql_string(name),
                    gql_string(&format!("refs/heads/{base}")),
                    gql_string(head),
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
        base_oid: pr["baseRef"]["target"]["oid"]
            .as_str()
            .filter(|oid| !oid.is_empty())
            .map(str::to_string),
    })
}

/// `ref { target { oid } compare { behindBy aheadBy headTarget { oid } } }`;
/// `None` when the base ref or the head ref did not resolve.
fn parse_compare(reference: &Value) -> Option<CompareResult> {
    let count = |value: &Value| value.as_u64().and_then(|n| u32::try_from(n).ok());
    let compare = &reference["compare"];
    Some(CompareResult {
        base_oid: reference["target"]["oid"].as_str()?.to_string(),
        head_oid: compare["headTarget"]["oid"].as_str()?.to_string(),
        behind_by: count(&compare["behindBy"])?,
        ahead_by: count(&compare["aheadBy"]).unwrap_or(0),
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
        if let Some(reference) = value.get("ref") {
            match parse_compare(reference) {
                Some(compare) => {
                    batch.compares.insert(alias.clone(), compare);
                }
                None => {
                    let message = if reference.is_null() {
                        "Base branch not found"
                    } else {
                        "Head branch not found"
                    };
                    batch
                        .errors
                        .entry(alias.clone())
                        .or_insert_with(|| message.into());
                }
            }
            continue;
        }
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
        "timed out",
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
    /// Forced targets the alias cap pushed out of a cycle; still forced.
    forced_targets: HashSet<(String, Due)>,
    /// When each session last forced a refresh, for throttling.
    last_forced: HashMap<String, i64>,
    /// Latest base-branch tip seen per open PR, from refreshes and compares.
    base_oids: HashMap<(String, u32), String>,
    /// Last compare attempt per PR: `(head_oid, base_oid, at)`.
    compare_tried: HashMap<(String, u32), (String, String, i64)>,
}

pub struct Tracker {
    status: Mutex<TrackerStatus>,
    /// Last `rateLimit.remaining`; negative while unknown.
    remaining: AtomicI64,
    timers: Mutex<Timers>,
    /// Last lookup error per PR, cleared by the next successful fetch.
    errors: Mutex<HashMap<(String, u32), String>>,
    /// Set once any request succeeded in this process.
    succeeded: AtomicBool,
    wake: Mutex<bool>,
    wake_cv: Condvar,
}

impl Tracker {
    fn new() -> Self {
        Self {
            status: Mutex::new(TrackerStatus::Idle),
            remaining: AtomicI64::new(-1),
            timers: Mutex::new(Timers::default()),
            succeeded: AtomicBool::new(false),
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

    /// Makes the session's targets due next cycle. At most one forced refresh
    /// per session per `REFRESH_THROTTLE_MS`; false when this call is ignored.
    fn force(&self, session_id: &str, now: i64) -> bool {
        let Ok(mut timers) = self.timers.lock() else {
            return false;
        };
        let recent = timers
            .last_forced
            .get(session_id)
            .is_some_and(|at| now - at < REFRESH_THROTTLE_MS && now >= *at);
        if recent {
            return false;
        }
        timers.last_forced.insert(session_id.to_string(), now);
        timers.forced.insert(session_id.to_string());
        true
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
    /// `(head_oid, base_oid)` each compare target was planned for.
    compare_oids: HashMap<u32, (String, String)>,
}

struct Plan {
    requests: Vec<RepoRequest>,
    /// Non-off sessions that worked on each `(repo, branch)`.
    branch_sessions: HashMap<(String, String), Vec<String>>,
    /// True when any non-off chat has a branch or PR to track, due or not.
    tracking_anything: bool,
}

#[derive(Default)]
struct Want {
    hot: bool,
    forced: bool,
    sessions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Due {
    Branch(String),
    Pr(u32),
    /// Behind count of an open PR: `(number, base branch, head branch)`.
    Compare(u32, String, String),
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
    let carried = std::mem::take(&mut timers.forced_targets);
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

    // Targets forced earlier but cut by the alias cap stay forced.
    for (repo, item) in &carried {
        match item {
            Due::Branch(branch) => {
                if let Some(want) = branches.get_mut(&(repo.clone(), branch.clone())) {
                    want.forced = true;
                }
            }
            Due::Pr(number) => {
                if let Some(want) = prs.get_mut(&(repo.clone(), *number)) {
                    want.forced = true;
                }
            }
            Due::Compare(..) => {}
        }
    }
    let tracking_anything = !branches.is_empty() || !prs.is_empty();

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

    // Behind counts of open PRs whose (head, base) tips are not cached yet.
    // The base tip comes from the last refresh or compare of the PR.
    let mut compare_pairs: HashMap<(String, u32), (String, String)> = HashMap::new();
    for (repo, number) in prs.keys() {
        let key = (repo.clone(), *number);
        let Some(base_oid) = timers.base_oids.get(&key).cloned() else {
            continue;
        };
        let Some(snapshot) = pr_store::load_snapshot(conn, repo, *number) else {
            continue;
        };
        if snapshot.state != PrState::Open || snapshot.head_oid.is_empty() {
            continue;
        }
        if pr_store::load_compare(conn, repo, &snapshot.head_oid, &base_oid).is_some() {
            continue;
        }
        let tried_recently = timers
            .compare_tried
            .get(&key)
            .is_some_and(|(head, base, at)| {
                *head == snapshot.head_oid && *base == base_oid && now - at < DISCOVERY_FLEET_MS
            });
        if tried_recently {
            continue;
        }
        due.entry(repo.clone()).or_default().push((
            false,
            0,
            Due::Compare(*number, snapshot.base_ref, snapshot.head_ref),
        ));
        compare_pairs.insert(key, (snapshot.head_oid, base_oid));
    }

    let mut requests = Vec::new();
    for (repo, mut items) in due {
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        items.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let cut = items.split_off(items.len().min(MAX_ALIASES));
        for (forced, _, item) in cut {
            if forced {
                timers.forced_targets.insert((repo.clone(), item));
            }
        }
        let compare_oids: HashMap<u32, (String, String)> = items
            .iter()
            .filter_map(|(_, _, item)| match item {
                Due::Compare(number, ..) => compare_pairs
                    .remove(&(repo.clone(), *number))
                    .map(|oids| (*number, oids)),
                _ => None,
            })
            .collect();
        let targets = items
            .into_iter()
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
                Due::Compare(number, base, head) => Target::Compare {
                    alias: format!("c{i}"),
                    owner: owner.to_string(),
                    name: name.to_string(),
                    number,
                    base,
                    head,
                },
            })
            .collect();
        requests.push(RepoRequest {
            repo,
            targets,
            compare_oids,
        });
    }
    let branch_sessions = branches
        .into_iter()
        .map(|(key, want)| (key, want.sessions))
        .collect();
    Ok(Plan {
        requests,
        branch_sessions,
        tracking_anything,
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
            Target::Compare { number, .. } => {
                if let Some((head, base)) = request.compare_oids.get(number) {
                    timers.compare_tried.insert(
                        (request.repo.clone(), *number),
                        (head.clone(), base.clone(), now),
                    );
                }
            }
        }
    }
}

/// Writes one fetched PR under the request's repo key. With a known base tip,
/// `behind_by` is the cached count for the current (head, base) tips, or
/// unknown until compared. Without one it is kept while head and base are
/// unchanged. Appends unseen base changes.
fn write_pr(conn: &Connection, repo: &str, pr: &ParsedPr, now: i64) -> rusqlite::Result<()> {
    let mut snapshot = pr.snapshot.clone();
    snapshot.repo = repo.to_string();
    snapshot.fetched_at = now;
    if let Some(base_oid) = pr.base_oid.as_deref() {
        snapshot.behind_by = pr_store::load_compare(conn, repo, &snapshot.head_oid, base_oid);
    } else if let Some(old) = pr_store::load_snapshot(conn, repo, snapshot.number) {
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
    // Base-branch tips of open PRs, for the next compare decision.
    let mut base_oids: Vec<(u32, String)> = Vec::new();
    let open_base = |pr: &ParsedPr| match (pr.snapshot.state, &pr.base_oid) {
        (PrState::Open, Some(oid)) => Some((pr.snapshot.number, oid.clone())),
        _ => None,
    };
    for target in &request.targets {
        let found = batch.prs.get(target.alias());
        match target {
            Target::Pr { alias, number, .. } => {
                for pr in found.into_iter().flatten() {
                    write_pr(conn, repo, pr, now)?;
                    base_oids.extend(open_base(pr));
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
                    base_oids.extend(open_base(pr));
                    tracker.set_error(repo, pr.snapshot.number, None);
                    touched.insert(pr.snapshot.number);
                }
            }
            Target::Compare {
                alias,
                number,
                base,
                ..
            } => {
                let Some(compare) = batch.compares.get(alias) else {
                    continue;
                };
                // True for its own tips whatever the PR does next.
                pr_store::store_compare(
                    conn,
                    repo,
                    &compare.head_oid,
                    &compare.base_oid,
                    compare.behind_by,
                )?;
                // A PR retargeted since planning (possibly by a refresh in
                // this very batch) is no longer measured against `base`. A
                // head that moved gets its count from the cache on refresh.
                let Some(mut snapshot) = pr_store::load_snapshot(conn, repo, *number) else {
                    continue;
                };
                if snapshot.base_ref != *base {
                    continue;
                }
                base_oids.push((*number, compare.base_oid.clone()));
                if snapshot.head_oid == compare.head_oid
                    && snapshot.behind_by != Some(compare.behind_by)
                {
                    snapshot.behind_by = Some(compare.behind_by);
                    pr_store::upsert_snapshot(conn, &snapshot)?;
                    touched.insert(*number);
                }
            }
        }
    }
    if let Ok(mut timers) = tracker.timers.lock() {
        for (number, oid) in base_oids {
            timers.base_oids.insert((repo.to_string(), number), oid);
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

/// Renews `holder`'s lease right now; false when another instance took it.
fn still_leased(store: &SessionStore, holder: &str) -> bool {
    store
        .lock_conn()
        .map(|conn| acquire_lease(&conn, holder, now_millis(), LEASE_TTL_MS))
        .unwrap_or(false)
}

/// The status to show when nothing ran this cycle, or `None` to keep the
/// current one. A rate limit is stale once its reset time passed; signed-out
/// and offline have no expiry, so they stay the latest known truth until a
/// request runs, unless nothing is tracked at all any more.
fn settled_status(
    current: TrackerStatus,
    tracking_anything: bool,
    succeeded: bool,
    now: i64,
) -> Option<TrackerStatus> {
    let stale = match current {
        TrackerStatus::RateLimited { until } => until <= now,
        TrackerStatus::SignedOut | TrackerStatus::Offline => !tracking_anything,
        _ => false,
    };
    stale.then_some(if succeeded {
        TrackerStatus::Ok
    } else {
        TrackerStatus::Idle
    })
}

/// One polling pass. Never clears snapshots: a failed request only updates
/// the status and per-PR errors. Before each request the lease of `holder`
/// is renewed; when another instance took it the rest of the cycle is
/// skipped.
fn run_cycle(
    store: &SessionStore,
    runner: &dyn GhRunner,
    tracker: &Tracker,
    holder: &str,
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
        if !still_leased(store, holder) {
            eprintln!("[pr_tracker] lease lost; another instance polls now");
            break;
        }
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
                tracker.succeeded.store(true, Ordering::Relaxed);
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
    let status = status.or_else(|| {
        settled_status(
            before,
            plan.tracking_anything,
            tracker.succeeded.load(Ordering::Relaxed),
            now,
        )
    });
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
    let program = crate::harness::resolve_gui_binary("gh").ok_or_else(|| GH_MISSING.to_string())?;
    let mut cmd = Command::new(&program);
    cmd.current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GIT_PAGER", "cat");
    crate::harness::apply_gui_env(&mut cmd);
    crate::hide_window_console(&mut cmd);
    run_gh_command(cmd, GH_DEADLINE)
}

const GH_MISSING: &str = "GitHub CLI (`gh`) is not installed.";

/// Output of one pipe, filled by a helper thread so a chatty child never
/// blocks on a full pipe while we poll it.
struct Drain {
    buf: std::sync::Arc<Mutex<Vec<u8>>>,
    done: std::sync::mpsc::Receiver<()>,
}

impl Drain {
    fn start<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> Self {
        let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = std::sync::mpsc::channel();
        match pipe {
            Some(mut pipe) => {
                let sink = std::sync::Arc::clone(&buf);
                std::thread::spawn(move || {
                    let mut chunk = [0u8; 8192];
                    while let Ok(n) = pipe.read(&mut chunk) {
                        if n == 0 {
                            break;
                        }
                        if let Ok(mut out) = sink.lock() {
                            out.extend_from_slice(&chunk[..n]);
                        }
                    }
                    let _ = tx.send(());
                });
            }
            None => {
                let _ = tx.send(());
            }
        }
        Self { buf, done }
    }

    /// What the child wrote. Waits up to `grace` for end of file: another
    /// process (a grandchild, or a child spawned concurrently that inherited
    /// the pipe before close-on-exec was set) can hold the write end open
    /// after our child exited, and its output is already buffered by then.
    fn finish(self, grace: Duration) -> Vec<u8> {
        let _ = self.done.recv_timeout(grace);
        self.buf.lock().map(|b| b.clone()).unwrap_or_default()
    }
}

/// Runs `cmd` to completion, or kills it once `limit` has passed. A killed
/// child yields `GH_TIMED_OUT`, which classifies as offline.
fn run_gh_command(mut cmd: Command, limit: Duration) -> Result<String, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GH_MISSING.to_string()
        } else {
            error.to_string()
        }
    })?;
    let stdout_pipe = Drain::start(child.stdout.take());
    let stderr_pipe = Drain::start(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{GH_TIMED_OUT} after {}s", limit.as_secs_f32()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    const GRACE: Duration = Duration::from_secs(1);
    let output = std::process::Output {
        status,
        stdout: stdout_pipe.finish(GRACE),
        stderr: stderr_pipe.finish(GRACE),
    };
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
    let outcome = run_cycle(&store, &GhCli, &TRACKER, holder, now);
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

/// Makes every target of the session due now, terminal PRs included. Calls
/// within five seconds of the session's last forced refresh are ignored.
#[tauri::command(async)]
pub fn pr_refresh(session_id: String) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if TRACKER.force(&session_id, now_millis()) {
        TRACKER.wake();
    }
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
    /// Real `gh api graphql` output for four compare aliases (see
    /// `build_query_emits_compare_alias`): c0 resolves, c1 names a missing
    /// head branch, c2 a missing base branch, c3 resolves against trunk.
    const COMPARE_BEHIND: &str = include_str!("pr_tracker_fixtures/compare_behind.json");
    const ARTIFACT_CREATE_TIP: &str = "10d9dd67a1492d4d99f085e0cb1be7fc337f0d8d";
    const ARTIFACT_EDIT_TIP: &str = "740b05942657170a840cc8bee293f63e07fe9a0b";

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
                Target::Branch { alias, .. }
                | Target::Pr { alias, .. }
                | Target::Compare { alias, .. } => alias.as_str(),
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
        let outcome = run_cycle(&store, &runner, &tracker, "t", NOW);
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
        run_cycle(&store, &runner, &tracker, "t", NOW + 60_000);
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
        run_cycle(&store, &runner, &Tracker::new(), "t", NOW);
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
        let outcome = run_cycle(&store, &runner, &TRACKER, "t", NOW);
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
        let outcome = run_cycle(&store, &runner, &tracker, "t", NOW);
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
        tracker.force("s1", NOW + 1_000);
        run_cycle(&store, &runner, &tracker, "t", NOW + 1_000);
        assert_eq!(runner.queries().len(), 2);
        assert_eq!(history(&store).len(), 1);
        // Unforced, a terminal PR with a snapshot is never polled again.
        run_cycle(&store, &runner, &tracker, "t", NOW + 3_600_000);
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
            Target::Compare {
                alias: "c3".into(),
                owner: "cli".into(),
                name: "cli".into(),
                number: 14571,
                base: "trunk".into(),
                head: "bagtoad/artifact-edit".into(),
            },
        ]);
        let json = GhCli.graphql(&std::env::temp_dir(), &query).unwrap();
        let batch = parse_response(&json).unwrap();
        assert!(batch.compares["c3"].behind_by > 0);
        assert!(batch.prs["p0"][0].base_oid.is_some());
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
        tracker.force("s1", NOW);
        run_cycle(&store, &runner, &tracker, "t", NOW);
        assert!(runner.queries().is_empty());
        assert_eq!(tracker.status(), TrackerStatus::Idle);
    }

    #[cfg(unix)] // spawns `sleep` and `sh`
    #[test]
    fn gh_child_past_deadline_is_killed_and_reads_as_offline() {
        let started = Instant::now();
        let mut slow = Command::new("sleep");
        slow.arg("5");
        let err = run_gh_command(slow, Duration::from_millis(200)).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "must not wait for the child"
        );
        assert!(err.contains(GH_TIMED_OUT), "{err}");
        assert_eq!(classify_gh_error(&err), TrackerError::Offline);

        // A child that finishes in time is read as before.
        let mut fast = Command::new("sh");
        fast.args(["-c", r#"echo '{"data":{}}'; exit 1"#]);
        assert_eq!(
            run_gh_command(fast, Duration::from_secs(10)).unwrap(),
            r#"{"data":{}}"#
        );
        let mut failing = Command::new("sh");
        failing.args(["-c", "echo boom >&2; exit 1"]);
        assert_eq!(
            run_gh_command(failing, Duration::from_secs(10)).unwrap_err(),
            "boom"
        );
        let missing = Command::new("/nonexistent/gh-for-test");
        assert_eq!(
            classify_gh_error(&run_gh_command(missing, Duration::from_secs(1)).unwrap_err()),
            TrackerError::GhMissing
        );
    }

    /// Answers like `FakeRunner`, then hands the lease to another instance.
    struct LeaseThief<'a> {
        store: &'a SessionStore,
        inner: FakeRunner,
    }

    impl GhRunner for LeaseThief<'_> {
        fn graphql(&self, cwd: &Path, query: &str) -> Result<String, String> {
            let result = self.inner.graphql(cwd, query);
            let conn = self.store.lock_conn().unwrap();
            conn.execute(
                "UPDATE pr_tracker_lease SET holder = 'other', expires_at = ?1",
                [i64::MAX / 2],
            )
            .unwrap();
            result
        }
    }

    #[test]
    fn lost_lease_aborts_the_rest_of_the_cycle() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(&conn, "s1", "o/a", 1, Relation::Owned, "create", 1).unwrap();
            pr_store::record_pr(&conn, "s1", "o/b", 2, Relation::Owned, "create", 1).unwrap();
        }
        let thief = LeaseThief {
            store: &store,
            inner: FakeRunner::new(vec![
                Ok(r#"{"data":{"viewer":{"login":"v"}}}"#),
                Ok(r#"{"data":{"viewer":{"login":"v"}}}"#),
            ]),
        };
        run_cycle(&store, &thief, &Tracker::new(), "t", NOW);
        let queries = thief.inner.queries();
        assert_eq!(queries.len(), 1, "second repo must not be requested");
        assert!(queries[0].contains("name: \"a\""));

        // Without a thief both repos are requested.
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(&conn, "s1", "o/a", 1, Relation::Owned, "create", 1).unwrap();
            pr_store::record_pr(&conn, "s1", "o/b", 2, Relation::Owned, "create", 1).unwrap();
        }
        let runner = FakeRunner::new(vec![
            Ok(r#"{"data":{"viewer":{"login":"v"}}}"#),
            Ok(r#"{"data":{"viewer":{"login":"v"}}}"#),
        ]);
        run_cycle(&store, &runner, &Tracker::new(), "t", NOW);
        assert_eq!(runner.queries().len(), 2);
    }

    fn pr_numbers(plan: &Plan) -> BTreeSet<u32> {
        plan.requests
            .iter()
            .flat_map(|r| &r.targets)
            .filter_map(|t| match t {
                Target::Pr { number, .. } => Some(*number),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn forced_targets_beyond_the_alias_cap_stay_forced() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        add_session(&conn, "s1");
        let template = parse_response(OPEN_FAILING_PARTIAL).unwrap().prs["p0"][0]
            .snapshot
            .clone();
        for n in 1..=25 {
            pr_store::record_pr(&conn, "s1", "o/r", n, Relation::Owned, "create", 1).unwrap();
            // Fresh open snapshots: nothing is due unless forced.
            pr_store::upsert_snapshot(
                &conn,
                &PrSnapshot {
                    repo: "o/r".into(),
                    number: n,
                    fetched_at: NOW,
                    state: PrState::Open,
                    ..template.clone()
                },
            )
            .unwrap();
        }
        let tracker = Tracker::new();
        assert!(tracker.force("s1", NOW));
        let mut timers = tracker.timers.lock().unwrap();
        let first = plan_cycle(&conn, &mut timers, None, NOW).unwrap();
        assert_eq!(pr_numbers(&first).len(), MAX_ALIASES);
        let second = plan_cycle(&conn, &mut timers, None, NOW + 1_000).unwrap();
        let rest = pr_numbers(&second);
        assert_eq!(rest.len(), 5, "the five cut targets stay forced");
        assert!(rest.is_disjoint(&pr_numbers(&first)));
        let third = plan_cycle(&conn, &mut timers, None, NOW + 2_000).unwrap();
        assert!(third.requests.is_empty());
    }

    #[test]
    fn refresh_is_throttled_per_session() {
        let tracker = Tracker::new();
        assert!(tracker.force("s1", NOW));
        assert!(!tracker.force("s1", NOW + 4_999));
        assert!(tracker.force("s2", NOW + 1));
        assert!(tracker.force("s1", NOW + 5_000));
        assert!(!tracker.force("s1", NOW + 9_999));
    }

    #[test]
    fn stale_error_status_resets_when_nothing_runs() {
        use TrackerStatus as S;
        assert_eq!(
            settled_status(S::RateLimited { until: NOW }, true, false, NOW),
            Some(S::Idle)
        );
        assert_eq!(
            settled_status(S::RateLimited { until: NOW }, true, true, NOW),
            Some(S::Ok)
        );
        assert_eq!(
            settled_status(S::RateLimited { until: NOW + 1 }, true, true, NOW),
            None
        );
        // Signed-out and offline stay while anything is tracked.
        assert_eq!(settled_status(S::SignedOut, true, true, NOW), None);
        assert_eq!(settled_status(S::Offline, true, false, NOW), None);
        assert_eq!(
            settled_status(S::SignedOut, false, false, NOW),
            Some(S::Idle)
        );
        assert_eq!(settled_status(S::Offline, false, true, NOW), Some(S::Ok));
        assert_eq!(settled_status(S::Ok, false, true, NOW), None);
        assert_eq!(settled_status(S::GhMissing, false, true, NOW), None);

        // Through a cycle: the rate limit expired and nothing was due.
        let store = SessionStore::open_in_memory().unwrap();
        let runner = FakeRunner::new(vec![]);
        let tracker = Tracker::new();
        tracker.set_status(S::RateLimited { until: NOW - 1 });
        let outcome = run_cycle(&store, &runner, &tracker, "t", NOW);
        assert!(runner.queries().is_empty());
        assert_eq!(tracker.status(), S::Idle);
        assert!(outcome.status_changed);
        tracker.succeeded.store(true, Ordering::Relaxed);
        tracker.set_status(S::SignedOut);
        run_cycle(&store, &runner, &tracker, "t", NOW);
        assert_eq!(tracker.status(), S::Ok);
    }

    /// `DISCOVERY_FOREIGN`'s PR as a refresh answer that carries the base tip.
    fn refresh_with_base_oid() -> String {
        let with_base = DISCOVERY_FOREIGN.replace(
            r#""baseRefName":"bagtoad/artifact-create","#,
            &format!(
                r#""baseRefName":"bagtoad/artifact-create","baseRef":{{"target":{{"oid":"{ARTIFACT_CREATE_TIP}"}}}},"#
            ),
        );
        let as_refresh = with_base
            .replace(
                r#""b0":{"nameWithOwner":"cli/cli","pullRequests":{"nodes":["#,
                r#""p0":{"nameWithOwner":"cli/cli","pullRequest":"#,
            )
            .replace("}]}}}}", "}}}}");
        assert_ne!(as_refresh, with_base);
        as_refresh
    }

    #[test]
    fn build_query_emits_compare_alias() {
        let query = build_query(&[Target::Compare {
            alias: "c0".into(),
            owner: "cli".into(),
            name: "cli".into(),
            number: 14571,
            base: "bagtoad/artifact-create".into(),
            head: "bagtoad/artifact-edit".into(),
        }]);
        assert!(
            query.contains(
                "c0: repository(owner: \"cli\", name: \"cli\") { nameWithOwner ref(qualifiedName: \"refs/heads/bagtoad/artifact-create\") { target { oid } compare(headRef: \"bagtoad/artifact-edit\") { behindBy aheadBy headTarget { oid } } } }"
            ),
            "{query}"
        );
        assert_eq!(query.matches('{').count(), query.matches('}').count());
        // Refreshes learn the base tip, so a moved base triggers a compare.
        assert!(build_query(&[]).contains("baseRef { target { oid } }"));
    }

    #[test]
    fn parse_response_maps_compare_results() {
        let batch = parse_response(COMPARE_BEHIND).unwrap();
        assert_eq!(
            batch.compares["c0"],
            CompareResult {
                base_oid: ARTIFACT_CREATE_TIP.into(),
                head_oid: ARTIFACT_EDIT_TIP.into(),
                behind_by: 0,
                ahead_by: 3,
            }
        );
        assert_eq!(
            batch.compares["c3"],
            CompareResult {
                base_oid: "ec5b512045db67e5a2a4ff4a1b02660b2fb24390".into(),
                head_oid: ARTIFACT_EDIT_TIP.into(),
                behind_by: 23,
                ahead_by: 16,
            }
        );
        assert_eq!(batch.compares.len(), 2);
        assert!(batch.errors["c1"].contains("Could not resolve head ref"));
        assert_eq!(batch.errors["c2"], "Base branch not found");
        assert!(batch.prs.is_empty(), "compare aliases are not PRs");
    }

    #[test]
    fn parse_pr_reads_base_oid() {
        let batch = parse_response(&refresh_with_base_oid()).unwrap();
        assert_eq!(
            batch.prs["p0"][0].base_oid.as_deref(),
            Some(ARTIFACT_CREATE_TIP)
        );
        let batch = parse_response(DISCOVERY_FOREIGN).unwrap();
        assert_eq!(batch.prs["b0"][0].base_oid, None);
    }

    fn compare_targets(plan: &Plan) -> Vec<(u32, String, String)> {
        plan.requests
            .iter()
            .flat_map(|r| &r.targets)
            .filter_map(|t| match t {
                Target::Compare {
                    number, base, head, ..
                } => Some((*number, base.clone(), head.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn compare_cache_skips_known_oid_pair() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        add_session(&conn, "s1");
        pr_store::record_pr(&conn, "s1", "cli/cli", 14571, Relation::Owned, "create", 1).unwrap();
        let mut snapshot = parse_response(DISCOVERY_FOREIGN).unwrap().prs["b0"][0]
            .snapshot
            .clone();
        // Fresh: the PR itself is not due.
        snapshot.fetched_at = NOW;
        pr_store::upsert_snapshot(&conn, &snapshot).unwrap();
        let key = ("cli/cli".to_string(), 14571);
        let wanted = vec![(
            14571,
            "bagtoad/artifact-create".to_string(),
            "bagtoad/artifact-edit".to_string(),
        )];

        // Unknown base tip: nothing to compare against yet.
        let mut timers = Timers::default();
        assert!(compare_targets(&plan_cycle(&conn, &mut timers, None, NOW).unwrap()).is_empty());

        // Known base tip, uncached pair: one compare alias. Planning alone
        // (a cycle aborted before the request) does not suppress it; an
        // attempt does, for the same tips.
        let tracker = Tracker::new();
        let plan = {
            let mut timers = tracker.timers.lock().unwrap();
            timers
                .base_oids
                .insert(key.clone(), ARTIFACT_CREATE_TIP.into());
            let plan = plan_cycle(&conn, &mut timers, None, NOW).unwrap();
            assert_eq!(compare_targets(&plan), wanted);
            assert_eq!(plan.requests[0].targets.len(), 1);
            let again = plan_cycle(&conn, &mut timers, None, NOW + 500).unwrap();
            assert_eq!(compare_targets(&again), wanted);
            plan
        };
        mark_attempted(&tracker, &plan.requests[0], NOW + 500);
        {
            let mut timers = tracker.timers.lock().unwrap();
            assert!(
                compare_targets(&plan_cycle(&conn, &mut timers, None, NOW + 1_000).unwrap())
                    .is_empty()
            );
            // Ten minutes later it is asked again.
            assert_eq!(
                compare_targets(
                    &plan_cycle(&conn, &mut timers, None, NOW + 500 + DISCOVERY_FLEET_MS).unwrap()
                ),
                wanted
            );
        }

        // Cached pair: skipped.
        pr_store::store_compare(&conn, "cli/cli", ARTIFACT_EDIT_TIP, ARTIFACT_CREATE_TIP, 2)
            .unwrap();
        let mut timers = Timers::default();
        timers
            .base_oids
            .insert(key.clone(), ARTIFACT_CREATE_TIP.into());
        assert!(compare_targets(&plan_cycle(&conn, &mut timers, None, NOW).unwrap()).is_empty());

        // The base moved: compare again.
        let mut timers = Timers::default();
        timers.base_oids.insert(key.clone(), "moved".into());
        assert_eq!(
            compare_targets(&plan_cycle(&conn, &mut timers, None, NOW).unwrap()),
            wanted
        );

        // Merged PRs are never compared.
        snapshot.state = PrState::Merged;
        pr_store::upsert_snapshot(&conn, &snapshot).unwrap();
        let mut timers = Timers::default();
        timers.base_oids.insert(key, "moved".into());
        assert!(compare_targets(&plan_cycle(&conn, &mut timers, None, NOW).unwrap()).is_empty());
    }

    #[test]
    fn cycle_compares_open_pr_and_caches_behind() {
        let store = SessionStore::open_in_memory().unwrap();
        {
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(&conn, "s1", "cli/cli", 14571, Relation::Owned, "create", 1)
                .unwrap();
        }
        let refresh = refresh_with_base_oid();
        let compare = COMPARE_BEHIND.replace(r#""behindBy":0"#, r#""behindBy":7"#);
        assert_ne!(compare, COMPARE_BEHIND);
        let runner = FakeRunner::new(vec![Ok(&refresh), Ok(&compare), Ok(&refresh)]);
        let tracker = Tracker::new();
        let snapshot = |store: &SessionStore| {
            let conn = store.lock_conn().unwrap();
            pr_store::load_snapshot(&conn, "cli/cli", 14571).unwrap()
        };

        run_cycle(&store, &runner, &tracker, "t", NOW);
        assert_eq!(snapshot(&store).behind_by, None);

        // Next cycle: the open PR's head is compared with its base.
        let outcome = run_cycle(&store, &runner, &tracker, "t", NOW + 1_000);
        let queries = runner.queries();
        assert_eq!(queries.len(), 2);
        assert!(queries[1].contains("c0: repository(owner: \"cli\", name: \"cli\")"));
        assert!(queries[1].contains("refs/heads/bagtoad/artifact-create"));
        assert!(!queries[1].contains("pullRequest("));
        assert_eq!(snapshot(&store).behind_by, Some(7));
        assert!(outcome.changed.contains("s1"));
        {
            let conn = store.lock_conn().unwrap();
            assert_eq!(
                pr_store::load_compare(&conn, "cli/cli", ARTIFACT_EDIT_TIP, ARTIFACT_CREATE_TIP),
                Some(7)
            );
        }

        // A refresh with unchanged tips keeps the cached count and sends no compare.
        assert!(tracker.force("s1", NOW + 10_000));
        run_cycle(&store, &runner, &tracker, "t", NOW + 10_000);
        let queries = runner.queries();
        assert_eq!(queries.len(), 3);
        assert!(!queries[2].contains("compare("));
        assert_eq!(snapshot(&store).behind_by, Some(7));
        run_cycle(&store, &runner, &tracker, "t", NOW + 11_000);
        assert_eq!(runner.queries().len(), 3);
    }

    const TRUNK_TIP: &str = "ec5b512045db67e5a2a4ff4a1b02660b2fb24390";

    #[test]
    fn retarget_in_the_same_batch_does_not_take_the_old_base_count() {
        let key = ("cli/cli".to_string(), 14571);
        for compare_first in [true, false] {
            let store = SessionStore::open_in_memory().unwrap();
            let conn = store.lock_conn().unwrap();
            add_session(&conn, "s1");
            pr_store::record_pr(&conn, "s1", "cli/cli", 14571, Relation::Owned, "create", 1)
                .unwrap();
            let refreshed = parse_response(&refresh_with_base_oid()).unwrap().prs["p0"][0].clone();
            let mut old = refreshed.snapshot.clone();
            old.behind_by = Some(2);
            old.fetched_at = NOW - 1;
            pr_store::upsert_snapshot(&conn, &old).unwrap();

            // The compare was planned against the old base; the refresh in the
            // same batch shows the PR retargeted to trunk.
            let compare = Target::Compare {
                alias: "c0".into(),
                owner: "cli".into(),
                name: "cli".into(),
                number: 14571,
                base: "bagtoad/artifact-create".into(),
                head: "bagtoad/artifact-edit".into(),
            };
            let refresh = Target::Pr {
                alias: "p1".into(),
                owner: "cli".into(),
                name: "cli".into(),
                number: 14571,
            };
            let targets = if compare_first {
                vec![compare, refresh]
            } else {
                vec![refresh, compare]
            };
            let request = RepoRequest {
                repo: "cli/cli".into(),
                targets,
                compare_oids: HashMap::new(),
            };
            let mut batch = ParsedBatch::default();
            batch.compares.insert(
                "c0".into(),
                CompareResult {
                    base_oid: ARTIFACT_CREATE_TIP.into(),
                    head_oid: ARTIFACT_EDIT_TIP.into(),
                    behind_by: 7,
                    ahead_by: 3,
                },
            );
            let mut retargeted = refreshed.clone();
            retargeted.snapshot.base_ref = "trunk".into();
            retargeted.base_oid = Some(TRUNK_TIP.into());
            batch.prs.insert("p1".into(), vec![retargeted]);
            let plan = Plan {
                requests: Vec::new(),
                branch_sessions: HashMap::new(),
                tracking_anything: true,
            };
            let tracker = Tracker::new();
            apply_batch(&conn, &tracker, &plan, &request, &batch, NOW).unwrap();

            let snapshot = pr_store::load_snapshot(&conn, "cli/cli", 14571).unwrap();
            assert_eq!(snapshot.base_ref, "trunk");
            assert_eq!(snapshot.behind_by, None, "compare_first={compare_first}");
            // The count is still true for its own tips, so it stays cached.
            assert_eq!(
                pr_store::load_compare(&conn, "cli/cli", ARTIFACT_EDIT_TIP, ARTIFACT_CREATE_TIP),
                Some(7)
            );
            assert_eq!(
                tracker.timers.lock().unwrap().base_oids[&key],
                TRUNK_TIP,
                "compare_first={compare_first}"
            );
        }
    }

    #[test]
    fn refresh_drops_stale_behind_when_base_tip_is_uncached() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let mut refreshed = parse_response(&refresh_with_base_oid()).unwrap().prs["p0"][0].clone();
        let mut old = refreshed.snapshot.clone();
        old.behind_by = Some(4);
        pr_store::upsert_snapshot(&conn, &old).unwrap();
        let load = || pr_store::load_snapshot(&conn, "cli/cli", 14571).unwrap();

        // Same head and base name, but no base tip: the old count is kept.
        refreshed.base_oid = None;
        write_pr(&conn, "cli/cli", &refreshed, NOW).unwrap();
        assert_eq!(load().behind_by, Some(4));

        // The base moved to a tip with no cached count: unknown until compared.
        refreshed.base_oid = Some("moved".into());
        write_pr(&conn, "cli/cli", &refreshed, NOW).unwrap();
        assert_eq!(load().behind_by, None);

        // A cached pair fills it in.
        pr_store::store_compare(&conn, "cli/cli", ARTIFACT_EDIT_TIP, "moved", 6).unwrap();
        write_pr(&conn, "cli/cli", &refreshed, NOW).unwrap();
        assert_eq!(load().behind_by, Some(6));
    }
}
