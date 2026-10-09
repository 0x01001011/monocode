# Product

## Register

product

## Users

Developers who supervise coding agents (Claude Code, Codex, Cursor, and others) from one desktop app. They often run long work in parallel: superpowers plans executed by subagents, orchestration runs with workers, several sessions at once. They glance at MonoCode between their own tasks and need answers in seconds: what is running, is anything stuck, how long has it taken, and what needs me.

## Product Purpose

MonoCode is a desktop UI for coding agents that uses the user's existing subscriptions. Tabs are sessions; the composer is the input. Success is a user who trusts the agents enough to look away, because MonoCode makes progress, time, and problems visible the moment they glance back.

## Brand Personality

Warm, friendly, approachable. Plain words over jargon, short sentences that explain what happened, and states that read like a helpful colleague's note ("Waiting on review, 2m") rather than a log line. Friendly does not mean loud: warmth comes from copy, rounded but modest shapes, and gentle motion, not from decoration.

## Anti-references

- Jira-style boards: heavy cards, colored swimlanes, badge clutter, columns for their own sake.
- Dashboards built from hero metrics and stat tiles.
- Log dumps presented as UI (raw ledger lines, unformatted status strings).

References to borrow from, for specific qualities:
- Linear: status glyphs, tabular metadata, restraint, keyboard navigation.
- GitHub Actions run view: job and step tree with durations and unmistakable failure states.
- Raycast: compact keyboard-first lists with crisp secondary text.

## Design Principles

1. Answer the glance. The first line of any surface says what is happening now and whether the user is needed.
2. Show real state only. Never invent progress; unknown is shown as unknown.
3. Calm until it matters. Quiet chrome by default; color and motion are spent on running, failed, and needs-you states.
4. Speak like a colleague. Copy explains in plain words; raw machine text is one click away, not the headline.
5. One vocabulary everywhere. The same glyph, color, and duration format mean the same thing in every panel.

## Accessibility & Inclusion

WCAG 2.2 AA: 4.5:1 body text contrast, 3:1 for glyphs and large text, full keyboard operation with visible focus, `prefers-reduced-motion` honored, and status never conveyed by color alone (always a glyph or word too).
