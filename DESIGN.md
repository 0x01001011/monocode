---
name: MonoCode
description: A dense, dark desktop console for supervising coding agents across projects, worktrees and remote machines.
colors:
  background-base: "#171717"
  background-base-light: "#f7f7f7"
  content: "#ebebeb"
  content-light: "#2e2e2e"
  stroke: "#262626"
  stroke-light: "#e9e9e9"
  selection-subtle: "#282828"
  selection: "#2c2c2c"
  selection-strong: "#303030"
  selection-hover: "#373737"
  selection-emphasis: "#414141"
  accent: "#459bf7"
  link: "#7dd3fc"
  link-light: "#0863c4"
  skill: "#e8c547"
  skill-light: "#a07c10"
  mention: "#38bdf8"
  mention-light: "#0284c7"
  markdown-heading: "#f9a8c9"
  markdown-heading-light: "#be185d"
  diff-add: "#10b981"
  diff-add-fg: "#6ee7b7"
  diff-add-fg-light: "#047857"
  diff-del: "#f43f5e"
  diff-del-fg: "#fda4af"
  diff-del-fg-light: "#be123c"
typography:
  page-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
  section-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  micro-caps:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.08em"
  composer:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "tnum"
  terminal:
    fontFamily: "JetBrainsMono NFM, JetBrainsMono Nerd Font Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
  control-sm: "24px"
  control: "28px"
  tab: "30px"
  control-lg: "32px"
  bar: "36px"
components:
  button-primary:
    backgroundColor: "#ffffff"
    textColor: "#000000"
    rounded: "{rounded.md}"
    height: "26px"
    width: "26px"
  button-primary-light:
    backgroundColor: "{colors.content-light}"
    textColor: "{colors.background-base-light}"
    rounded: "{rounded.md}"
  button-secondary:
    textColor: "{colors.content}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    typography: "{typography.ui}"
  button-secondary-hover:
    backgroundColor: "{colors.selection}"
  menu-item:
    textColor: "{colors.content}"
    rounded: "{rounded.lg}"
    height: "28px"
    padding: "0 8px"
  menu-item-hover:
    backgroundColor: "{colors.selection-subtle}"
  tab:
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 8px"
  tab-active:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.content}"
  settings-group:
    rounded: "{rounded.xl}"
    padding: "14px 16px"
  modal:
    backgroundColor: "{colors.background-base}"
    rounded: "{rounded.2xl}"
    width: "420px"
  composer:
    rounded: "{rounded.lg}"
    typography: "{typography.composer}"
---

# Design System: MonoCode

## 1. Overview

**Creative North Star: "The Night Console"**

MonoCode is a control room that stays out of the operator's way. One near-black ground (#171717) carries everything. Hierarchy comes from the opacity of a single ink (`content`, #ebebeb) laid over that ground, not from a palette of grays. Transcripts, diffs and code get full ink; chrome, metadata and hints step down in alpha. A single cool blue accent marks the user's own focus and selection. Diff and status hues appear only where they carry meaning.

The system is dense on purpose. Controls are 24 to 32px tall, body text is 12 to 13px, and a full working view shows the project rail, the session sidebar, title-bar tabs, a transcript, a composer and often a split pane at once. It rejects generic AI-tool marketing UI, SaaS dashboard clichés, chat-app softness that wastes space, and web-app chrome that ignores the desktop (see PRODUCT.md).

The theme is user-tunable. `--theme-hue`, `--theme-saturation` and `--theme-dark-lightness` (0–30%) re-tint the ground and ink. A light theme (`html.theme-light`) swaps the lightness pair to 97% ground and 18% ink and lowers the selection strengths. On macOS the sidebar and body can sit on native vibrancy (`has-native-glass`).

**Key Characteristics:**
- One ground and one ink. Gray steps are alpha mixes of `content`, never a separate gray ramp.
- Structure comes from tonal fills (`selection-*`) and 7% hairlines (`stroke`), with very few shadows.
- System UI font throughout. Mono only for code, paths, counters and the terminal.
- Motion runs 120–200ms with a single ease-out curve, and every animated class has a reduced-motion fallback.
- Layout reacts to its container: settings rows stack below 560px and the composer toolbar hides labels below 220px.

## 2. Colors

A restrained, near-monochrome palette. One ink at graded alpha over one ground, a single blue accent, and semantic hues reserved for diffs, skills, mentions and links.

### Primary
- **Signal Blue** (#459bf7, `hsl(211 92% 62%)`): the accent. Marks the selected session card (`bg-accent/15`), drop targets, the "on" state of switches, focus rings (`outline-accent`, `ring-accent`), unread badges and the file-drag overlay. It is never decoration. It has no light-theme override yet, so on the light ground it reaches only 2.69:1.

### Secondary
- **Sky Link** (#7dd3fc dark, #0863c4 light): links in markdown and agent output (`--link-color`). This is the only token with a dedicated light-theme value tuned for contrast (5.46:1 on #f7f7f7).

### Tertiary
- **Skill Gold** (#e8c547 dark, #a07c10 light): `/skill` tokens in the composer and transcript.
- **Mention Cyan** (#38bdf8 dark, #0284c7 light): `@` file and session mentions.
- **Heading Rose** (#f9a8c9 dark, #be185d light): markdown headings in the source editor.
- **Diff pair**: add (#10b981 marker, #6ee7b7 text dark, #047857 text light) and delete (#f43f5e marker, #fda4af text dark, #be123c text light). Rows use 15% tints and gutters 25%. `diff-palette-colorblind` swaps to blue/orange and `diff-palette-high-contrast` uses heavier 28%/45% tints.

### Neutral
- **Night Ground** (#171717, `hsl(240 0% 9%)`; light #f7f7f7): `background-base`. The window, sidebar (mixed 10% toward black) and modal glass.
- **Paper Ink** (#ebebeb, `hsl(240 0% 92%)`; light #2e2e2e): `content`. Primary text and the source of every gray step.
- **Hairline** (#262626; light #e9e9e9): `stroke`, which is `content` at 7%. Used for structural separators (`border-stroke`, `divide-stroke`).
- **Selection ladder** (#282828 → #414141 dark): `selection-subtle` 8%, `selection` 10%, `selection-strong` 12%, `selection-hover` 15%, `selection-emphasis` 20%. Light theme uses 5/6/7/10/14%. Active tabs, selected tree rows and pressed menus.

Text opacity tiers in use (`text-content/NN`), with measured contrast on the default ground:

| Tier | Uses | Dark (#171717) | Light (#f7f7f7) |
| --- | --- | --- | --- |
| /70 | 116 | 7.81:1 | 5.05:1 |
| /55 | 109 | 5.33:1 | 3.31:1 |
| /50 | 272 | 4.60:1 | 2.87:1 |
| /45 | 269 | 3.95:1 | 2.53:1 |
| /40 | 195 | 3.41:1 | 2.25:1 |
| /35 | 98 | 2.89:1 | 2.00:1 |

### Named Rules
**The One Ink Rule.** Every neutral is `content` mixed with transparency. Never introduce a literal gray hex. Reach for `selection-*` for fills and `stroke` for lines.

**The Accent Is A Cursor Rule.** Signal Blue marks where the user is: selection, focus, drop target, "on". It never fills a decorative surface and never colors body text.

**The AA Floor Rule.** Text that carries information uses a tier that clears 4.5:1 in the active theme: /55 or stronger on dark and /70 or stronger on light. Tiers below that are for disabled or purely decorative text only.

## 3. Typography

**Display Font:** none. The product has no display face.
**Body Font:** `system-ui` stack (`--font-sans`: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …).
**Label/Mono Font:** `ui-monospace` stack (`--font-mono`) for code, paths and counters. JetBrains Mono Nerd Font leads the terminal-only stack (`--font-terminal`).

**Character:** The platform's own sans, so MonoCode reads as a native desktop app on each OS. Weight and alpha carry hierarchy far more than size does.

### Hierarchy
- **Page title** (600, 20px, 1.25): the top of Settings, Automations and the Mono chat (`text-[20px] font-semibold`).
- **Section title** (600, 13px): Settings group headings, dialog headings in source-control and project dialogs, the sidebar session title.
- **Body** (400, 13px, 1.5): settings row labels, menu items, file-tab labels, transcript chrome.
- **UI** (400, 12px): buttons (`SecondaryButton`), descriptions, inbox rows. The most common size (406 uses).
- **Label** (400–500, 11px): metadata such as model names, branch names, counts and timestamps (317 uses).
- **Micro caps** (600, 10px, uppercase, 0.04–0.08em tracking): section labels in menus and panels (`SessionFiltersMenu`, `GitChangesPanel`).
- **Composer** (400, 14px, 22px line): the session composer textarea (`text-sm leading-5.5`). The quick composer uses 16px.
- **Explorer row** (400, 14px): file tree rows.

`--leading-label: 1.4` is the one typography token in `@theme`. It keeps descenders inside compact two-line tab labels. Sizes are written as arbitrary pixel utilities (`text-[12px]`); there is no named size scale.

### Named Rules
**The Weight-Before-Size Rule.** Raise emphasis with weight (400 → 500 → 600) and ink alpha before you raise size. Stay inside the 10–14px band for application chrome; 20px is reserved for page titles.

**The Tabular Counter Rule.** Any number that changes while visible (usage percentages, diff stats, match counts, badges, timers) uses `tabular-nums`.

## 4. Elevation

The system is flat and layered by tone. Depth comes from alpha fills of `content` (`bg-content/3` cards, `bg-content/5` hovers, `bg-selection` actives) and 7–10% hairlines. Shadows appear only on surfaces that float above the window: popovers and menus (`shadow-xl`), modals (`shadow-2xl` over a `bg-black/40` scrim) and toasts. Light theme gives the composer a soft two-layer lift because tonal fills alone disappear on a pale ground.

### Shadow Vocabulary
- **Floating menu** (`box-shadow: var(--tw-shadow-xl)`, i.e. `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`): `Popover` frames, approval toasts.
- **Dialog** (`shadow-2xl`, `0 25px 50px -12px rgb(0 0 0 / 0.25)`): `Modal` panel.
- **Light composer lift** (`0 6px 24px color-mix(in srgb, var(--color-content) 9%, transparent), 0 2px 6px color-mix(in srgb, var(--color-content) 6%, transparent)`): `[data-composer-box]` under `html.theme-light`.
- **Bottom sheet** (`0 -12px 32px rgb(0 0 0 / 0.18)`): the Mono artifact sheet.

### Named Rules
**The Flat-At-Rest Rule.** Anything that lives in the window's layout is flat. A shadow means "this floats above the window and will go away".

## 5. Components

### Buttons
Restrained and compact. The primary action is a solid ink chip, not a colored pill.
- **Shape:** gently squared (6px, `rounded-md`). Primary icon buttons are 26px squares (`size-6.5`).
- **Primary (`.primary-action`):** white fill with black glyph on dark; `content` fill with `background-base` glyph on light; the user's accent color with `--user-accent-foreground` when an accent is set. Hover drops to 90% fill. Disabled drops to 30% fill. Used for composer send and similar commit actions.
- **Secondary (`SecondaryButton`):** 1px `content/10` border, 12px text at `content/70`, padding 4px 10px. Hover fills `content/10` and brightens text to full ink. Focus shows a 2px accent outline. `danger` turns text red-400 with a red-400/10 hover fill.
- **Destructive confirm:** `bg-red-500/20` with red-400 text, medium weight, label repeats the action ("Delete session").
- **Ghost icon buttons:** 20–28px squares, `content/45–50` glyph, `hover:bg-content/8–10`. Many reveal on row hover.
- **Press:** `active:scale-[0.97]` on most buttons that have press feedback.

### Chips
- **Style:** `rounded-full` or `rounded`, 9–11px text, `bg-content/[0.07]` with an inset `ring-content/[0.07]`. Used for account badges, label chips, counts and the "v1" tag.
- **State:** count badges on the rail use a solid accent fill with white tabular digits.

### Cards / Containers
- **Corner Style:** 8px for session cards and the composer, 12px for settings groups and popovers, 16px for modals.
- **Background:** `bg-content/3` for settings groups and the composer; `bg-accent/15` for the selected session card; `bg-selection` for the active session.
- **Shadow Strategy:** flat (see Elevation). Only floating surfaces cast shadows.
- **Border:** `border-content/10` on groups and the composer; rows inside groups separate with `border-content/5`. Draft sessions use a dashed `content/25–30` border.
- **Internal Padding:** settings rows 14px by 16px; session cards 6–10px by 10px; menus 4px with 8px-radius items (concentric with the 12px frame).

### Inputs / Fields
- **Style:** borderless text on a tonal fill (`bg-content/5–10`), 6–8px radius, 12–13px text, placeholders at `content/35–40`. The composer is a transparent textarea over a highlight layer that renders `/commands` and `@mentions` in their token colors.
- **Focus:** most fields drop the outline and rely on the caret plus a border step (`border-content/10 → /20`) or a 1px accent ring (`ring-1 ring-accent/40`) for inline rename fields.
- **Error / Disabled:** inline error text in red-400 below the field; disabled at 40–50% opacity.

### Navigation
- **Project rail:** a narrow left column of project logos or mascots with activity dots cut out of the icon (`.compact-rail-icon-with-dot`). Selected and hovered rows fill `content/5`.
- **Session sidebar:** cards with harness icon, model label (11px `content/50`), title (13px semibold) and git branch line. Glass-tinted (`.sidebar-glass`) and user-adjustable opacity.
- **Title-bar tabs:** 30px tall, 6px radius, active tab on `bg-selection`, inactive at `content/50`. Close buttons appear on hover. Tabs open and close by animating slot width (`--motion-tab-close-duration` 200ms).
- **Menus:** `Popover` portals with a 12px glass frame, 4px padding, 28px rows, 13px text, 10px uppercase section labels.

### Motion
- **Tokens:** `--motion-feedback-duration` 120ms, `--motion-reorder-duration` 160ms, `--motion-tab-close-duration` 200ms, `--motion-ease-out` `cubic-bezier(0.22, 1, 0.36, 1)`, `--motion-tab-ease-out` `cubic-bezier(0.3333, 0.6667, 0.6667, 1)`.
- **Behavior:** colors and fills transition at 120ms. Modals rise in over 200ms. Living status uses a text shimmer (`.shimmer-text`).
- **Reduced motion:** each animation block has a `prefers-reduced-motion: reduce` counterpart, and JavaScript motion hooks check the same query.

### Session Composer (signature)
The single most-used surface. An 8px-radius box with a `content/10` border that steps to `content/20` while focused, a 14px textarea with a token-coloring overlay, a horizontally scrolling toolbar of pickers (model, access, MCP, project) that collapses labels under 220px, and a 26px primary send button that becomes a stop button while the agent runs.

## 6. Do's and Don'ts

### Do:
- **Do** derive every gray from `content` with alpha (`text-content/70`, `bg-content/5`) or from the `selection-*` and `stroke` tokens.
- **Do** keep informational text at /55 or stronger on dark and /70 or stronger on light, so it clears 4.5:1 on the default ground.
- **Do** keep chrome inside the 10–14px band, raise emphasis with weight first, and reserve 20px for page titles.
- **Do** use `tabular-nums` on every counter, percentage, timer and diff stat.
- **Do** put the primary action on `.primary-action` so it follows the theme and the user's accent.
- **Do** pair every animation with a `prefers-reduced-motion: reduce` fallback and keep transitions between 120 and 200ms.
- **Do** keep nested radii concentric: a 12px frame with 4px padding holds 8px items.
- **Do** show status with an icon or label as well as color, the way diffs always carry +/-.

### Don't:
- **Don't** add generic AI-tool marketing UI: gradient text, glowing purple-blue hero art, sparkle icons on every action.
- **Don't** add SaaS dashboard clichés: hero metric cards, equal-tile card grids, decorative charts.
- **Don't** add chat-app softness that wastes space: oversized bubbles, avatars on every turn, playful copy in errors.
- **Don't** ship web-app chrome that ignores the desktop: custom scrollbars on macOS, modals as the default answer, layout that shifts while agents stream.
- **Don't** introduce literal gray hex values or a second neutral ramp.
- **Don't** use Signal Blue for decoration or body text, and don't put white text on it (2.88:1).
- **Don't** use raw Tailwind status shades (`text-red-400`, `text-amber-400`, `text-emerald-400`) for text on the light theme; they measure 1.6–2.7:1 there.
- **Don't** cast shadows from in-layout surfaces; shadows mean "floating".
- **Don't** use `transition: all`, bounce or overshoot easing on routine interactions.
