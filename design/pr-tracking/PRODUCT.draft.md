# Product

## Register

product

## Users

Developers who run several coding agents at once (Claude Code, Codex, Cursor, Grok Build, OpenCode, Pi and others) on their own subscriptions. A typical session has 3 to 8 chats open across one or more projects, many of them in separate git worktrees. Agents create branches, push, open pull requests and switch branches on their own. The user steers, reviews and merges. They are in focused, multi-threaded work: glancing between panes, checking what each agent produced, and deciding what ships next.

## Product Purpose

MonoCode is a desktop UI for coding agents. Tabs are sessions; the composer is the input. It does not sell tokens. Success means the user can run many agents in parallel without losing track of which chat touched which branch, which pull requests exist, and what state each one is in, and without leaving the app for GitHub to find out.

## Brand Personality

Quiet, exact, fast. The voice is terse and literal: short labels, real nouns ("PR #412", "behind main by 3"), no marketing tone. The interface should feel like a well-kept instrument, trusted at a glance, dense when needed, and never decorative.

## Anti-references

- SaaS dashboard chrome: hero metrics, gradient accents, card grids, colored side stripes.
- GitHub's own PR page density in a 360px popover: every badge, label and avatar at once.
- Status that only shows as color, or that animates for attention when nothing has changed.
- Modals for things a hover card or inline row can answer.

## Design Principles

1. **At rest, one glance; on hover, the full story.** Surfaces show the minimum signal by default and reveal detail progressively.
2. **The chat remembers.** Anything an agent produced (branches, PRs, worktrees) stays attached to its chat even after the working copy moves on.
3. **Earned familiarity.** Use GitHub's own status vocabulary, icons and colors so nothing needs learning.
4. **Truth over freshness theater.** Show when data was last checked and why it may be stale, rather than spinners or fake liveness.
5. **Every state is designed.** Loading, empty, stale, signed-out and rate-limited are first-class, not afterthoughts.

## Accessibility & Inclusion

WCAG 2.2 AA. Status is never color alone (icon shape plus text label). Every hover surface is reachable and operable by keyboard focus. Respect `prefers-reduced-motion`. Dark and light themes both meet contrast at the small 10 to 12px sizes this app uses.
