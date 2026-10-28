// Alpine state of the whole page. Registered on 'alpine:init'; this file is
// deferred before Alpine itself (see templates/base.html).
document.addEventListener("alpine:init", () => {
    let caseCounter = 0;
    let openToken = 0; // ignores a late response of a superseded results request

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
        steps: [],
        done: 0,
        total: 0,
        startedAt: null,
        elapsed: 0,
    });

    Alpine.data("lmao", () => ({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results
        resultsView: "model", // model | question

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

        get pct() {
            return this.run.total
                ? Math.round((100 * this.run.done) / this.run.total)
                : 0;
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
            if (this.view === "running") return;
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

        // --- run ------------------------------------------------------------

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
            if (this.formError) return;

            this.submitting = true;
            try {
                const response = await fetch("/api/evaluate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(this.buildPayload()),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `request failed (${response.status})`);
                }
                this.run = { ...freshRun(), id: data.task_id, startedAt: Date.now() };
                this.activeRunId = data.task_id;
                this.view = "running"; // the progress screen arrives in step 4
            } catch (e) {
                this.formError = e.message;
            } finally {
                this.submitting = false;
            }
        },
    }));
});
