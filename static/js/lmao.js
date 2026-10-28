// Alpine state of the whole page. Registered on 'alpine:init'; this file is
// deferred before Alpine itself (see templates/base.html).
document.addEventListener("alpine:init", () => {
    Alpine.data("lmao", () => ({
        setupOpen: true,
        archiveOpen: true,

        view: "idle", // idle | running | results
        resultsView: "model", // model | question

        models: [],
        judge: "",
        judgeCloud: false,
        selected: [],
        baseRationale: "",
        cases: [
            { tag: "", question: "", rationale: "", reference: "", open: true },
        ],

        history: [],
        activeRunId: null,
        run: { id: null, steps: [], done: 0, total: 0, startedAt: null, elapsed: 0 },
        results: null,

        get pct() {
            return this.run.total
                ? Math.round((100 * this.run.done) / this.run.total)
                : 0;
        },
    }));
});
