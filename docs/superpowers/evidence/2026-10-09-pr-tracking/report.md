# Chat PR tracking: browser verification

Verification of the real PR-tracking components in Chromium and Playwright WebKit. The unit and Rust suites are reported in the PR description.

## How it was verified

- **Harness.** `tests/browser/pr-tracking.html` and `pr-tracking.tsx` mount the real components:
  - the chip and its card
  - `PrSidebarSlot`
  - `PrSection`
  - `PrInboxStack` (rail and health line)
  - the composer header row, built from the real `CwdPicker`, `WorkspaceIdentity`, `BranchPicker`, `PrChip` and `ContextMeter` inside a `composer-head` div, so the container queries and the branch floor run for real.
- **Tauri stand-in.** Tauri's own `mockIPC` (with `shouldMockEvents`) replaces the backend, so the real `invoke`/`listen` store and hooks run unchanged. Hide and Undo go through `pr_dismiss` and a `pr-set-changed` event.
- **Fixtures** (`?fixture=`): `stack` (3-stack with a merged middle, Other, another chat's PR), `ok`, `ghMissing`, `signedOut`, `offline`, `idle`, `rateLimited`, `many` (40 PRs), `i18n` (CJK, emoji, 200-character title), `stale` (20 min), `limited`, `hidden`, `empty`, `neighbor`.
- **Query options:** `?theme=light`, `?w=` (composer row width), `?pw=` (panel width), `?iw=` (Inbox width).
- **Spec.** `tests/browser/pr-tracking.spec.ts` runs on Chromium and Playwright WebKit. `PR_EVIDENCE=1` also writes the screenshots and `metrics-*.json` into this directory.
- **Audits.** The contrast and target checks are ports of the audit scripts used on the design mockup. They add the popover glass layer and covering `::before` halos to the background stack.
  - *Contrast* measures elements with their own text, and every `svg`. It skips text inside an `aria-hidden="true"` subtree (decorative; icons are still measured), `visibility: hidden`, `display: none`, zero-size boxes, effective opacity below 0.05 (ancestor opacities multiplied) and anything inside a disabled element. App chrome outside this feature is skipped (the ContextMeter wrapper and the CwdPicker root).
  - *Targets* skip `display: none`, `visibility: hidden`, 0×0 boxes and the same two chrome rules; an absolutely positioned `::before` or `::after` counts as hit area.
  - Both audits run per region (chip, sidebar glyph, Changes panel, Inbox, card, row menu) and per fixture, and assert that they measured at least one text item and one icon (or zero where the fixture renders nothing). A self-test feeds them a deliberately bad DOM and expects failures, so they cannot pass vacuously.

### What the spec checks

- **Overflow:** at 900, 600, 420, 400, 360, 320 and 300px rows, nothing sticks out of the composer row, the panel or the 360px card, and the card stays in the viewport.
- **Narrow rules:** 400px hides the strip and +N; 320px hides the Worktree label.
- **Branch label:** at least 8 characters show at 900px, and the chip stays inside the row at 300, 420 and 600px.
- **Contrast:** text at least 4.5:1 and icons at least 3:1, in both themes, across all 14 fixtures, with the card pinned and the row menu open.
- **Targets:** every interactive element is at least 24×24.
- **Focus ring:** 2px solid with a 2px offset on the chip, card row, sidebar glyph, panel row and rail node.
- **Forced colors:** the ring is drawn in `Highlight`, including on the stale sidebar glyph.
- **Keyboard:**
  - Esc closes a hover preview without moving focus.
  - Esc closes a pinned card and returns focus to the chip.
  - Tab past the last stop (or Shift+Tab before the first) closes the card onto the chip.
  - Esc in a row menu closes only the menu.
  - The panel's split menu takes focus.
  - ↑/↓/Home/End rove as one tab stop in the card and the panel.
- **Hover timing:** 220ms on the chip; 400ms on the sidebar glyph, opening to the right.
- **40 PRs:** the frame is at most 440px and the body scrolls inside it.
- **Rail:** going from 3200px down to 320px, modes only move full, then compact, then scroll; the viewed node keeps its title, and in scroll mode it is centered (clamped at the ends).
- **Other states:** reduced motion turns off the card's open animation; stale elements keep opacity 1; the icon halo matches the row fill; at 200% zoom (a 640×500 viewport) the card still fits; no console errors; row height is recorded and must be 38-48px.

Result: 69 passed, 5 skipped across Chromium and WebKit in a normal run (the skips are the 4 evidence-screenshot tests, which need `PR_EVIDENCE=1`, and forced colors on WebKit, which Playwright can only emulate in Chromium). With `PR_EVIDENCE=1`: 73 passed, 1 skipped. Hover timing is stepped with a paused `page.clock` (no card at 219ms, card at 220ms; 399/400ms on the sidebar) and was run 5 times per engine without a failure.

## Measured numbers

| Measure | Chromium | WebKit |
|---|---|---|
| Contrast minimum, dark | text 4.82, icons 4.82 | same |
| Contrast minimum, light | text 4.70, icons 3.28 | same |
| Smallest target | 33×24 (sidebar glyph with its hit area) | same |
| Branch characters visible at 900/600/420/400/360/320/300px | 34/22/11/11/11/11/11 | 34/21/11/11/11/11/11 |
| Card row height | 45.8px (43.8px without a tag) | same |
| Rail-12 mode by Inbox width | full at 2880 and up, compact 2840-1320, scroll at 1280 and below | same |
| Rails at a 640px Inbox | 3 compact, 6 scroll, 12 scroll | same |
| Harness load to ready, median of 5 (Vite dev server) | 102ms | 108ms |
| Card open-to-paint, median/p95 of 20 (includes a ~33ms floor from 2 animation frames) | 33.6/34.9ms | 32/39ms |
| 40-PR card scroll frames, p50/p95/max | 16.7/16.8/16.8ms | 16/25/27ms |
| DOM nodes: page / stack card / 40-PR card | 556 / 190 / 857 | same |

Raw data: `metrics-chromium.json`, `metrics-webkit.json` (contrast minima per theme, fixture and region, smallest target, branch characters per width, rail modes, row heights, timings).

## Defects found by the browser run and fixed

1. **`ebe7fc8` Branch floor overflowed at 360px.** The `min(14ch, 45cqi)` floor sat on a wrapper that inherits 16px, so 14ch came to 141px instead of about 106px. At a 360px row the context meter was pushed 6px past the row's clipped edge and the cwd picker shrank to 0px. The wrapper now uses the label's 12px.
2. **`1b91afd` Viewed rail node title was 4.41:1 in light.** It used fixed 70% ink; it now uses `--color-ink-on-fill`.
3. **`1714834` Row ⋯ menu and panel split menu opened without focus.** Focus stayed on the trigger and arrow keys did nothing. Each menu focused its first item while the Popover was still hidden for measuring, and hidden elements cannot take focus; happy-dom could not see this. They now retry on the next frame.
4. **`c084f9a` Inbox rail nodes could not be reached by Tab in WebKit.** They are plain links, which WebKit (the macOS webview's engine) skips by default. They now have an explicit `tabIndex={0}`, like the PR rows.
5. **`e2dde5a` Icon halo drew a disc around the HEAD icon in light.** It used fixed 12% ink (and the bare background on hover) instead of the row's own fill. It now uses the row's selection strengths.

Each fix has a unit test and a browser assertion.

## Observations, not changed

- **App chrome outside this feature:** the `ContextMeter` ring is 2.54:1 in light, the `CwdPicker` trigger is 215×18, and at 360px the cwd picker shows only "~.".
- **Dark glass:** popovers blur what is behind them over a 2% tint. Contrast was measured against the theme background, and colored content behind the card can lower the real figure.
- **Row height:** rows are 44-46px, not the brief's 40px.
- **Counts differ by design:** the panel header counts every row, including another chat's PR (7); the card counts "from this chat" (6).
- **Strip bar opacity:** non-current strip bars use opacity 0.6. The strip is decorative and hidden from screen readers, and these are not stale markers.

## Not verified

- VoiceOver output.
- The real WKWebView, including whether the macOS keyboard-navigation setting changes which buttons Tab reaches.
- True browser zoom (only a 640×500 equivalent viewport was tested).
- Forced colors in WebKit, and real Windows High Contrast.
- Real `gh` data and tracker timing across a long session.
- The installed app (no Tauri build was made); its real containers were stood in for by harness markup.
- Performance on a loaded machine or a 120Hz display.

## Screenshots

All are 2× PNGs, each under 400KB, prefixed `dark-` or `light-`; a WebKit cross-check set is prefixed `webkit-`.

- Composer chip: closed, hover, pinned, narrow 360/300, all-hidden.
- Card for each tracker status: `ok`, `ghMissing`, `signedOut`, `offline`, `idle`, `rateLimited`.
- Card states: many, i18n, stale, limited, neighbor.
- Sidebar glyph rows and hover.
- Changes panel section.
- Inbox rails 3/6/12 with health lines, plus narrow 420px.
