//! Pure derivation of PR stacks and tracking quality from stored snapshots.
//!
//! A PR B is stacked on A when both live in the same repo and B was opened
//! against A's head branch (`B.original_base_ref == A.head_ref`). The original
//! base is used, not the current one, because GitHub retargets a child to the
//! default branch when its parent merges; the edge must survive that.

use std::collections::{HashMap, HashSet};

use crate::pr_store::{PrSnapshot, PrStackGroup, PrState, Tracking};

/// `(repo, child number) -> parent number`. When several PRs share the parent
/// head branch name, the most recently fetched one wins (highest number on a
/// tie). A merged parent still parents its children.
pub fn derive_parents(prs: &[PrSnapshot]) -> HashMap<(String, u32), u32> {
    let mut parents = HashMap::new();
    for child in prs {
        if child.original_base_ref.is_empty() {
            continue;
        }
        let parent = prs
            .iter()
            .filter(|candidate| {
                candidate.repo == child.repo
                    && candidate.number != child.number
                    && candidate.head_ref == child.original_base_ref
            })
            .max_by_key(|candidate| (candidate.fetched_at, candidate.number));
        if let Some(parent) = parent {
            parents.insert((child.repo.clone(), child.number), parent.number);
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
    use crate::pr_store::{Checks, Mergeable, PrState, Review};

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
    fn tracking_is_limited_without_trace2() {
        assert_eq!(tracking_for(false, false), Tracking::Limited);
        assert_eq!(tracking_for(false, true), Tracking::Limited);
        assert_eq!(tracking_for(true, true), Tracking::Full);
        assert_eq!(tracking_for(true, false), Tracking::Full);
    }
}
