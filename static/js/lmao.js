// Alpine state of the whole page. Registered on 'alpine:init'; this file is
// deferred before Alpine itself (see templates/base.html).
document.addEventListener("alpine:init", () => {
    let caseCounter = 0;
    let openToken = 0; // ignores a late response of a superseded results request
    // Not reactive on purpose: one run at a time.
    let source = null; // EventSource
    let timer = null; // setInterval id

    const SLOW_LOAD_MS = 8000;

    const newCase = () => ({
        id: ++caseCounter,
        tag: "",
        question: "",
        rationale: "",
        reference: "",
        open: true,
    });

    const freshRun = () => ({
        id: null,
        status: "idle", // idle | running | done | error
        steps: [],
        pos: {}, // step key -> index in `steps` (a lookup through the proxy stays reactive)
        seen: {}, // load groups and phases that already had a first call
        cloud: false,
        done: 0,
        total: 0,
        startedAt: null,
        endedAt: null,
        now: 0,
        error: "",
        expanded: {}, // phase -> true/false, set by the user; default: folded when done without errors
    });

    Alpine.data("lmao", () => ({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results
        resultsView: "model", // model | question
        comparisonView: "table", // table | chart

        // `short` is the label of the progress segment (a quarter of the width).
        phaseGroups: [
            { phase: "reference", title: "01 reference answers", short: "01 reference" },
            { phase: "answer", title: "02 candidate answers", short: "02 answers" },
            { phase: "grading", title: "03 grading", short: "03 grading" },
            { phase: "summary", title: "04 summary", short: "04 summary" },
        ],

        models: [],
        names: {}, // full model name -> display name (see shortNames)
        modelsLoaded: false,
        judge: "",
        judgeCloud: false,
        selected: [],
        baseRationale: "",
        cases: [newCase()],
        formError: "",
        submitting: false,

        history: [],
        historyLoaded: false,
        historyError: "",
        activeRunId: null,
        resultsError: "",
        run: freshRun(),
        results: null,
        report: null,

        announcement: "", // text of the page live region
        // Clipboard API exists only in a secure context (localhost / https).
        canCopy: Boolean(window.isSecureContext && navigator.clipboard),
        init() {
            this.loadModels();
            this.loadHistory();
        },

        // A run is in progress: the form and the archive are locked, on every
        // screen (the wordmark can lead away from the running screen).
        get busy() {
            return this.run.status === "running";
        },

        get runTitle() {
            const run = this.history.find((r) => r.task_id === this.activeRunId);
            return run ? run.tag_name : this.activeRunId;
        },

        get pct() {
            return this.run.total
                ? Math.round((100 * this.run.done) / this.run.total)
                : 0;
        },

        get elapsed() {
            if (!this.run.startedAt) return 0;
            return Math.max(0, ((this.run.endedAt ?? this.run.now) - this.run.startedAt) / 1000);
        },

        // Centre of the topbar. Built from the existing state only.
        // `go`: the run is in progress but another screen is shown.
        get topStatus() {
            if (this.run.status === "running") {
                return {
                    tone: "text-fg",
                    dot: true,
                    go: this.view !== "running",
                    text: `running · ${fmtClock(this.elapsed)} · ${this.run.done} / ${this.run.total}`,
                };
            }
            if (this.view === "running" && this.run.status === "error") {
                return { tone: "text-warn", dot: false, go: false, text: "stopped" };
            }
            if (this.view === "results") {
                return { tone: "text-fg", dot: false, go: false, text: this.runTitle || "" };
            }
            if (!this.modelsLoaded) {
                return { tone: "text-fg-muted", dot: false, go: false, text: "connecting…" };
            }
            if (this.models.length === 0) {
                return { tone: "text-warn", dot: false, go: false, text: "no models found" };
            }
            const n = this.models.length;
            return {
                tone: "text-fg-muted",
                dot: false,
                go: false,
                text: `ollama · ${n} model${n === 1 ? "" : "s"}`,
            };
        },

        // One segment per phase, filled from the rows themselves: phases fill
        // independently (a cloud judge grades while local candidates still answer).
        // error and skipped rows are finished too; errors are counted separately.
        get phaseProgress() {
            return this.phaseGroups.map((g) => this.phaseStats(g));
        },

        // Duration = wall clock from the first start to the last done (server
        // timestamps), so parallel calls are not added up.
        phaseStats(g) {
            let total = 0;
            let open = 0; // queued or running
            let running = 0;
            let errors = 0;
            let first = Infinity;
            let last = -Infinity;
            for (const s of this.run.steps) {
                if (s.phase !== g.phase) continue;
                total += 1;
                if (s.state === "queued" || s.state === "running") open += 1;
                if (s.state === "running") running += 1;
                if (s.state === "error") errors += 1;
                if (s.startTs !== null) first = Math.min(first, s.startTs);
                if (s.endTs !== null) last = Math.max(last, s.endTs);
            }
            const finished = total - open;
            let state = "queued";
            if (running) state = "running";
            else if (total && !open) state = "done";

            const span =
                state === "done" && Number.isFinite(first) && Number.isFinite(last)
                    ? fmtSpan((last - first) / 1000)
                    : "";
            // A single-call phase (summary) needs no counter.
            const count = total > 1 ? `${finished} / ${total}` : "";
            return {
                ...g,
                total,
                finished,
                errors,
                state,
                side: [count, span].filter(Boolean).join(" · "),
                pct: total ? Math.round((100 * finished) / total) : 0,
            };
        },

        phaseOf(phase) {
            return this.phaseStats(this.phaseGroups.find((g) => g.phase === phase));
        },

        // A finished phase folds into its header. Phases with errors stay open
        // unless the user folds them.
        isCollapsed(phase) {
            const p = this.phaseOf(phase);
            if (p.state !== "done") return false;
            return !(this.run.expanded[phase] ?? p.errors > 0);
        },

        togglePhase(phase) {
            this.run.expanded[phase] = this.isCollapsed(phase);
        },

        // First screen: the state of the form as status rows.
        get checklist() {
            let judge;
            if (!this.modelsLoaded) judge = { state: "queued", meta: "loading models…" };
            else if (this.models.length === 0) judge = { state: "error", meta: "no models. is ollama running?" };
            else if (this.judge) {
                judge = {
                    state: "done",
                    meta: this.label(this.judge) + (this.judgeCloud ? " · cloud" : ""),
                };
            } else judge = { state: "queued", meta: "not selected" };

            const picked = this.selected.length;
            const candidates = picked
                ? { state: "done", meta: `${picked} selected` }
                : { state: "queued", meta: "none selected" };

            const ready = this.cases.filter((c) => c.question.trim()).length;
            const cases =
                ready === this.cases.length
                    ? { state: "done", meta: `${ready} ready` }
                    : { state: "queued", meta: `${ready} of ${this.cases.length} ready` };

            const all = [judge, candidates, cases].every((r) => r.state === "done");
            let runRow = { state: all ? "ready" : "", meta: all ? "press run evaluation" : "" };
            if (this.busy) {
                runRow = { state: "running", meta: `${this.run.done} / ${this.run.total} steps` };
            }
            return [
                { key: "judge", label: "01 judge", ...judge },
                { key: "candidates", label: "02 candidates", ...candidates },
                { key: "cases", label: "03 test cases", ...cases },
                { key: "run", label: "04 run evaluation", ...runRow },
            ];
        },

        label(model) {
            return this.names[model] || shortName(model);
        },

        // Clears first, so the same text can be announced twice.
        announce(text) {
            this.announcement = "";
            setTimeout(() => {
                this.announcement = text;
            }, 50);
        },

        // --- models ---------------------------------------------------------

        async loadModels() {
            this.modelsLoaded = false;
            try {
                const response = await fetch("/api/models");
                const data = await response.json();
                this.models = Array.isArray(data.models) ? data.models : [];
            } catch (e) {
                console.error("Failed to load models:", e);
                this.models = [];
            }
            this.names = shortNames(this.models);
            this.modelsLoaded = true;
            // Let x-for render the <option>s before the value is set.
            await this.$nextTick();
            if (!this.models.includes(this.judge)) {
                this.judge = this.models[0] ?? "";
            }
            this.selected = this.selected.filter((m) => this.models.includes(m));
        },

        // --- archive --------------------------------------------------------

        async loadHistory() {
            try {
                const response = await fetch("/api/history");
                if (!response.ok) throw new Error(`request failed (${response.status})`);
                this.history = sortHistory(await response.json());
                this.historyError = "";
            } catch (e) {
                console.error("Failed to load history:", e);
                this.historyError = "failed to load the archive.";
            }
            this.historyLoaded = true;
        },

        // Opens a saved run. Disabled while a run is in progress: the running
        // screen would be lost.
        async openRun(id) {
            if (this.busy) return;
            const token = ++openToken;
            this.activeRunId = id;
            this.view = "results";
            if (this.$refs?.main) this.$refs.main.scrollTop = 0;
            this.results = null;
            this.report = null;
            this.resultsError = "";
            try {
                const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
                const data = await response.json().catch(() => ({}));
                if (token !== openToken) return;
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                let report;
                try {
                    report = buildReport(data);
                } catch (e) {
                    console.error("Cannot build the report:", e);
                    // TypeError: a field is missing or has another type -> the file.
                    // Anything else (ReferenceError...) is a bug in the UI, not the file.
                    let message = "the report could not be built: a bug in the UI, see the browser console.";
                    if (e instanceof ReportFormatError) message = e.message;
                    else if (e instanceof TypeError) message = "this run cannot be shown: the file has an unexpected format.";
                    throw new Error(message);
                }
                this.report = report;
                this.results = data;
            } catch (e) {
                console.error("Failed to open run:", e);
                if (token === openToken) this.resultsError = e.message;
            }
        },

        // --- test cases -----------------------------------------------------

        addCase() {
            // Collapse the finished ones, never one that is still empty.
            this.cases.forEach((c) => {
                if (c.question.trim()) c.open = false;
            });
            this.cases.push(newCase());
        },

        removeCase(id) {
            if (this.cases.length > 1) {
                this.cases = this.cases.filter((c) => c.id !== id);
            }
        },

        // --- start ----------------------------------------------------------

        validate() {
            if (!this.judge) {
                return "choose a judge model.";
            }
            if (this.selected.length === 0) {
                return "select at least one candidate.";
            }
            const index = this.cases.findIndex((c) => !c.question.trim());
            if (index !== -1) {
                this.cases[index].open = true;
                return `case ${pad2(index)}: the question is empty.`;
            }
            return "";
        },

        // Empty optional fields are left out: the backend would keep an empty
        // tag as the tag instead of using its default.
        buildPayload() {
            const optional = (key, value) => {
                const text = value.trim();
                return text ? { [key]: text } : {};
            };
            return {
                judge: this.judge,
                judge_cloud: this.judgeCloud,
                candidates: [...this.selected],
                base_rationale: this.baseRationale.trim(),
                test_cases: this.cases.map((c) => ({
                    question: c.question.trim(),
                    ...optional("tag", c.tag),
                    ...optional("specific_rationale", c.rationale),
                    ...optional("reference", c.reference),
                })),
            };
        },

        async submit() {
            this.formError = this.validate();
            if (this.formError || this.busy) return;

            const payload = this.buildPayload();
            this.submitting = true;
            try {
                const response = await fetch("/api/evaluate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.startRun(data.task_id, payload);
            } catch (e) {
                this.formError = e.message;
            } finally {
                this.submitting = false;
            }
        },

        // --- running --------------------------------------------------------

        startRun(taskId, payload) {
            this.stopStream();
            const steps = buildSteps(
                payload.judge,
                payload.candidates,
                payload.test_cases.length,
                this.names,
                payload.judge_cloud,
            );
            const pos = {};
            steps.forEach((step, index) => (pos[step.key] = index));
            const now = Date.now();

            this.run = {
                ...freshRun(),
                id: taskId,
                status: "running",
                steps,
                pos,
                cloud: payload.judge_cloud,
                // Corrected by the first event that carries `progress`.
                total: totalSteps(payload.test_cases.length, new Set(payload.candidates).size),
                startedAt: now,
                now,
            };
            this.activeRunId = taskId;
            this.setupOpen = false;
            this.view = "running";

            timer = setInterval(() => this.tick(), 1000);

            source = new EventSource(`/api/stream/${encodeURIComponent(taskId)}`);
            source.onmessage = (event) => this.onMessage(event);
            // EventSource would reconnect and the backend replays the stream
            // from the start, which would duplicate the rows: stop at the first error.
            source.onerror = () => {
                if (this.run.status !== "running") return;
                this.failRun(
                    "connection to the server was lost. the run may still finish: check the archive.",
                );
            };
        },

        // One clock for the elapsed time, the row timers and the load notice.
        tick() {
            this.run.now = Date.now();
            for (const step of this.run.steps) {
                if (step.loading && !step.announced && this.showLoadNotice(step)) {
                    step.announced = true;
                    this.announce("the model may still be loading. this is normal.");
                }
            }
        },

        stopStream() {
            if (source) source.close();
            source = null;
            if (timer) clearInterval(timer);
            timer = null;
        },

        step(event) {
            const index = this.run.pos[stepKey(event.phase, event.model, event.question)];
            return index === undefined ? null : this.run.steps[index];
        },

        onMessage(message) {
            let event;
            try {
                event = JSON.parse(message.data);
            } catch (e) {
                console.error("Bad SSE payload:", e);
                return;
            }

            if (event.progress) {
                this.run.total = event.progress.total;
                this.run.done = Math.max(this.run.done, event.progress.done);
            }

            if (event.type === "completed") return this.finishRun();
            if (event.type === "error") {
                return this.failRun(event.message || "the evaluation failed.");
            }

            const match = /^([a-z]+)_(start|done)$/.exec(event.type || "");
            // `info` is not shown; `candidate_start` has no question and is only a group marker.
            if (!match || match[1] === "candidate") return;

            const step = this.step(event);
            if (!step) return;
            if (match[2] === "start") this.stepStarted(step, event);
            else this.stepDone(step, event);
        },

        stepStarted(step, event) {
            // A duplicate start must not reset the timer of a row in flight.
            if (step.state !== "queued") return;
            step.state = "running";
            step.startedAt = Date.now();
            const ts = Date.parse(event.timestamp);
            step.startTs = Number.isFinite(ts) ? ts : null;

            const phaseKey = `phase:${step.phase}`;
            if (!this.run.seen[phaseKey]) {
                this.run.seen[phaseKey] = true;
                const group = this.phaseGroups.find((g) => g.phase === step.phase);
                if (group) this.announce(`${group.title.replace(/^\d+\s+/, "")} started`);
            }

            const loadKey = loadGroup(step.phase, step.model, this.run.cloud);
            if (loadKey && !this.run.seen[loadKey]) {
                this.run.seen[loadKey] = true;
                step.loading = true;
            }
        },

        stepDone(step, event) {
            // Finished rows stay as they are (duplicates, events after `skipped`).
            if (step.state !== "running" && step.state !== "queued") return;

            // Both timestamps come from the server, so its time zone cancels out.
            // No start event (or a broken timestamp): no duration instead of nonsense.
            const end = Date.parse(event.timestamp);
            const sec =
                step.startTs !== null && Number.isFinite(end) ? (end - step.startTs) / 1000 : NaN;
            const duration = fmtSeconds(sec);
            step.endTs = Number.isFinite(end) ? end : null;

            if (event.success) {
                step.state = "done";
                if (step.phase === "reference") {
                    step.meta =
                        event.source === "generated" && duration
                            ? `generated · ${duration}`
                            : event.source || "";
                } else {
                    step.meta = duration;
                }
            } else {
                step.state = "error";
                step.meta =
                    step.phase === "reference"
                        ? "no reference: graded without one"
                        : event.error || "failed";
            }

            // The backend sends no grading events for a failed answer.
            if (step.phase === "answer" && !event.success) {
                const index = this.run.pos[stepKey("grading", step.model, step.question)];
                if (index !== undefined) {
                    this.run.steps[index].state = "skipped";
                    this.run.steps[index].meta = "not graded";
                }
            }
        },

        finishRun() {
            this.run.done = this.run.total; // `completed` may come without `progress`
            this.run.status = "done";
            this.run.endedAt = Date.now();
            this.stopStream();
            this.announce("evaluation finished. opening the results.");
            this.loadHistory();
            this.openRun(this.run.id);
        },

        failRun(message) {
            // Rows that were in flight will never finish: stop their animation.
            this.run.steps.forEach((step) => {
                if (step.state === "running") {
                    step.state = "error";
                    step.meta = "interrupted";
                }
            });
            this.run.status = "error";
            this.run.error = message; // announced by the role="alert" notice
            this.run.endedAt = Date.now();
            this.stopStream();
        },

        // Back to the form: after an error the setup panel may still be closed.
        dismissRun() {
            this.view = "idle";
            this.setupOpen = true;
        },

        // Wordmark: back to the first screen. A run in progress keeps going;
        // the topbar status and the first screen lead back to it.
        goHome() {
            this.view = "idle";
            if (!this.busy) this.activeRunId = null;
            if (this.$refs?.main) this.$refs.main.scrollTop = 0;
        },

        showRun() {
            this.view = "running";
            this.activeRunId = this.run.id;
        },

        // Progress segment -> its group of rows.
        scrollToPhase(phase) {
            const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            document
                .getElementById(`phase-${phase}`)
                ?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
        },

        async copyText(text) {
            try {
                await navigator.clipboard.writeText(String(text ?? ""));
                return true;
            } catch (e) {
                console.error("Copy failed:", e);
                return false;
            }
        },

        // [ and ] toggle the panels, Esc goes to the first screen.
        // event.code: the same physical keys on any layout (х / ї in Ukrainian).
        // Ignored while typing and with modifiers.
        hotkey(event) {
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
                return;
            }
            if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;

            if (event.code === "BracketLeft") this.setupOpen = !this.setupOpen;
            else if (event.code === "BracketRight") this.archiveOpen = !this.archiveOpen;
            else if (event.code === "Escape" && this.view !== "idle") this.goHome();
            else return;
            event.preventDefault();
        },

        // Tabs (ui.tabs): `key` is the state property, ids are tab-<key>-<value>.
        setTab(key, value) {
            this[key] = value;
            this.$nextTick(() => document.getElementById(`tab-${key}-${value}`)?.focus());
        },

        // `list`: comma-separated values in tab order; `step`: +1 / -1, wraps around.
        cycleTab(key, list, step) {
            const values = list.split(",");
            const index = values.indexOf(this[key]);
            this.setTab(key, values[(index + step + values.length) % values.length]);
        },

        // --- row helpers ----------------------------------------------------

        stateClass(state) {
            return (
                {
                    done: "text-fg",
                    ready: "text-fg",
                    running: "text-link",
                    queued: "text-fg-muted",
                    skipped: "text-fg-muted",
                    error: "text-warn",
                }[state] || "text-fg-muted"
            );
        },

        isMuted(state) {
            return state === "queued" || state === "skipped" || !state;
        },

        rowMeta(step) {
            if (step.state === "running" && step.startedAt) {
                // run.now ticks once a second and can be behind startedAt.
                return fmtSeconds(Math.max(0, this.run.now - step.startedAt) / 1000);
            }
            return step.meta;
        },

        showLoadNotice(step) {
            return (
                step.state === "running" &&
                step.loading &&
                this.run.now - step.startedAt > SLOW_LOAD_MS
            );
        },
    }));
});