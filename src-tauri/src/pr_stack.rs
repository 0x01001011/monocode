//! Pure derivation of PR stacks and tracking quality from stored snapshots.
//!
//! A PR B is stacked on A when both live in the same repo and B was opened
//! against A's head branch (`B.original_base_ref == A.head_ref`). The original
//! base is used, not the current one, because GitHub retargets a child to the
//! default branch when its parent merges; the edge must survive that.

use std::collections::{HashMap, HashSet};

use crate::pr_store::{
    Attention, PrEntryLite, PrSnapshot, PrStackGroup, PrStackView, PrState, Relation,
    RepoStackInputs, Tracking,
};

/// `(repo, child number) -> parent number`. When several PRs share the parent
/// head branch name, the most recently fetched one wins (highest number on a
/// tie). A merged parent still parents its children.
pub fn derive_parents(prs: &[PrSnapshot]) -> HashMap<(String, u32), u32> {
    // Candidates per (repo, head branch), best first. A child skips entries
    // with its own number, so usually only the first one or two are read.
    let mut by_head: HashMap<(&str, &str), Vec<(i64, u32)>> = HashMap::new();
    for pr in prs {
        by_head
            .entry((pr.repo.as_str(), pr.head_ref.as_str()))
            .or_default()
            .push((pr.fetched_at, pr.number));
    }
    for candidates in by_head.values_mut() {
        candidates.sort_unstable_by(|a, b| b.cmp(a));
    }
    let mut parents = HashMap::new();
    for child in prs {
        if child.original_base_ref.is_empty() {
            continue;
        }
        let parent = by_head
            .get(&(child.repo.as_str(), child.original_base_ref.as_str()))
            .and_then(|candidates| {
                candidates
                    .iter()
                    .find(|(_, number)| *number != child.number)
            });
        if let Some(&(_, parent)) = parent {
            parents.insert((child.repo.clone(), child.number), parent);
        }
    }
    parents
}

fn find_root(roots: &mut [usize], mut node: usize) -> usize {
    while roots[node] != node {
        roots[node] = roots[roots[node]];
        node = roots[node];
    }
    node
}

/// Connected stacks of at least two PRs, members ordered base first, tip last
/// (by distance from the base, then by number). Groups are ordered by repo,
/// then by their base member's number.
pub fn group_stacks(
    prs: &[PrSnapshot],
    parents: &HashMap<(String, u32), u32>,
) -> Vec<PrStackGroup> {
    let index: HashMap<(&str, u32), usize> = prs
        .iter()
        .enumerate()
        .map(|(i, pr)| ((pr.repo.as_str(), pr.number), i))
        .collect();
    let mut roots: Vec<usize> = (0..prs.len()).collect();
    for ((repo, child), parent) in parents {
        if let (Some(&c), Some(&p)) = (
            index.get(&(repo.as_str(), *child)),
            index.get(&(repo.as_str(), *parent)),
        ) {
            let (rc, rp) = (find_root(&mut roots, c), find_root(&mut roots, p));
            roots[rc] = rp;
        }
    }

    // Steps from a PR up to its stack base; a head-branch cycle stops the walk.
    let depth = |pr: &PrSnapshot| -> usize {
        let mut seen = HashSet::from([pr.number]);
        let mut current = pr.number;
        let mut steps = 0;
        while let Some(&parent) = parents.get(&(pr.repo.clone(), current)) {
            if !index.contains_key(&(pr.repo.as_str(), parent)) || !seen.insert(parent) {
                break;
            }
            steps += 1;
            current = parent;
        }
        steps
    };

    let mut components: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..prs.len() {
        let root = find_root(&mut roots, i);
        components.entry(root).or_default().push(i);
    }
    let mut groups: Vec<PrStackGroup> = components
        .into_values()
        .filter(|members| members.len() >= 2)
        .map(|members| {
            let mut ordered: Vec<(usize, &PrSnapshot)> =
                members.iter().map(|&i| (depth(&prs[i]), &prs[i])).collect();
            ordered.sort_by_key(|(d, pr)| (*d, pr.number));
            let base = ordered[0].1;
            PrStackGroup {
                repo: base.repo.clone(),
                base_ref: base.original_base_ref.clone(),
                members: ordered.iter().map(|(_, pr)| pr.number).collect(),
                merged_count: ordered
                    .iter()
                    .filter(|(_, pr)| pr.state == PrState::Merged)
                    .count() as u32,
            }
        })
        .collect();
    groups.sort_by(|a, b| (&a.repo, a.members[0]).cmp(&(&b.repo, b.members[0])));
    groups
}

/// What `attention_for` looks at for one PR.
pub struct PrEntryInputs<'a> {
    pub snapshot: &'a PrSnapshot,
    /// The PR this one is stacked on, when known.
    pub parent: Option<&'a PrSnapshot>,
    /// Branch name shown in "Behind <base> by N".
    pub base_ref_label: String,
}

/// Health dot and its reason for one PR. First match wins: conflict, failing
/// checks, changes requested (`Block`); restack, behind (`Action`); running
/// checks (`Pending`, not shown for drafts). Merged and closed PRs never need
/// attention.
pub fn attention_for(inputs: &PrEntryInputs) -> (Attention, Option<String>) {
    use crate::pr_store::{Checks, Mergeable, Review};
    let pr = inputs.snapshot;
    if pr.state != PrState::Open {
        return (Attention::None, None);
    }
    let block = |reason: &str| (Attention::Block, Some(reason.to_string()));
    if pr.mergeable == Mergeable::Conflicting {
        return block("Merge conflict");
    }
    if pr.checks == Checks::Failing {
        return block("Checks failing");
    }
    if pr.review == Review::ChangesRequested {
        return block("Changes requested");
    }
    let behind = pr.behind_by.unwrap_or(0);
    // The parent merged and this PR still targets its head, or was retargeted
    // but is not known to be up to date with the new base (a count of zero
    // means the restack is done); or the parent's head gained commits this PR
    // does not have.
    let restack = inputs.parent.is_some_and(|parent| {
        let on_parent_head = pr.base_ref == parent.head_ref;
        let merged_parent =
            parent.state == PrState::Merged && (on_parent_head || pr.behind_by != Some(0));
        merged_parent || (behind > 0 && on_parent_head)
    });
    if restack {
        return (Attention::Action, Some("Needs restack".into()));
    }
    if behind > 0 {
        return (
            Attention::Action,
            Some(format!("Behind {} by {behind}", inputs.base_ref_label)),
        );
    }
    if pr.checks == Checks::Pending && !pr.is_draft {
        return (Attention::Pending, Some("Checks running".into()));
    }
    (Attention::None, None)
}

/// The stack holding `number` among every stored snapshot of one repo, or
/// `None` when the PR has no snapshot. A PR that stacks with nothing gets a
/// single-member group (unlike `PrSetView::stacks`, which keeps only groups
/// of two or more), so its health still shows.
/// A chat owns a PR when it created it or worked on its head branch, the same
/// rule `build_set_view` uses; a transcript mention alone does not count.
pub fn stack_view_for(inputs: &RepoStackInputs, number: u32) -> Option<PrStackView> {
    let prs = &inputs.snapshots;
    let find = |n: u32| prs.iter().find(|pr| pr.number == n);
    let viewed = find(number)?;
    let parents = derive_parents(prs);
    let group = group_stacks(prs, &parents)
        .into_iter()
        .find(|group| group.members.contains(&number))
        .unwrap_or_else(|| PrStackGroup {
            repo: viewed.repo.clone(),
            base_ref: viewed.original_base_ref.clone(),
            members: vec![number],
            merged_count: u32::from(viewed.state == PrState::Merged),
        });
    let owners = |pr: &PrSnapshot| -> Vec<String> {
        let mut ids: Vec<String> = inputs
            .claims
            .iter()
            .filter(|(session, n, relation)| {
                *n == pr.number
                    && (*relation == Relation::Owned
                        || inputs
                            .branches
                            .iter()
                            .any(|(s, branch)| s == session && *branch == pr.head_ref))
            })
            .map(|(session, _, _)| session.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let viewed_owners = owners(viewed);
    let entries = group
        .members
        .iter()
        .filter_map(|&n| {
            let pr = find(n)?;
            let parent = parents
                .get(&(pr.repo.clone(), pr.number))
                .and_then(|&p| find(p));
            let (attention, attention_reason) = attention_for(&PrEntryInputs {
                snapshot: pr,
                parent,
                base_ref_label: pr.base_ref.clone(),
            });
            let owner_session_ids = owners(pr);
            // Another chat's PR: owned, but by no chat that owns the viewed one.
            let is_neighbor = n != number
                && !owner_session_ids.is_empty()
                && !owner_session_ids
                    .iter()
                    .any(|id| viewed_owners.contains(id));
            Some(PrEntryLite {
                number: pr.number,
                title: pr.title.clone(),
                url: pr.url.clone(),
                state: pr.state,
                is_draft: pr.is_draft,
                head_ref: pr.head_ref.clone(),
                base_ref: pr.base_ref.clone(),
                checks: pr.checks,
                attention,
                attention_reason,
                owner_session_ids,
                is_neighbor,
            })
        })
        .collect();
    Some(PrStackView { group, entries })
}

/// `Full` only when git activity of the chat was observed through trace2.
pub fn tracking_for(has_trace2_rows: bool, _has_branches: bool) -> Tracking {
    if has_trace2_rows {
        Tracking::Full
    } else {
        Tracking::Limited
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pr_store::{Attention, Checks, Mergeable, PrState, Review};

    fn pr(
        repo: &str,
        number: u32,
        head: &str,
        base: &str,
        original_base: &str,
        state: PrState,
        fetched_at: i64,
    ) -> PrSnapshot {
        PrSnapshot {
            repo: repo.into(),
            number,
            url: format!("https://github.com/{repo}/pull/{number}"),
            title: format!("PR {number}"),
            state,
            is_draft: false,
            head_ref: head.into(),
            base_ref: base.into(),
            original_base_ref: original_base.into(),
            head_oid: format!("oid{number}"),
            author: None,
            checks: Checks::None,
            review: Review::None,
            mergeable: Mergeable::Unknown,
            behind_by: None,
            fetched_at,
        }
    }

    fn open(repo: &str, number: u32, head: &str, base: &str) -> PrSnapshot {
        pr(repo, number, head, base, base, PrState::Open, 100)
    }

    #[test]
    fn chain_of_three_orders_base_first() {
        // Passed out of order on purpose.
        let prs = vec![
            open("o/r", 3, "feat/c", "feat/b"),
            open("o/r", 1, "feat/a", "main"),
            open("o/r", 2, "feat/b", "feat/a"),
        ];
        let parents = derive_parents(&prs);
        assert_eq!(parents.get(&("o/r".to_string(), 2)), Some(&1));
        assert_eq!(parents.get(&("o/r".to_string(), 3)), Some(&2));
        assert_eq!(parents.get(&("o/r".to_string(), 1)), None);
        let groups = group_stacks(&prs, &parents);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![1, 2, 3]);
        assert_eq!(groups[0].base_ref, "main");
        assert_eq!(groups[0].merged_count, 0);
        assert_eq!(groups[0].repo, "o/r");
    }

    #[test]
    fn merged_parent_keeps_edge_after_child_retargeted_to_main() {
        let prs = vec![
            pr("o/r", 1, "feat/a", "main", "main", PrState::Merged, 100),
            // GitHub retargeted the child to main when #1 merged.
            pr("o/r", 2, "feat/b", "main", "feat/a", PrState::Open, 100),
        ];
        let parents = derive_parents(&prs);
        assert_eq!(parents.get(&("o/r".to_string(), 2)), Some(&1));
        let groups = group_stacks(&prs, &parents);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![1, 2]);
        assert_eq!(groups[0].merged_count, 1);
        assert_eq!(groups[0].base_ref, "main");
    }

    #[test]
    fn diamond_picks_one_parent() {
        // Two PRs share the head branch name; the more recently fetched wins.
        let prs = vec![
            pr("o/r", 1, "feat/a", "main", "main", PrState::Closed, 10),
            pr("o/r", 2, "feat/a", "main", "main", PrState::Open, 20),
            pr("o/r", 3, "feat/b", "feat/a", "feat/a", PrState::Open, 5),
        ];
        let parents = derive_parents(&prs);
        assert_eq!(parents.get(&("o/r".to_string(), 3)), Some(&2));
        assert_eq!(parents.len(), 1);
        let groups = group_stacks(&prs, &parents);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![2, 3]);
    }

    #[test]
    fn siblings_share_one_group_ordered_by_depth_then_number() {
        let prs = vec![
            open("o/r", 5, "feat/c", "feat/a"),
            open("o/r", 4, "feat/b", "feat/a"),
            open("o/r", 1, "feat/a", "main"),
        ];
        let parents = derive_parents(&prs);
        let groups = group_stacks(&prs, &parents);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![1, 4, 5]);
    }

    #[test]
    fn single_pr_has_no_group() {
        let prs = vec![open("o/r", 1, "feat/a", "main")];
        let parents = derive_parents(&prs);
        assert!(parents.is_empty());
        assert!(group_stacks(&prs, &parents).is_empty());
        assert!(group_stacks(&[], &HashMap::new()).is_empty());
    }

    #[test]
    fn fork_pr_same_branch_name_different_repo_not_linked() {
        let prs = vec![
            open("o/r", 1, "feat/a", "main"),
            open("someone/r", 2, "feat/b", "feat/a"),
        ];
        let parents = derive_parents(&prs);
        assert!(parents.is_empty());
        assert!(group_stacks(&prs, &parents).is_empty());
    }

    #[test]
    fn head_branch_cycle_terminates() {
        let prs = vec![
            open("o/r", 1, "feat/a", "feat/b"),
            open("o/r", 2, "feat/b", "feat/a"),
        ];
        let parents = derive_parents(&prs);
        let groups = group_stacks(&prs, &parents);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members.len(), 2);
    }

    #[test]
    fn separate_stacks_stay_separate() {
        let prs = vec![
            open("o/r", 1, "a", "main"),
            open("o/r", 2, "b", "a"),
            open("o/r", 7, "x", "main"),
            open("o/r", 8, "y", "x"),
        ];
        let groups = group_stacks(&prs, &derive_parents(&prs));
        assert_eq!(
            groups.iter().map(|g| g.members.clone()).collect::<Vec<_>>(),
            vec![vec![1, 2], vec![7, 8]]
        );
    }

    #[test]
    fn parents_of_a_large_pool_derive_quickly() {
        // 10,000 PRs: chains of four, every head duplicated by an older
        // closed PR so each lookup has two candidates. Pairwise comparison
        // takes seconds here; an index takes milliseconds.
        let mut prs = Vec::new();
        for chain in 0..1250u32 {
            for step in 0..4u32 {
                let n = chain * 8 + step * 2 + 1;
                let head = format!("c{chain}/s{step}");
                let base = if step == 0 {
                    "main".to_string()
                } else {
                    format!("c{chain}/s{}", step - 1)
                };
                prs.push(pr("o/r", n, &head, &base, &base, PrState::Open, 200));
                prs.push(pr(
                    "o/r",
                    n + 1,
                    &head,
                    "main",
                    "main",
                    PrState::Closed,
                    100,
                ));
            }
        }
        assert_eq!(prs.len(), 10_000);
        let started = std::time::Instant::now();
        let parents = derive_parents(&prs);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "took {:?}",
            started.elapsed()
        );
        // Each non-base open PR picks the newer (open) same-head candidate.
        assert_eq!(parents.len(), 1250 * 3);
        assert_eq!(parents.get(&("o/r".to_string(), 3)), Some(&1));
        assert_eq!(parents.get(&("o/r".to_string(), 7)), Some(&5));
    }

    #[test]
    fn parent_tie_breaks_on_number_and_never_picks_itself() {
        // Same fetched_at: the higher number wins.
        let prs = vec![
            pr("o/r", 1, "feat/a", "main", "main", PrState::Open, 10),
            pr("o/r", 4, "feat/a", "main", "main", PrState::Open, 10),
            pr("o/r", 3, "feat/b", "feat/a", "feat/a", PrState::Open, 10),
        ];
        assert_eq!(derive_parents(&prs).get(&("o/r".to_string(), 3)), Some(&4));
        // A PR based on its own head skips itself and falls back to the
        // next candidate, even when it is the newest one.
        let prs = vec![
            pr("o/r", 1, "feat/a", "main", "main", PrState::Open, 10),
            pr("o/r", 2, "feat/a", "feat/a", "feat/a", PrState::Open, 99),
        ];
        let parents = derive_parents(&prs);
        assert_eq!(parents.get(&("o/r".to_string(), 2)), Some(&1));
        assert_eq!(parents.get(&("o/r".to_string(), 1)), None);
        let alone = vec![pr("o/r", 2, "feat/a", "feat/a", "feat/a", PrState::Open, 1)];
        assert!(derive_parents(&alone).is_empty());
    }

    #[test]
    fn tracking_is_limited_without_trace2() {
        assert_eq!(tracking_for(false, false), Tracking::Limited);
        assert_eq!(tracking_for(false, true), Tracking::Limited);
        assert_eq!(tracking_for(true, true), Tracking::Full);
        assert_eq!(tracking_for(true, false), Tracking::Full);
    }

    fn attention(
        snapshot: &PrSnapshot,
        parent: Option<&PrSnapshot>,
    ) -> (Attention, Option<String>) {
        attention_for(&PrEntryInputs {
            snapshot,
            parent,
            base_ref_label: snapshot.base_ref.clone(),
        })
    }

    fn reason(text: &str) -> Option<String> {
        Some(text.to_string())
    }

    #[test]
    fn order_conflict_beats_failing_checks() {
        let mut s = open("o/r", 2, "feat/b", "main");
        s.mergeable = Mergeable::Conflicting;
        s.checks = Checks::Failing;
        s.review = Review::ChangesRequested;
        s.behind_by = Some(4);
        assert_eq!(
            attention(&s, None),
            (Attention::Block, reason("Merge conflict"))
        );
        s.mergeable = Mergeable::Mergeable;
        assert_eq!(
            attention(&s, None),
            (Attention::Block, reason("Checks failing"))
        );
        s.checks = Checks::Pending;
        assert_eq!(
            attention(&s, None),
            (Attention::Block, reason("Changes requested"))
        );
        s.review = Review::Approved;
        assert_eq!(
            attention(&s, None),
            (Attention::Action, reason("Behind main by 4"))
        );
        s.behind_by = Some(0);
        assert_eq!(
            attention(&s, None),
            (Attention::Pending, reason("Checks running"))
        );
        s.checks = Checks::Passing;
        assert_eq!(attention(&s, None), (Attention::None, None));
        // A PR without checks or reviews is healthy.
        s.checks = Checks::None;
        s.review = Review::None;
        s.mergeable = Mergeable::Unknown;
        s.behind_by = None;
        assert_eq!(attention(&s, None), (Attention::None, None));
    }

    #[test]
    fn merged_pr_has_no_attention() {
        let mut s = pr("o/r", 1, "feat/a", "main", "main", PrState::Merged, 100);
        s.mergeable = Mergeable::Conflicting;
        s.checks = Checks::Failing;
        s.behind_by = Some(9);
        let parent = pr("o/r", 0, "base", "main", "main", PrState::Merged, 100);
        assert_eq!(attention(&s, Some(&parent)), (Attention::None, None));
    }

    #[test]
    fn closed_without_merge_is_none() {
        let mut s = pr("o/r", 1, "patch-1", "main", "main", PrState::Closed, 100);
        s.review = Review::ChangesRequested;
        s.checks = Checks::Pending;
        assert_eq!(attention(&s, None), (Attention::None, None));
    }

    #[test]
    fn restack_when_parent_merged() {
        let parent = pr("o/r", 1, "feat/a", "main", "main", PrState::Merged, 100);
        // GitHub retargeted the child to main when its parent merged.
        let mut child = pr("o/r", 2, "feat/b", "main", "feat/a", PrState::Open, 100);
        child.behind_by = Some(2);
        child.checks = Checks::Pending;
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
        // Blocking problems still win over a restack.
        child.checks = Checks::Failing;
        assert_eq!(attention(&child, Some(&parent)).0, Attention::Block);
    }

    #[test]
    fn restack_clears_once_retargeted_child_is_up_to_date() {
        let parent = pr("o/r", 1, "feat/a", "main", "main", PrState::Merged, 100);
        // Retargeted to main and rebased: nothing left to do.
        let mut child = pr("o/r", 2, "feat/b", "main", "feat/a", PrState::Open, 100);
        child.behind_by = Some(0);
        assert_eq!(attention(&child, Some(&parent)), (Attention::None, None));
        // Retargeted but still behind main: the ladder puts restack above
        // behind, so it reads "Needs restack", not "Behind main by 3".
        child.behind_by = Some(3);
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
        // Retargeted and the count is unknown: keep nagging.
        child.behind_by = None;
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
    }

    #[test]
    fn restack_while_child_still_targets_merged_parent_head() {
        let parent = pr("o/r", 1, "feat/a", "main", "main", PrState::Merged, 100);
        // Not retargeted yet: needs a restack even when up to date with it.
        let mut child = pr("o/r", 2, "feat/b", "feat/a", "feat/a", PrState::Open, 100);
        child.behind_by = Some(0);
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
        child.behind_by = None;
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
    }

    #[test]
    fn restack_when_parent_head_moved() {
        let parent = open("o/r", 1, "feat/a", "main");
        let mut child = open("o/r", 2, "feat/b", "feat/a");
        assert_eq!(attention(&child, Some(&parent)), (Attention::None, None));
        // The parent got new commits the child does not have.
        child.behind_by = Some(1);
        assert_eq!(
            attention(&child, Some(&parent)),
            (Attention::Action, reason("Needs restack"))
        );
        // Behind a base that is not the parent's head is just "behind".
        let unrelated = open("o/r", 3, "feat/z", "main");
        assert_eq!(
            attention(&child, Some(&unrelated)),
            (Attention::Action, reason("Behind feat/a by 1"))
        );
    }

    #[test]
    fn behind_reason_includes_base_and_count() {
        let mut s = open("o/r", 5, "feat/x", "release/2.0");
        s.behind_by = Some(12);
        let inputs = PrEntryInputs {
            snapshot: &s,
            parent: None,
            base_ref_label: "release/2.0".into(),
        };
        assert_eq!(
            attention_for(&inputs),
            (Attention::Action, reason("Behind release/2.0 by 12"))
        );
        s.behind_by = Some(1);
        assert_eq!(
            attention(&s, None),
            (Attention::Action, reason("Behind release/2.0 by 1"))
        );
        // The label comes from the caller, not from the snapshot's base ref.
        let inputs = PrEntryInputs {
            snapshot: &s,
            parent: None,
            base_ref_label: "upstream/release".into(),
        };
        assert_eq!(
            attention_for(&inputs),
            (Attention::Action, reason("Behind upstream/release by 1"))
        );
    }

    #[test]
    fn drafts_skip_checks_running_but_keep_other_reasons() {
        let mut s = open("o/r", 5, "feat/x", "main");
        s.is_draft = true;
        s.checks = Checks::Pending;
        assert_eq!(attention(&s, None), (Attention::None, None));
        s.checks = Checks::Failing;
        assert_eq!(
            attention(&s, None),
            (Attention::Block, reason("Checks failing"))
        );
    }

    #[test]
    fn attention_orders_none_pending_action_block() {
        assert!(Attention::None < Attention::Pending);
        assert!(Attention::Pending < Attention::Action);
        assert!(Attention::Action < Attention::Block);
    }
}
