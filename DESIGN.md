# lmao — UI design handoff

Strict, utilitarian, engineering-style interface in the spirit of teenage engineering. Pure black theme. Stack: Flask templates + Tailwind CSS v4 (browser build, no build step) + Alpine.js.

## Source of truth

- Variables collection `tokens` has `WEB` code syntax (`var(--color-*)`)
- Light theme: **not designed yet**. Tokens are the only thing that must change when it is added. Icons use `currentColor` for this reason.

| Figma frame | Node | Alpine state | setup | archive |
|---|---|---|---|---|
| 01 start | `11:2` | `view='idle'` | open | open |
| 02 running | `11:120` | `view='running'` | **closed** (auto on run start) | open |
| 03 results | `17:108` | `view='results'`, `resultsView='model'` | open | open |
| 04 results | `17:308` | same | closed | open |
| 05 results | `17:447` | same | open | closed |
| 06 results (focus) | `17:625` | same | closed | closed |
| 07 per question | `34:238` | `resultsView='question'` | open | open |

The frames predate several additions (first screen checklist, topbar status, phase progress, chart, summary figures, Markdown answers). See "Additions without a Figma frame".

| Component | Node |
|---|---|
| button/primary, button/secondary | `4:2`, `4:4` |
| field/input, field/select | `4:6`, `4:10` |
| checkbox-row | `4:24` |
| archive-item | `4:34` |
| nav-toggle | `4:51` |
| status-row | `4:68` |
| activity-dot | `33:221` |
| view-tab | `33:228` |

## Rules of the system

1. Zero border-radius, zero shadows, zero gradients. `_theme.html` removes those theme keys, so `rounded-*` / `shadow-*` produce nothing.
2. Body text is Inter Light 300 at 13px. Inter Thin 100 is used only for large score numerals.
   `tabular-nums` only where digits change live (topbar status, phase counters, row timers) or stand in columns (matrix, except the name column). Not on the body: in Inter it also widens the hyphen, which breaks names like `ministral-3:3b`.
3. Structure comes from 1px hairlines (`border-line`), not fills. The only elevation device is `bg-surface` (panels, answer boxes, load notice, chart quadrant).
4. Color is rationed: neutrals + `link` (running state, dot) + `warn` (errors only). Scores are plain numbers, no green/yellow/red scale; bars and charts are monochrome.
5. Text is always left-aligned. Min text size 13px. The topbar status and the first screen are the only centred blocks; the text inside them is still left-aligned. The chart and score scale are axes, not text blocks.

## Setup

`templates/_theme.html` is a head partial: fonts, `@tailwindcss/browser@4.3.2`, theme tokens, Alpine `3.14.9`. Include it in `base.html` inside `<head>`.

Notes:
- `--spacing: 1px`, so `p-22` = 22px, `gap-15` = 15px, `w-320` = 320px, `h-66` = 66px. Tailwind doc examples such as `p-4` become 4px.
- Tailwind's browser build compiles in the client: expect a short unstyled flash and runtime cost. Fine for a local tool; use `x-cloak` for Alpine blocks.
- Theme `@theme` must live in an inline `<style type="text/tailwindcss">`; the browser build does not load an external theme file.
- `static/favicon.svg` is a square icon (frame with a filled strip, the nav-toggle motif). Its colours are hardcoded: it renders outside the page and cannot see CSS variables. This is the only exception to "tokens only".

## Tokens

| Figma | CSS var | Utilities | Value |
|---|---|---|---|
| color/bg | `--color-bg` | `bg-bg`, `text-bg` | `#000000` |
| color/surface | `--color-surface` | `bg-surface` | `#0f0e12` |
| color/line | `--color-line` | `border-line`, `bg-line` | `#2a292e` |
| color/fg | `--color-fg` | `text-fg`, `bg-fg`, `border-fg` | `#f6f8f7` |
| color/fg-muted | `--color-fg-muted` | `text-fg-muted`, `border-fg-muted`, `bg-fg-muted` | `#b2b2b2` |
| color/link | `--color-link` | `text-link`, `bg-link` | `#3b9ae1` |
| color/warn | `--color-warn` | `text-warn`, `border-warn`, `bg-warn` | `#f0a800` |

| Figma text style | Utilities |
|---|---|
| text/caption | `text-caption font-light` (13/1.5) |
| text/subheading | `text-subheading font-light` (19/1.15) |
| text/heading-sm | `text-heading-sm font-light` (24/1.15) |
| text/heading | `text-heading font-light` (26/1.15) |
| text/display | `text-display font-light` (40/1.11) |
| text/numeral | `text-display font-thin` (40, weight 100) |
| text/code | `font-mono text-caption font-light` |

Spacing values used in the design: 15, 22, 33, 66 plus small gaps 4, 6, 8, 10, 12.

## Layout

```
<body class="h-screen flex flex-col overflow-hidden">
  topbar            h-66 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-22 px-22 border-b border-line
  <div class="flex flex-1 min-h-0">
    aside#setup     shrink-0 overflow-hidden bg-surface, w-320 border-r | w-0
      inner         w-319 h-full p-22 overflow-y-auto
    main            flex-1 min-w-0 p-33 overflow-y-auto
    aside#archive   shrink-0 flex justify-end overflow-hidden bg-surface, w-280 border-l | w-0
      inner         w-279 shrink-0 h-full p-22 overflow-y-auto
  </div>
  live region       sr-only aria-live="polite"
</body>
```

- Panels animate their width: `transition-[width] duration-200 ease-out`, `motion-reduce:transition-none` gives the hard cut. The content has a fixed width inside, so it is clipped, never re-wrapped. Closed panels are `inert` (out of the tab order and the a11y tree). The archive content is anchored to the window edge (`justify-end`): both panels close like a mirrored curtain. The strip in the nav toggle animates with the panel.
- The toggles in the topbar (and the `[` / `]` keys) are the only panel controls.
- Setup panel: form on top, `run evaluation` pinned to the bottom (`flex flex-col justify-between gap-22`). Any input in the form clears `formError`.
- Center content uses `flex flex-col gap-33`. Section = label row + content with `gap-15`.

## Components

Every component below is a Jinja macro in `templates/_components.html` (one macro = one Figma component), unless noted.

### Topbar
Grid `1fr / auto / 1fr`. Left: setup toggle, wordmark button (`lmao` + subtitle, truncates), centre: status, right: archive toggle (`justify-self-end`).

The wordmark is a button: back to the first screen (`goHome()`). A run in progress keeps going: `busy` depends on `run.status` only, so the form and the archive stay locked on every screen.

Status (from existing state only):

| state | status |
|---|---|
| run in progress, any screen | activity dot + `running · 02:31 · 14 / 71` (`tabular-nums`); `back to run` while another screen is shown |
| running screen, run failed | `stopped` (warn) |
| results | run name |
| idle | `connecting…`, `no models found` (warn), otherwise `ollama · N models` (muted) |

### Nav toggle
Macro `ui.nav_toggle(flag, controls, label, side, key)`. Icon 20x20 box with a strip: open = 7px filled strip on the panel side, closed = 1px line; the strip animates (`transition-all duration-200`). The label sits beside the icon: setup `[icon] setup`, archive `archive [icon]`, so both toggles have the same height and centre line. `aria-keyshortcuts` and a title carry the hotkey. Allow ±1px tolerance versus Figma.

### Section label
`ui.section_label(text | text_expr)`
```html
<div class="pb-8 border-b border-line text-fg-muted">02 candidates</div>
```

### Field / select / textarea
`ui.field(label, model, rows, placeholder)`
```html
<label class="flex flex-col gap-8">
  <span class="text-fg-muted">01 judge model</span>
  <input class="w-full bg-bg border border-line px-12 py-10 text-fg placeholder:text-fg-muted focus:border-fg outline-none">
</label>
```
Select (inline in `index.html`): same box, native `<select class="appearance-none ...">` plus a 12px chevron (`stroke="currentColor"`, `text-fg-muted`) at the right.

### Checkbox row
`ui.checkbox_row`. `<label class="group ... text-fg-muted has-checked:text-fg">` with a `sr-only` native input, so keyboard and form behaviour stay native. The box (`size-14 border border-fg-muted`) uses `group-has-checked:bg-fg group-has-checked:border-fg` and `group-has-focus-visible:` for the outline; the check icon is `stroke="currentColor"` + `text-bg`. No `peer`: nested text works. An optional hint line keeps its own `text-fg-muted`. Needs `:has()` (Firefox 121+, Safari 15.4+).

### Buttons
- Primary: `bg-fg text-bg px-22 py-13 w-full` (full width in the setup panel). Disabled: `bg-line text-fg-muted cursor-not-allowed`.
- Secondary: `border border-fg-muted text-fg px-22 py-13`.
- Warn button (inside a warn notice): `border border-warn px-15 py-9`, hover `bg-line`.
- Hover: primary `hover:bg-fg-muted`, secondary `hover:border-fg`.

### Test case block (setup)
Expanded: `border border-line p-15 flex flex-col gap-12` with header row (`case 01` / `collapse` / `remove`). Collapsed: `border border-line px-15 py-12 flex items-center gap-15` (`case 02`, tag, `edit`).

### Warn notice
`ui.warn_notice(show, text, action, action_label)`: `border border-warn px-15 py-12 text-warn`, `role="alert"`, optional action button (`reload`, `back to setup`). Errors only.

### First screen (`view='idle'`)
Centred block, `max-w-560`: `new evaluation` (`text-heading`), one muted line, a checklist of status rows built from the form state by the `checklist` getter, and buttons.
- Rows: `01 judge`, `02 candidates`, `03 test cases`, `04 run evaluation`.
- States: `done`, `queued`, `error` (no models, Ollama unreachable), `ready` (everything filled), `running` (a run is in progress).
- Buttons: `back to run` while a run is in progress, `open setup` while the panel is closed.

### Run step row (status-row)
`ui.status_row(state, label, meta, title_expr)`. Used on the running screen and the first screen.
```html
<div class="flex items-start gap-15 py-10 border-b border-line">
  <div class="w-72 shrink-0 flex items-center gap-8" :class="stateClass(state)">
    activity dot (running only) + state
  </div>
  <div class="flex-1 min-w-0 break-words" :class="isMuted(state) && 'text-fg-muted'">label</div>
  <div class="max-w-320 break-words text-fg-muted tabular-nums">meta</div>
</div>
```
Colours: `done`, `ready` = fg; `running` = link; `queued`, `skipped` = muted; `error` = warn.

### Activity dot
`ui.activity_dot(show)`. Square 8px (zero-radius system): `inline-block size-8 shrink-0 bg-link animate-breathe motion-reduce:animate-none`. Used in the running row, phase segment, topbar status and the load notice. If a round dot is wanted, add `rounded-full` and a `--radius-full` theme key.

### Load notice (under the running row)
Shown only after the row has been `running` for ~8 s, on the first call of a model load group. The backend does not report loading, so the text makes no claim about VRAM. In cloud mode it is relevant only to local candidate rows.
```html
<div class="pl-87 py-10 border-b border-line" x-show="showLoadNotice(s)" x-cloak>
  <div class="bg-surface border border-line p-15 flex flex-col gap-8">
    <div class="flex items-center gap-8">activity dot + the model may still be loading — this is normal</div>
    <p class="text-fg-muted">each model is loaded once at the start of its phase and stays loaded for 10 minutes. a large model can take 10–60 s to load, so the first answer is slow. nothing is frozen.</p>
  </div>
</div>
```
`pl-87` = status column 72 + gap 15, so the box aligns with the row label. The notice has no `aria-live` of its own: it is announced once through the page live region.

### Progress
Grid `grid-cols-[2fr_2fr_2fr_1fr] gap-33`: one segment per phase (`01 reference`, `02 answers`, `03 grading`, `04 summary`), filled from the rows, so phases fill independently (a cloud judge grades while local candidates still answer).
- Segment = button: label row (activity dot + short name, coloured by phase state) and `side` on the right, then an `h-4 bg-line` track with an `h-4 bg-fg` fill (`transition-[width] duration-200`, off with reduced motion).
- `side` = `finished / total`, then the phase duration once done. A single-call phase (summary) has no counter, which is why it is half width.
- Duration = wall clock from the first start to the last done (server timestamps), so parallel calls are not added up. `fmtSpan`: `41.2 s` under a minute, `mm:ss` above.
- `error` and `skipped` rows count as finished; errors are shown as `· N err` (warn).
- Click scrolls to the group of rows (`scrollToPhase`).
- The overall `progressbar` is `sr-only` (assistive tech only).
- There is no separate `running / elapsed` header: elapsed and the step count are in the topbar, `stopped` too.

### Phase group (running)
Header `flex justify-between items-center pb-8 border-b border-line`: title left; once the phase is done, `side · show/hide` right. A finished phase folds into its header; a phase with errors stays open unless folded by hand (`run.expanded`).

### Comparison (`02 comparison`)
Section header row: label on the left, `table` / `chart` tabs on the right.

**Table.** Grid generated from the question count: `model | median | pass | q1…qN | t/s | time, s`. Header cells `text-fg-muted`; median `text-heading-sm`; t/s and time `text-fg-muted`. Cells: `err` (generation error, warn), `?` (judge error, warn), `*` (truncated), muted (question without a reference). Wide matrices scroll horizontally with a sticky model column; `tabular-nums` on rows except the name column.
Under every score: an `h-2 bg-line` track with a `bg-fg` bar of `score%` (`bg-fg-muted` for questions without a reference, empty for errors). Monochrome: rule 4 holds.

**Chart.** Median score (y, fixed 0–100 so runs compare) against median t/s (x, linear, ticks 1/2/5 × 10ⁿ).
- Plot box `h-320 border-l border-b border-line` inside gutters `pt-22 pr-22 pb-55 pl-44` (y ticks left, x ticks and `t/s` below). Everything is HTML positioned in %, labels stay 13px; the only SVG is the Pareto polyline (`vector-effect: non-scaling-stroke`, dashed `stroke-fg-muted`).
- Quadrant "faster and better than the median": `bg-surface`, bounded by dashed median lines. The bound is relative (medians of this run): there is no absolute threshold on the client.
- Median labels sit inside the plot next to their line (flipped near the right edge / the top), so nothing sticks out of the box.
- Points: 8px squares, `bg-fg` = recommended, `border-fg` = others. The label is right of the point (left near the right edge); `text-fg` inside the quadrant, otherwise muted.
- Models without a median score or t/s are listed below as "not plotted".
- The plot has `role="img"` with a text summary; the table tab carries the same data.

### Summary (results)
Verdict (label, short name `text-heading`, rule) → four key figures of the recommended model in hairline columns (`grid grid-cols-4 border-y border-line`; label / `text-display font-thin` value + unit / caption `best of N` or `#r of N · best X`) → `notes` and `judge` rows in a `120px / 1fr` grid with gap 33, the same columns as the eval block. Full model names in the judge text are replaced with the UI short names (`shortenNames`). No recommendation: no figures, the rest stays.

### Eval block (model card and question card)
`ui.eval_block(head, first)`; expects the entry as `e`.
```html
<div class="flex gap-33 py-22" :class="e.error ? 'border border-warn px-22 my-15' : 'border-b border-line'">
  <div class="w-120 shrink-0">
    <div class="text-fg-muted">head</div>
    <div class="text-display font-thin" :class="e.error && 'text-warn'">score or err</div>
    <div :class="e.error ? 'text-warn' : 'text-fg-muted'">/ 100 or evaluation failed</div>
    <div class="text-fg-muted">category</div>
  </div>
  <div class="flex-1 min-w-0 flex flex-col gap-12">
    <div class="text-fg-muted">first line</div>
    notes (muted), comment, answer box
  </div>
</div>
```
In the per-model view `head` is the question label and `first` the question. In the per-question view the left column shows the model short name and the first right line shows `rank 01 / 03` (`not ranked` for failed).

### Card
`border border-line p-22`; header `flex justify-between items-center gap-15 pb-15 border-b border-line` with title `text-subheading`, metrics `text-fg-muted` (`ui.card_head`).

### Answers by category (model card)
Under the card header: `answers by category · n=N`, one row per judge category (always, also 0, so cards compare), then `uncategorised` / `generation error` / `judge error` only when present. Row: `grid-cols-[180px_1fr_80px]`, label, `h-4` bar (`bg-fg`; `bg-warn` only for error rows), `count · pct%`.

### Score scale (per-question card)
Hairline 0–100 with a 1px tick per distinct score (`h-9`; `h-15` when several models share it, names in the tooltip). Below: `0`, `range min–max` (or `one graded answer · N`), `100`.

### View tabs
Macro `ui.tabs(state, [(value, text), …], label)`. Ids: `tab-<state>-<value>`, panel `panel-<state>`. Arrows cycle, Home / End jump (`setTab`, `cycleTab`); the focus follows the active tab.
```html
<div class="flex" role="tablist">
  <button role="tab" :aria-selected="resultsView==='model'" @click="resultsView='model'"
          class="px-15 py-9 border" :class="resultsView==='model' ? 'bg-fg text-bg border-fg' : 'border-line text-fg-muted hover:text-fg'">per model</button>
  …
</div>
```
Used for `02 comparison` (table / chart) and `03 view` (per model / per question), always in the section header row on the right (`flex justify-between items-center pb-8 border-b border-line`).

### Answer box
`ui.answer_box(blocks, raw)`: `bg-surface border border-line`, toolbar right (`raw` toggles the source, `copy` copies the source), then the rendered Markdown. `copy` is shown only in a secure context (`localhost` / https): the Clipboard API does not exist elsewhere. Used for answers and reference answers.

### Markdown
`parseMarkdown()` in `lib.js` → blocks, rendered by `ui.md` with `x-text` only: HTML from a model is shown as text, never executed.
- Blocks: headings (h1–h2 `text-subheading`, others caption `text-fg`), paragraphs and lists `text-fg-muted` (ordered lists keep their numbers), code fences (`bg-bg` inside the surface box, `whitespace-pre`, horizontal scroll, language tag above), tables (hairline cells; the header needs the `|---|` row), `---`.
- Inline: **bold** = `text-fg` (only 100/300 are loaded), `code` = mono `text-fg bg-bg`.
- Not supported (stays text): links, italics, images, HTML, nested lists (flattened).
- A ```` ```markdown ```` wrapper is removed; the judge summary also drops a bare ```` ``` ```` wrapper (`bareFence`).
- Answers are parsed once per run (`WeakMap` cache): both views share the blocks.

### Archive item
`py-15 border-b border-line`; title `text-subheading` (active: `text-fg` with a leading `size-6 bg-fg` marker; otherwise `text-fg-muted`); meta `text-fg-muted` three lines: date, `N models · N qs`, `judge: <full name>`. Disabled while a run is in progress.
Sorted newest first on the client (`sortHistory`): time from the `…_YYYYMMDD_HHMMSS` end of the task id, `timestamp` as the fallback.

### Keyboard
`[` setup, `]` archive, `Esc` first screen. `event.code`, so layout-independent (works on the Ukrainian layout); ignored in inputs and with modifiers.

### Live region
One `sr-only aria-live="polite"` region per page (`announcement`). Announced: the first event of each phase, the load notice (once per row), finish. Errors use `role="alert"` on the warn notice.

## Alpine state

The source of truth is `static/js/lmao.js` (`Alpine.data('lmao')`): panel flags (`setupOpen`, `archiveOpen`), `view` (`idle | running | results`), `resultsView` (`model | question`), `comparisonView` (`table | chart`), the setup form, `names` (display names from `shortNames`), `history`, `run` (rows, progress, timers, folded phases), `report` (everything the results screen shows, built once by `buildReport()` in `lib.js`), `announcement`, `canCopy`.

Getters: `busy` (`run.status === 'running'`), `topStatus`, `checklist`, `phaseProgress`, `pct`, `elapsed`.

- Run start: `setupOpen = false`, `view = 'running'`, rows are built from the payload, `total` is corrected by the first event with `progress`.
- `elapsed`, the row timers and the load notice tick from one `setInterval` (`tick`), cleared on completion or error.
- Panel state is not persisted across reloads.

## SSE event mapping (`/api/stream/<task_id>`)

Every event except `info`, `completed` and `error` carries `phase`, `model`, `question` (`q1`...) and `progress: {done, total}`. Row key: `phase:model:question`; for `reference` the model is the judge, for `summary` the question is `null` (`reference::q1` style, `summary::`).

| Event | UI |
|---|---|
| `reference_start` / `reference_done` | row `reference · q<n>`: `running` / `done` (meta = source) or `error` when `success=false` (no reference, graded without one) |
| `candidate_start` | group marker only (no row, has no question) |
| `answer_start` / `answer_done` | row `<short name> · q<n>`: `running`, then `done` or `error` (meta = error text). On `success=false` the matching grading row becomes `skipped` immediately (the backend sends no grading events for it) |
| `grading_start` / `grading_done` | row `judge · <short name> · q<n>`, same states |
| `summary_start` / `summary_done` | row `final summary` |
| `completed` | `done = total`, fetch `/api/results/<id>`, `view='results'`, refresh archive |
| `error` | `warn` notice, keep panels as they are |
| `info` | not shown in the new design |

Progress comes from `event.progress` (`total = Q*(1+2M)+1`, M = unique candidates). In cloud mode several judge rows can be `running` at once. Close the `EventSource` on the first `onerror`: it would reconnect and replay the stream from the start.

Durations are computed from event `timestamp` fields (ISO) without backend changes. A `*_done` without a start (or with a broken timestamp) gets no duration. A duplicate `*_start` does not reset a running row; a finished row ignores later events.

## Gaps between design and current backend

1. **Load phase is invisible** (`generate()` uses `stream: False`). Done with option (a): one `running` state and a load notice after ~8 s on the first call of a model load group. A real `loading` / `generating` phase needs streaming or `/api/ps` polling.
2. ~~Short model names~~ done: `shortNames()` in `lib.js`.
3. ~~Results API fields~~ done in the backend (`judge_model`, `specific_rationale`, `finished_at`).
4. ~~Per-question view~~ done on the client by transposing `/api/results`.
5. ~~Ranking and averages~~ done on the client.
6. ~~innerHTML safety~~ done: all data goes through `x-text`.
7. ~~Old run files~~ done: `buildReport` throws `ReportFormatError` for files without `questions_results` / `summary.models`; missing fields fall back to `–`.

## Not designed yet

- Disabled and error states beyond the proposals above, run error screen, cancel behaviour (`cancel run` button exists in Figma, no endpoint yet).
- Responsive behaviour. Proposal: below ~1024px panels become overlays (`absolute inset-y-0 z-10`) instead of columns.
- Light theme.
- SSE reconnect. Because the backend replays the stream from the start, a reconnect could reset the rows to `queued` and subscribe again (limited retries, then check `/api/results/<id>`).

## Decisions made while porting

- **Files.** `templates/_theme.html`, `base.html`, `index.html`, `_components.html`; `static/js/lmao.js` (Alpine state, SSE, requests) and `static/js/lib.js` (pure helpers: `shortName`, `shortNames`, `buildSteps`, `parseMarkdown`, `buildReport`, `buildChart`, `competitionRanks`, `sortHistory`; no DOM, can be unit-tested later).
- **Components.** One Jinja macro per Figma component in `_components.html`: `activity_dot`, `section_label`, `md_inline`, `md`, `answer_box`, `warn_notice`, `field`, `checkbox_row`, `status_row`, `card_head`, `eval_block`, `nav_toggle`, `tabs`.
- **Short names.** `shortNames()` builds one map per model set. Colliding short names get the quantisation (`foo · Q4_K_M`), otherwise the full name. The full name stays in `title` attributes and in the archive meta.
- **Matrix.** Per-question scores, median, pass rate, t/s and time. fails / critical / errors / judge errors live in the model card header. Scores have no colour scale.
- **Judge summary.** Markdown is parsed into blocks and rendered with `x-text` (see "Markdown"); bold is shown with `text-fg` because only Inter 100 and 300 are loaded.
- **Wording.** Questions without a reference: "excluded from the scores" everywhere.
- **Running screen.** Rows are built up front as `queued` from the request payload and keyed `phase:model:question`. A failed answer marks its grading row `skipped` (the backend sends no event for it). Rows in flight when the stream breaks become `error` / `interrupted`. The stream is closed on the first `onerror` (no auto-reconnect: the backend replays from the start).
- **Load notice.** Only on the first call of a model load group (first reference, first grading, first answer of each candidate), after ~8 s. No VRAM claims.
- **Per question view.** Ranks use competition ranking (1, 1, 3); failed answers are `not ranked` and listed last. The denominator is the number of models in the question. Truncated answers are ranked by their score and keep the `*`.
- **Additions without a Figma frame.** `collapse` in an expanded test case, cloud judge row, reference field, specific criteria field, `reload` in empty/error states, `back to setup` in the error notice, section numbering `01`–`04` in results, reference answers block, first screen checklist, topbar status and wordmark navigation, phase progress segments and folding, comparison chart and matrix bars, summary figures, answers by category, score scale, Markdown answers with `raw` / `copy`, hotkeys, favicon.
- **Interaction states.** Global `:focus-visible` outline (1px `fg`, offset 2px); hover: archive item `bg-bg`, nav toggles, wordmark subtitle and inactive tabs `text-fg`; primary `bg-fg-muted`, secondary `border-fg`, warn buttons `bg-line`.
- **Not in this PR.** `cancel run` (needs an endpoint: flag in `TASKS`, check between steps in both `_run_local` and `_run_cloud`, `unload` in `finally`), light theme, responsive overlays, SSE reconnect, JS tests (idea: run `buildReport` over `history/` in Node from CI), vendoring Tailwind / Alpine / fonts (see the CDN note below).

### CDN
Tailwind browser build, Alpine and the fonts load from pinned CDN URLs without SRI. Offline machines get an unstyled page. Planned follow-up: vendor them into `static/vendor/` with pinned versions and sha256, or at least add `integrity` and `crossorigin`.