Draft inferred during an automated audit; please review.

# Product

This draft was inferred from `README.md`, `CONTRIBUTING.md`, `docs/remote-access.md`, `CLAUDE.md` and the UI code under `src/`. No interview took place. Treat every statement as a hypothesis until a maintainer confirms it.

## Register

product

## Users

Developers who already pay for one or more coding-agent subscriptions (Claude Code, Codex, Cursor CLI, Grok Build, OpenCode, Antigravity, Pi, omp, fx, Hermes Agent) and want to run them side by side. Most are comfortable in a terminal and a code editor. They keep MonoCode open all day on a laptop or desktop display. Some run agents on an always-on remote machine over SSH and drive them from the desktop.

The usual context: several projects open at once, each with git worktrees and several agent sessions running in parallel. The user switches between sessions, approves tool calls, reviews diffs, answers agent questions and starts new work. They often glance at the app while doing something else, so status has to be readable at a glance.

## Product Purpose

MonoCode is a desktop UI for coding agents. Tabs are sessions and the composer is the input. It finds the provider CLIs that are installed and signed in, runs them, and shows their transcripts, tool calls, diffs and approvals in one window. It also covers the work around a session: projects and worktrees, source control, a file tree and editor tabs, an inbox of issues and pull requests, notes, automations, Monos (long-lived assistant agents) and a quick composer.

It does not sell tokens. Success means a developer can supervise many agents across many projects without losing track of which one needs them, and can move from "agent asked for approval" to "approved and back to work" in a few seconds.

## Brand Personality

Quiet, dense, precise. The interface steps back so agent output and code carry the screen. The voice is plain and direct, with sentence-case labels and verb-first actions. Small moments of play exist (mascots, the welcome animations, the "btw" burst), but they stay rare and never sit in the path of routine work.

Reference points, inferred from the code: native macOS chrome (vibrancy, traffic lights, title-bar tabs), VS Code conventions in the editor and source-control panels, and the calm density of Linear and Raycast.

## Anti-references

- Generic AI-tool marketing UI: gradient text, glowing purple-blue hero art, sparkle icons on every action.
- SaaS dashboard clichés: hero metric cards, card grids of equal tiles, decorative charts.
- Chat-app softness that wastes space: oversized bubbles, avatars on every turn, playful copy in error states.
- Web-app chrome that ignores the desktop: custom scrollbars on macOS, non-native-feeling modals as the default answer, layout that shifts while agents stream.

## Design Principles

1. **The work is the interface.** Transcripts, diffs and code get the space and contrast. Chrome uses tinted neutrals and steps back.
2. **Status at a glance.** Working, waiting for approval, done and failed must be readable from the rail and sidebar without opening a session, and never by color alone.
3. **Density without strain.** Pack information like a professional tool, but keep text legible, targets reachable and contrast within WCAG AA.
4. **Keyboard first.** Everything a mouse can do, the keyboard can do, with a visible focus ring and the shortcut shown next to the command.
5. **Calm motion.** Motion confirms a state change and then gets out of the way. Reduced-motion settings are honored everywhere.

## Accessibility & Inclusion

Inferred target: WCAG 2.2 AA for both the dark and light themes. Existing commitments in the code:

- Colorblind-safe and high-contrast diff palettes, with a +/- glyph so color is never the only cue (`src/styles/index.css`).
- An interface scale from 50% to 200% (`src/features/settings/model/uiScale.ts`).
- Wide `prefers-reduced-motion` coverage in CSS and in the JavaScript motion hooks.
- User-adjustable theme hue, saturation and dark-mode lightness. These change rendered contrast, so contrast must hold across the whole allowed range.

Open questions for a maintainer: confirm the WCAG level, whether screen-reader support for live agent status is a goal, and whether Windows High Contrast (forced colors) is in scope.
