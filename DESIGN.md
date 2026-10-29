# lmao — UI design handoff

Strict, utilitarian, engineering-style interface in the spirit of teenage engineering. Pure black theme. Stack: Flask templates + Tailwind CSS v4 (browser build, no build step) + Alpine.js.

## Source of truth

- Variables collection `tokens` has `WEB` code syntax (`var(--color-*)`)
- Light theme: **not designed yet**. Tokens are the only thing that must change when it is added.

| Figma frame | Node | Alpine state | setup | archive |
|---|---|---|---|---|
| 01 start | `11:2` | `view='idle'` | open | open |
| 02 running | `11:120` | `view='running'` | **closed** (auto on run start) | open |
| 03 results | `17:108` | `view='results'`, `resultsView='model'` | open | open |
| 04 results | `17:308` | same | closed | open |
| 05 results | `17:447` | same | open | closed |
| 06 results (focus) | `17:625` | same | closed | closed |
| 07 per question | `34:238` | `resultsView='question'` | open | open |

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
3. Structure comes from 1px hairlines (`border-line`), not fills. The only elevation device is `bg-surface` (panels, code boxes).
4. Color is rationed: neutrals + `link` (running state, dot) + `warn` (errors only). Scores are plain numbers, no green/yellow/red scale.
5. Text is always left-aligned. Min text size 13px.

## Setup

`templates/_theme.html` is a head partial: fonts, `@tailwindcss/browser@4.3.2`, theme tokens, Alpine `3.14.9`. Include it in `base.html` inside `<head>`.

Notes:
- `--spacing: 1px`, so `p-22` = 22px, `gap-15` = 15px, `w-320` = 320px, `h-66` = 66px. Tailwind doc examples such as `p-4` become 4px.
- Tailwind's browser build compiles in the client: expect a short unstyled flash and runtime cost. Fine for a local tool; use `x-cloak` for Alpine blocks.
- Theme `@theme` must live in an inline `<style type="text/tailwindcss">`; the browser build does not load an external theme file.

## Tokens

| Figma | CSS var | Utilities | Value |
|---|---|---|---|
| color/bg | `--color-bg` | `bg-bg`, `text-bg` | `#000000` |
| color/surface | `--color-surface` | `bg-surface` | `#0f0e12` |
| color/line | `--color-line` | `border-line`, `bg-line` | `#2a292e` |
| color/fg | `--color-fg` | `text-fg`, `bg-fg`, `border-fg` | `#f6f8f7` |
| color/fg-muted | `--color-fg-muted` | `text-fg-muted`, `border-fg-muted` | `#b2b2b2` |
| color/link | `--color-link` | `text-link`, `bg-link` | `#3b9ae1` |
| color/warn | `--color-warn` | `text-warn`, `border-warn` | `#f0a800` |

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
  topbar            h-66 shrink-0 border-b border-line
  <div class="flex flex-1 min-h-0">
    aside#setup     w-320 shrink-0 bg-surface border-r border-line p-22 overflow-y-auto
    main            flex-1 min-w-0 p-33 overflow-y-auto
    aside#archive   w-280 shrink-0 bg-surface border-l border-line p-22 overflow-y-auto
  </div>
</body>
```

- Panels collapse with `x-show` (no width animation; the system favours hard cuts). The toggles in the topbar are the only controls.
- Setup panel: form on top, `run evaluation` pinned to the bottom (`flex flex-col justify-between gap-22`).
- Center content uses `flex flex-col gap-33`. Section = label row + content with `gap-15`.

## Components

### Topbar
```html
<header class="h-66 shrink-0 flex items-center justify-between px-22 border-b border-line">
  <div class="flex items-center gap-33">
    <!-- nav toggle (left) -->
    <div class="flex items-center gap-15">
      <span class="text-heading-sm">lmao</span>
      <span class="text-fg-muted">local model assessment operator</span>
    </div>
  </div>
  <!-- nav toggle (right) -->
</header>
```

### Nav toggle
Icon 20x20 box with a strip: open = 7px filled strip on the panel side, closed = 1px line.
```html
<button type="button" @click="setupOpen = !setupOpen" :aria-expanded="setupOpen" aria-controls="setup"
        class="flex flex-col items-center gap-6" :class="setupOpen ? 'text-fg' : 'text-fg-muted'">
  <span class="relative block size-20 border border-fg">
    <span class="absolute -top-px -bottom-px bg-fg" :class="setupOpen ? '-left-px w-7' : 'left-6 w-px'"></span>
  </span>
  setup
</button>
```
Right-side toggle mirrors with `-right-px` / `right-6`. Allow ±1px tolerance versus Figma.

### Section label
```html
<div class="pb-8 border-b border-line text-fg-muted">02 candidates</div>
```

### Field / select / textarea
```html
<label class="flex flex-col gap-8">
  <span class="text-fg-muted">01 judge model</span>
  <input class="w-full bg-bg border border-line px-12 py-10 text-fg focus:border-fg outline-none">
</label>
```
Select: same box, native `<select class="appearance-none ...">` plus a 12px chevron (stroke `#b2b2b2`) at the right, `gap-10`.

### Checkbox row
`flex items-center gap-12 py-11 border-b border-line`; box `size-14 border border-fg-muted`, checked `bg-fg border-fg` with a black 1px check; text `text-fg` when checked, otherwise `text-fg-muted`. Use a visually hidden native input (`peer`) so keyboard and form behaviour stay native.

### Buttons
- Primary: `bg-fg text-bg px-22 py-13 w-full` (full width in the setup panel). Disabled: `bg-line text-fg-muted cursor-not-allowed`.
- Secondary: `border border-fg-muted text-fg px-22 py-13`.
- Hover (not in Figma, proposal): primary `hover:bg-fg-muted`, secondary `hover:border-fg`.

### Test case block (setup)
Expanded: `border border-line p-15 flex flex-col gap-12` with header row (`case 01` / `remove`). Collapsed: `border border-line px-15 py-12 flex items-center gap-15` (`case 02`, tag, `edit`).

### Run step row (status-row)
```html
<div class="flex items-start gap-15 py-10 border-b border-line">
  <div class="w-72 shrink-0 flex items-center gap-8"
       :class="{'text-fg':s.state==='done','text-link':s.state==='running','text-fg-muted':s.state==='queued','text-warn':s.state==='error'}">
    <span x-show="s.state==='running'" aria-hidden="true"
          class="size-8 bg-link animate-breathe motion-reduce:animate-none"></span>
    <span x-text="s.state"></span>
  </div>
  <div class="flex-1 min-w-0" :class="s.state==='queued' && 'text-fg-muted'" x-text="s.label"></div>
  <div class="text-fg-muted" x-text="s.meta"></div>
</div>
```

### Activity dot
Square 8px (zero-radius system). Standalone: `<span class="inline-block size-8 bg-link animate-breathe motion-reduce:animate-none" aria-hidden="true"></span>`. Used in the running row, next to `elapsed`, and in the load notice. If a round dot is wanted, add `rounded-full` and a `--radius-full` theme key.

### Load notice (under the running row)
Shown only after the row has been `running` for ~8 s. The backend does not report loading, so the text makes no claim about VRAM. In cloud mode it is relevant only to local candidate rows.
```html
<div class="pl-87 py-10 border-b border-line" x-show="slowLoad" x-cloak aria-live="polite">
  <div class="bg-surface border border-line p-15 flex flex-col gap-8">
    <div class="flex items-center gap-8"><span class="size-8 bg-link animate-breathe motion-reduce:animate-none"></span>the model may still be loading — this is normal</div>
    <p class="text-fg-muted">each model is loaded once at the start of its phase and stays loaded for 10 minutes. a large model can take 10–60 s to load, so the first answer is slow. nothing is frozen.</p>
  </div>
</div>
```
`pl-87` = status column 72 + gap 15, so the box aligns with the row label.

### Progress
```html
<div role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" class="h-4 bg-line">
  <div class="h-4 bg-fg" :style="`width:${pct}%`"></div>
</div>
```

### Comparison matrix
Row: `grid grid-cols-[33px_1fr_repeat(6,64px)] items-center gap-x-15 py-12 border-b border-line`. Header cells `text-fg-muted`; avg cell `text-heading-sm`; failed cell `text-warn` with text `err`; t/s, tokens, time `text-fg-muted`.

### Eval block (model card and question card)
```html
<div class="flex gap-33 py-22" :class="ev.error ? 'border border-warn px-22' : 'border-b border-line'">
  <div class="w-120 shrink-0">
    <div class="text-fg-muted" x-text="ev.tag"></div>
    <div class="text-display font-thin" :class="ev.error && 'text-warn'" x-text="ev.error ? 'err' : ev.score"></div>
    <div :class="ev.error ? 'text-warn' : 'text-fg-muted'" x-text="ev.error ? 'evaluation failed' : '/ 100'"></div>
  </div>
  <div class="flex-1 min-w-0 flex flex-col gap-12">
    <div class="text-fg-muted" x-text="ev.question"></div>
    <div :class="ev.error && 'text-warn'" x-text="ev.comment"></div>
    <pre class="bg-surface border border-line p-15 font-mono font-light whitespace-pre-wrap" x-text="ev.answer"></pre>
  </div>
</div>
```
In the per-question view the left column shows the model short name and the first right line shows `rank 01 / 03` (`not ranked` for failed).

### Card
`border border-line p-22`; header `flex justify-between items-center pb-15 border-b border-line` with title `text-subheading`, metrics `text-fg-muted`.

### View tabs (per model / per question)
```html
<div class="flex" role="tablist">
  <button role="tab" :aria-selected="resultsView==='model'" @click="resultsView='model'"
          class="px-15 py-9 border" :class="resultsView==='model' ? 'bg-fg text-bg border-fg' : 'border-line text-fg-muted'">per model</button>
  <button role="tab" :aria-selected="resultsView==='question'" @click="resultsView='question'"
          class="px-15 py-9 border" :class="resultsView==='question' ? 'bg-fg text-bg border-fg' : 'border-line text-fg-muted'">per question</button>
</div>
```
Placed in the section header row: label `view` on the left, tabs on the right (`flex justify-between items-center pb-8 border-b border-line`).

### Archive item
`py-15 border-b border-line`; title `text-subheading` (active: `text-fg` with a leading `size-6 bg-fg` marker; otherwise `text-fg-muted`); meta `text-fg-muted` three lines: date, `N models · N qs`, `judge: <full name>`.

## Alpine state

The source of truth is `static/js/lmao.js` (`Alpine.data('lmao')`): panel flags (`setupOpen`, `archiveOpen`), `view` (`idle | running | results`), `resultsView` (`model | question`), the setup form, `history`, `run` (rows, progress, timers) and `report` (everything the results screen shows, built once by `buildReport()` in `lib.js`).

- Run start: `setupOpen = false`, `view = 'running'`, rows are built from the payload, `total` is corrected by the first event with `progress`.
- `elapsed` and the row timers tick from one `setInterval`, cleared on completion or error.
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
| `completed` | fetch `/api/results/<id>`, `view='results'`, refresh archive |
| `error` | `warn` notice, keep panels as they are |
| `info` | not shown in the new design |

Progress comes from `event.progress` (`total = Q*(1+2M)+1`, M = unique candidates). In cloud mode several judge rows can be `running` at once. Close the `EventSource` on the first `onerror`: it would reconnect and replay the stream from the start.

Durations can be computed from event `timestamp` fields (ISO) without backend changes.

## Gaps between design and current backend

1. **Load phase is invisible** (`generate()` uses `stream: False`). Done with option (a): one `running` state and a load notice after ~8 s on the first call of a model load group. A real `loading` / `generating` phase needs streaming or `/api/ps` polling.
2. ~~Short model names~~ done: `shortName()` in `lib.js`.
3. ~~Results API fields~~ done in the backend (`judge_model`, `specific_rationale`, `finished_at`).
4. ~~Per-question view~~ done on the client by transposing `/api/results`.
5. ~~Ranking and averages~~ done on the client.
6. ~~innerHTML safety~~ done: all data goes through `x-text`.

## Not designed yet

- Hover, focus and disabled states (proposals above), empty archive text, run error screen, cancel behaviour (`cancel run` button exists in Figma, no endpoint yet).
- Responsive behaviour. Proposal: below ~1024px panels become overlays (`absolute inset-y-0 z-10`) instead of columns.
- Light theme.
- Panel animation (current proposal: none).

## Decisions made while porting

- **Files.** `templates/_theme.html`, `base.html`, `index.html`; `static/js/lmao.js` (Alpine state, SSE, requests) and `static/js/lib.js` (pure helpers: `shortName`, `buildSteps`, `parseMarkdown`, `buildReport`, `competitionRanks`; no DOM, can be unit-tested later).
- **Matrix.** Per-question scores, median, pass rate, t/s and time. fails / critical / errors / judge errors live in the model card header. Cells: `err` (generation error), `?` (judge error), `*` (truncated), muted (question without a reference). Scores have no colour scale. Wide matrices scroll horizontally with a sticky model column; the grid template is generated from the question count.
- **Judge summary.** Markdown is parsed into blocks (`#` headings, `-` lists, paragraphs, `**bold**`) and rendered with `x-text`; bold is shown with `text-fg` because only Inter 100 and 300 are loaded.
- **Running screen.** Rows are built up front as `queued` from the request payload and keyed `phase:model:question`. A failed answer marks its grading row `skipped` (the backend sends no event for it). Rows in flight when the stream breaks become `error` / `interrupted`. The stream is closed on the first `onerror` (no auto-reconnect: the backend replays from the start).
- **Load notice.** Only on the first call of a model load group (first reference, first grading, first answer of each candidate), after ~8 s. No VRAM claims.
- **Per question view.** Ranks use competition ranking (1, 1, 3); failed answers are `not ranked` and listed last. The denominator is the number of models in the question. Truncated answers are ranked by their score and keep the `*`.
- **Additions without a Figma frame.** `collapse` in an expanded test case, cloud judge row, reference field, specific criteria field, `reload` in empty/error states, `back to setup` in the error notice, section numbering `01`–`04` in results, reference answers block.
- **Interaction states.** Global `:focus-visible` outline (1px `fg`, offset 2px); hover: archive item `bg-bg`, nav toggles and inactive tabs `text-fg`; primary `bg-fg-muted`, secondary `border-fg`.
- **Not in this PR.** `cancel run` (needs an endpoint: flag in `TASKS`, check between steps in both `_run_local` and `_run_cloud`, `unload` in `finally`), light theme, responsive overlays, panel animation, JS tests, vendoring Tailwind / Alpine / fonts (see the CDN note below).

### CDN
Tailwind browser build, Alpine and the fonts load from pinned CDN URLs without SRI. Offline machines get an unstyled page. Planned follow-up: vendor them into `static/vendor/` with pinned versions and sha256, or at least add `integrity` and `crossorigin`.
