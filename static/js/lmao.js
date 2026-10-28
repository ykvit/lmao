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
        seen: {}, // load groups that already had a first call
        cloud: false,
        done: 0,
        total: 0,
        startedAt: null,
        endedAt: null,
        now: 0,
        error: "",
    });

    Alpine.data("lmao", () => ({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results
        resultsView: "model", // model | question

        phaseGroups: [
            { phase: "reference", title: "01 reference answers" },
            { phase: "answer", title: "02 candidate answers" },
            { phase: "grading", title: "03 grading" },
            { phase: "summary", title: "04 summary" },
        ],

        models: [],
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

        init() {
            this.loadModels();
            this.loadHistory();
        },

        // A run is in progress: the form and the archive are locked.
        get busy() {
            return this.view === "running" && this.run.status === "running";
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
                this.history = await response.json();
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
            this.results = null;
            this.resultsError = "";
            try {
                const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
                const data = await response.json().catch(() => ({}));
                if (token !== openToken) return;
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.results = data;
            } catch (e) {
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

            timer = setInterval(() => {
                this.run.now = Date.now();
            }, 1000);

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
            step.state = "running";
            step.startedAt = Date.now();
            step.startTs = Date.parse(event.timestamp);

            const group = loadGroup(step.phase, step.model, this.run.cloud);
            if (group && !this.run.seen[group]) {
                this.run.seen[group] = true;
                step.loading = true;
            }
        },

        stepDone(step, event) {
            // Both timestamps come from the server, so its time zone cancels out.
            const sec = (Date.parse(event.timestamp) - step.startTs) / 1000;
            const duration = fmtSeconds(sec);

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
            this.run.status = "done";
            this.run.endedAt = Date.now();
            this.stopStream();
            this.loadHistory();
            this.openRun(this.run.id);
        },

        failRun(message) {
            this.run.status = "error";
            this.run.error = message;
            this.run.endedAt = Date.now();
            this.stopStream();
        },

        dismissRun() {
            this.view = "idle";
        },

        // --- row helpers ----------------------------------------------------

        stateClass(state) {
            return (
                {
                    done: "text-fg",
                    running: "text-link",
                    queued: "text-fg-muted",
                    skipped: "text-fg-muted",
                    error: "text-warn",
                }[state] || "text-fg-muted"
            );
        },

        rowMeta(step) {
            if (step.state === "running" && step.startedAt) {
                return fmtSeconds((this.run.now - step.startedAt) / 1000);
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
