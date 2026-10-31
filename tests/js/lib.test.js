"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const lib = require("../../static/js/lib.js");

// --- names ----------------------------------------------------------------

test("shortName strips hf.co/ and the GGUF quantisation", () => {
    assert.equal(lib.shortName("hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M"), "openbmb/MiniCPM5-2B");
    assert.equal(lib.shortName("llama3:8b"), "llama3:8b");
    assert.equal(lib.shortName(null), "");
});

test("variantOf reads the quantisation or the tag", () => {
    assert.equal(lib.variantOf("x-GGUF:Q4_K_M"), "Q4_K_M");
    assert.equal(lib.variantOf("llama3:8b"), "8b");
    assert.equal(lib.variantOf("llama3"), "latest");
});

test("shortNames keeps unique names and adds the quantisation on a collision", () => {
    assert.deepEqual(
        lib.shortNames(["hf.co/o/m-GGUF:Q4_K_M", "hf.co/o/m-GGUF:Q8_0", "llama3:8b"]),
        {
            "hf.co/o/m-GGUF:Q4_K_M": "o/m · Q4_K_M",
            "hf.co/o/m-GGUF:Q8_0": "o/m · Q8_0",
            "llama3:8b": "llama3:8b",
        },
    );
});

test("shortNames falls back to full names when the quantisation does not help", () => {
    assert.deepEqual(lib.shortNames(["hf.co/o/m-GGUF:Q4_K_M", "o/m-GGUF:Q4_K_M"]), {
        "hf.co/o/m-GGUF:Q4_K_M": "hf.co/o/m-GGUF:Q4_K_M",
        "o/m-GGUF:Q4_K_M": "o/m-GGUF:Q4_K_M",
    });
});

test("shortNames ignores duplicates and non-strings", () => {
    assert.deepEqual(lib.shortNames(["a", "a", null, ""]), { a: "a" });
    assert.deepEqual(lib.shortNames(undefined), {});
});

test("pad2 is one-based", () => {
    assert.equal(lib.pad2(0), "01");
    assert.equal(lib.pad2(11), "12");
});

test("domId gives a stable, valid id and keeps similar names apart", () => {
    const id = lib.domId("answer", "hf.co/o/m-GGUF:Q4_K_M", "q1");

    assert.match(id, /^answer-hf-co-o-m-gguf-q4_k_m-q1-[0-9a-z]+$/);
    assert.equal(lib.domId("answer", "hf.co/o/m-GGUF:Q4_K_M", "q1"), id);
    // same slug, different raw parts
    assert.notEqual(lib.domId("model", "a:b"), lib.domId("model", "a/b"));
    assert.notEqual(lib.domId("answer", "a-b", "c"), lib.domId("answer", "a", "b-c"));
    assert.notEqual(lib.domId("model", "q1"), lib.domId("question", "q1"));
    assert.match(lib.domId("model", null), /^model-[0-9a-z]+$/);
});

// --- running screen -------------------------------------------------------

test("stepKey has the same shape as the SSE fields", () => {
    assert.equal(lib.stepKey("answer", "m", "q1"), "answer:m:q1");
    assert.equal(lib.stepKey("reference", null, "q1"), "reference::q1");
    assert.equal(lib.stepKey("summary", "j", null), "summary:j:");
});

test("totalSteps matches the backend formula", () => {
    assert.equal(lib.totalSteps(1, 2), 6);
    assert.equal(lib.totalSteps(2, 3), 15);
});

test("buildSteps lists every row up front, once per unique candidate, grading model by model", () => {
    const steps = lib.buildSteps("j", ["a", "a", "b"], 2);

    assert.equal(steps.length, lib.totalSteps(2, 2));
    assert.deepEqual(
        steps.map((s) => s.key),
        [
            "reference:j:q1",
            "reference:j:q2",
            "answer:a:q1",
            "answer:a:q2",
            "answer:b:q1",
            "answer:b:q2",
            "grading:a:q1",
            "grading:a:q2",
            "grading:b:q1",
            "grading:b:q2",
            "summary:j:",
        ],
    );
    assert.ok(steps.every((s) => s.state === "queued"));
    assert.equal(steps[0].label, "reference q1");
    assert.equal(steps[2].label, "a · q1");
    assert.equal(steps[6].label, "judge · a · q1");
    assert.equal(steps[10].label, "final summary");
});

test("buildSteps shows short names", () => {
    const steps = lib.buildSteps("j", ["hf.co/o/m-GGUF:Q4"], 1);

    assert.equal(steps[1].label, "o/m · q1");
});

test("loadGroup tells which model has to be loaded", () => {
    assert.equal(lib.loadGroup("answer", "m", false), "cand:m");
    assert.equal(lib.loadGroup("answer", "m", true), "cand:m");
    assert.equal(lib.loadGroup("reference", "j", false), "judge-1");
    assert.equal(lib.loadGroup("grading", "j", false), "judge-2");
    assert.equal(lib.loadGroup("summary", "j", false), "judge-2");
    assert.equal(lib.loadGroup("reference", "j", true), null);
    assert.equal(lib.loadGroup("grading", "j", true), null);
});

// --- model groups ---------------------------------------------------------

function setRow(steps, key, fields) {
    Object.assign(steps.find((s) => s.key === key), fields);
}

test("modelGroups splits a phase by model in row order, flat for the judge phases", () => {
    const steps = lib.buildSteps("j", ["a", "b"], 2);

    assert.deepEqual(
        lib.modelGroups(steps, "grading").map((g) => [g.model, g.total]),
        [
            ["a", 2],
            ["b", 2],
        ],
    );
    assert.deepEqual(
        lib.modelGroups(steps, "reference").map((g) => [g.model, g.total]),
        [["j", 2]],
    );
    assert.equal(lib.modelGroups(steps, "summary").length, 1);
});

test("modelGroups: a queued group", () => {
    const [a] = lib.modelGroups(lib.buildSteps("j", ["a"], 2), "answer");

    assert.equal(a.state, "queued");
    assert.equal(a.side, "0/2");
});

test("modelGroups: a group in progress stays running between two rows", () => {
    const steps = lib.buildSteps("j", ["a"], 3);
    setRow(steps, "answer:a:q1", { state: "done" });
    setRow(steps, "answer:a:q2", { state: "running" });
    const [running] = lib.modelGroups(steps, "answer");

    assert.equal(running.state, "running");
    assert.equal(running.side, "1/3");

    setRow(steps, "answer:a:q2", { state: "done" });
    const [between] = lib.modelGroups(steps, "answer");

    assert.equal(between.state, "running");
    assert.equal(between.side, "2/3");
});

test("modelGroups: a finished group shows successes, errors and the duration", () => {
    const steps = lib.buildSteps("j", ["a"], 3);
    setRow(steps, "answer:a:q1", { state: "done", startTs: 1000, endTs: 20000 });
    setRow(steps, "answer:a:q2", { state: "error", startTs: 20000, endTs: 30000 });
    setRow(steps, "answer:a:q3", { state: "done", startTs: 30000, endTs: 52300 });
    const [a] = lib.modelGroups(steps, "answer");

    assert.equal(a.state, "done");
    assert.equal(a.ok, 2);
    assert.equal(a.errors, 1);
    assert.equal(a.side, "2/3 · 51.3 s");
});

test("modelGroups: skipped grading rows count as finished and are reported apart", () => {
    const steps = lib.buildSteps("j", ["a"], 2);
    setRow(steps, "grading:a:q1", { state: "done" });
    setRow(steps, "grading:a:q2", { state: "skipped" });
    const [a] = lib.modelGroups(steps, "grading");

    assert.equal(a.state, "done");
    assert.equal(a.skipped, 1);
    assert.equal(a.side, "1/2");
});

test("modelGroups: no duration without server timestamps", () => {
    const steps = lib.buildSteps("j", ["a"], 1);
    setRow(steps, "answer:a:q1", { state: "done" });

    assert.equal(lib.modelGroups(steps, "answer")[0].side, "1/1");
});

test("fmtSeconds is empty for broken durations", () => {
    assert.equal(lib.fmtSeconds(1.234), "1.2 s");
    assert.equal(lib.fmtSeconds(0), "0.0 s");
    assert.equal(lib.fmtSeconds(NaN), "");
    assert.equal(lib.fmtSeconds(-1), "");
    assert.equal(lib.fmtSeconds("x"), "");
});

test("fmtClock and fmtSpan", () => {
    assert.equal(lib.fmtClock(151), "02:31");
    assert.equal(lib.fmtClock(-5), "00:00");
    assert.equal(lib.fmtSpan(41.2), "41.2 s");
    assert.equal(lib.fmtSpan(312), "05:12");
    assert.equal(lib.fmtSpan(NaN), "");
});

// --- numbers --------------------------------------------------------------

test("clampScore keeps scores in 0..100 and rejects non-numbers", () => {
    assert.equal(lib.clampScore(150), 100);
    assert.equal(lib.clampScore(-5), 0);
    assert.equal(lib.clampScore(50), 50);
    assert.equal(lib.clampScore("x"), null);
    assert.equal(lib.clampScore(NaN), null);
});

test("fmtNum shows a dash for missing values", () => {
    assert.equal(lib.fmtNum(null), "–");
    assert.equal(lib.fmtNum(undefined), "–");
    assert.equal(lib.fmtNum(0), "0");
});

test("median and round1", () => {
    assert.equal(lib.median([3, 1, 2]), 2);
    assert.equal(lib.median([1, 2, 3, 4]), 2.5);
    assert.equal(lib.median([]), null);
    assert.equal(lib.round1(1.26), 1.3);
    assert.equal(lib.round1(1.24), 1.2);
});

test("niceStep gives 1 / 2 / 5 times a power of ten", () => {
    assert.equal(lib.niceStep(100, 4), 50);
    assert.equal(lib.niceStep(8, 4), 2);
    assert.equal(lib.niceStep(1000, 4), 500);
});

test("competitionRanks shares ranks and skips failed answers", () => {
    assert.deepEqual(lib.competitionRanks([90, 90, 70, null]), [1, 1, 3, null]);
});

// --- markdown -------------------------------------------------------------

test("parseInline splits bold and code", () => {
    const parts = lib.parseInline("a `b` **c** d");

    assert.deepEqual(
        parts.map((p) => [p.text, p.bold, p.code]),
        [
            ["a ", false, false],
            ["b", false, true],
            [" ", false, false],
            ["c", true, false],
            [" d", false, false],
        ],
    );
});

test("parseMarkdown: heading, paragraph, CRLF", () => {
    const blocks = lib.parseMarkdown("# Title\r\n\r\ntext one\r\ntext two");

    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[0].inlines[0].text, "Title");
    assert.equal(blocks[1].type, "paragraph");
    assert.equal(blocks[1].inlines[0].text, "text one text two");
});

test("parseMarkdown: lists", () => {
    const [bullets] = lib.parseMarkdown("- a\n- b");
    const [ordered] = lib.parseMarkdown("3. x\n4. y");

    assert.equal(bullets.type, "list");
    assert.equal(bullets.ordered, false);
    assert.equal(bullets.items.length, 2);
    assert.equal(ordered.ordered, true);
    assert.equal(ordered.start, 3);
    assert.equal(lib.parseMarkdown("- a\n1. b").length, 2);
});

test("parseMarkdown: code fences", () => {
    assert.deepEqual(lib.parseMarkdown("```js\nconst a = 1;\n```"), [
        { type: "code", lang: "js", text: "const a = 1;" },
    ]);
    assert.deepEqual(lib.parseMarkdown("```\ncode"), [{ type: "code", lang: "", text: "code" }]);
});

test("parseMarkdown unwraps a markdown fence, and a bare one only on request", () => {
    assert.equal(lib.parseMarkdown("```markdown\n# T\n```")[0].type, "heading");
    assert.equal(lib.parseMarkdown("```\n# T\n```")[0].type, "code");
    assert.equal(lib.parseMarkdown("```\n# T\n```", { bareFence: true })[0].type, "heading");
});

test("parseMarkdown: tables with and without a header", () => {
    const [withHead] = lib.parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    const [noHead] = lib.parseMarkdown("| 1 | 2 |\n| 3 | 4 |");

    assert.equal(withHead.type, "table");
    assert.equal(withHead.head.length, 2);
    assert.equal(withHead.head[0][0].text, "a");
    assert.equal(withHead.rows.length, 1);
    assert.deepEqual(noHead.head, []);
    assert.equal(noHead.rows.length, 2);
});

test("parseMarkdown: rule and empty input", () => {
    assert.deepEqual(lib.parseMarkdown("---"), [{ type: "rule" }]);
    assert.deepEqual(lib.parseMarkdown(null), []);
});

test("parseMarkdown keeps HTML as text", () => {
    const [block] = lib.parseMarkdown("<script>alert(1)</script>");

    assert.equal(block.type, "paragraph");
    assert.equal(block.inlines[0].text, "<script>alert(1)</script>");
});

test("answerBlocks parses an answer once", () => {
    const result = { answer: "**x**" };

    assert.equal(lib.answerBlocks(result), lib.answerBlocks(result));
});

test("shortenNames replaces the longest name first", () => {
    const blocks = lib.parseMarkdown("m-long and m");

    lib.shortenNames(blocks, { m: "x", "m-long": "y" });

    assert.equal(blocks[0].inlines[0].text, "y and x");
});

// --- results --------------------------------------------------------------

test("questionLabel adds the tag unless it repeats the id", () => {
    assert.equal(lib.questionLabel({ id: "q1" }), "q1");
    assert.equal(lib.questionLabel({ id: "q1", tag: "Python" }), "q1 · Python");
    assert.equal(lib.questionLabel({ id: "q2", tag: "Q2" }), "q2");
});

test("isFailed covers generation and judge errors", () => {
    assert.equal(lib.isFailed({ status: "generation_error" }), true);
    assert.equal(lib.isFailed({ status: "judge_error" }), true);
    assert.equal(lib.isFailed({ status: "truncated" }), false);
});

test("matrixCell for errors, truncated answers and questions without a reference", () => {
    const question = { no_reference: false };

    assert.equal(lib.matrixCell(question, { status: "generation_error", error: "oom" }).text, "err");
    assert.equal(lib.matrixCell(question, { status: "judge_error" }).text, "?");
    assert.deepEqual(lib.matrixCell(question, { status: "ok", score: 95, truncated: false }), {
        text: "95",
        warn: false,
        muted: false,
        title: "",
        bar: 95,
    });
    assert.equal(lib.matrixCell(question, { status: "truncated", score: 95, truncated: true }).text, "95*");

    const muted = lib.matrixCell({ no_reference: true }, { status: "ok", score: 80, truncated: false });
    assert.equal(muted.muted, true);
    assert.equal(muted.title, "no reference: excluded from the scores");
});

test("buildDistribution always lists the five categories", () => {
    const empty = lib.buildDistribution([]);
    assert.equal(empty.n, 0);
    assert.equal(empty.rows.length, 5);

    const { n, rows } = lib.buildDistribution([
        { status: "ok", category: "perfect" },
        { status: "ok", category: "perfect" },
        { status: "ok", category: "garbage" },
        { status: "ok", category: "unknown" },
        { status: "generation_error" },
        { status: "judge_error" },
    ]);

    assert.equal(n, 6);
    assert.deepEqual(rows[0], {
        label: "perfect solution",
        count: 2,
        warn: false,
        pct: 33,
        text: "2 · 33%",
    });
    assert.deepEqual(
        rows.slice(5).map((r) => [r.label, r.warn]),
        [
            ["uncategorised", false],
            ["generation error", true],
            ["judge error", true],
        ],
    );
});

test("runTime reads the task id, falls back to the timestamp, then to 0", () => {
    assert.equal(lib.runTime({ task_id: "run_a_20260101_120000" }), new Date(2026, 0, 1, 12, 0, 0).getTime());
    assert.ok(lib.runTime({ task_id: "weird", timestamp: "2026-01-03T12:00:00" }) > 0);
    assert.equal(lib.runTime({ task_id: "weird", timestamp: "Unknown" }), 0);
    assert.equal(lib.runTime(null), 0);
});

test("sortHistory is newest first and does not mutate its input", () => {
    const runs = [
        { task_id: "run_a_20260101_000000" },
        { task_id: "run_a_20260102_000000" },
        { task_id: "weird", timestamp: "Unknown" },
    ];

    assert.deepEqual(
        lib.sortHistory(runs).map((r) => r.task_id),
        ["run_a_20260102_000000", "run_a_20260101_000000", "weird"],
    );
    assert.equal(runs[0].task_id, "run_a_20260101_000000");
    assert.deepEqual(lib.sortHistory("not a list"), []);
});

// --- chart and figures ----------------------------------------------------

const CHART_MODELS = [
    { model: "a", mean: 90, median_cps: 50 },
    { model: "b", mean: 60, median_cps: 100 },
    { model: "c", mean: null, median_cps: 10 },
];

test("buildChart plots models with a mean and t/s and lists the rest", () => {
    const chart = lib.buildChart(CHART_MODELS, (m) => m, "a");

    assert.deepEqual(
        chart.points.map((p) => [p.model, p.best, p.top]),
        [
            ["a", true, 10],
            ["b", false, 40],
        ],
    );
    assert.deepEqual(chart.missing, ["c"]);
    assert.deepEqual(
        chart.xTicks.map((t) => t.text),
        ["0", "50", "100", "150"],
    );
    assert.deepEqual(
        chart.yTicks.map((t) => t.text),
        ["0", "25", "50", "75", "100"],
    );
    assert.equal(chart.mid.cpsText, "median 75 c/s");
    assert.equal(chart.mid.scoreText, "median 75");
    assert.equal(chart.points[0].title, "a: mean score 90 · 50 c/s");
});

test("buildChart draws the Pareto line through models nobody beats on both axes", () => {
    const chart = lib.buildChart(CHART_MODELS, (m) => m, "a");
    const [first, second] = chart.pareto.split(" ");

    assert.ok(first.endsWith(",10"));
    assert.ok(second.endsWith(",40"));
});

test("buildChart without plottable models", () => {
    const chart = lib.buildChart([{ model: "c", mean: null, median_cps: 10 }], (m) => m, null);

    assert.deepEqual(chart.points, []);
    assert.deepEqual(chart.missing, ["c"]);
    assert.equal(chart.mid, null);
    assert.equal(chart.pareto, "");
});

const FIGURE_MODELS = [
    { model: "a", mean: 90, pass_rate: 1, median_cps: 50, median_time_sec: 3 },
    { model: "b", mean: 60, pass_rate: 0.5, median_cps: 100, median_time_sec: 2 },
];

test("rankOf ranks a model among all that have a value", () => {
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "a", "mean", true), { rank: 1, n: 2, best: 90 });
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "b", "mean", true), { rank: 2, n: 2, best: 90 });
    assert.deepEqual(lib.rankOf(FIGURE_MODELS, "a", "median_time_sec", false), { rank: 2, n: 2, best: 2 });
    assert.equal(lib.rankOf(FIGURE_MODELS, "a", "missing", true), null);
});

test("verdictFigures gives four figures with their place in the run", () => {
    const figures = lib.verdictFigures(FIGURE_MODELS, "a");

    assert.deepEqual(
        figures.map((f) => [f.label, f.value, f.unit, f.caption]),
        [
            ["mean score", "90", "/ 100", "best of 2"],
            ["pass rate", "100", "%", "best of 2"],
            ["speed", "50", "c/s", "#2 of 2 · best 100"],
            ["median time", "3", "s", "#2 of 2 · best 2 s"],
        ],
    );
    assert.deepEqual(lib.verdictFigures(FIGURE_MODELS, "nope"), []);
    assert.equal(lib.verdictFigures([FIGURE_MODELS[0]], "a")[0].caption, "only model");
});

// --- buildReport ----------------------------------------------------------

function runFixture() {
    return {
        schema_version: 2,
        judge_model: "j",
        mode: "local",
        judge_is_candidate: false,
        finished_at: "2026-01-01T12:00:30",
        questions_results: [
            {
                id: "q1",
                tag: "logic",
                question: "2+2?",
                no_reference: false,
                reference: { text: "Four.", source: "generated" },
                results: [
                    {
                        model_name: "a",
                        answer: "4",
                        status: "ok",
                        category: "perfect",
                        score: 95,
                        comment: "ok",
                        truncated: false,
                        error: null,
                        tps: 50,
                        time_sec: 1,
                    },
                    {
                        model_name: "b",
                        answer: "",
                        status: "generation_error",
                        category: null,
                        score: null,
                        comment: "",
                        truncated: false,
                        error: "oom",
                        tps: null,
                        time_sec: null,
                    },
                ],
            },
        ],
        summary: {
            models: [
                {
                    model: "a",
                    n: 1,
                    mean: 95,
                    median: 95,
                    pass_rate: 1,
                    fails: 0,
                    critical_fails: 0,
                    errors: 0,
                    judge_errors: 0,
                    median_tps: 50,
                    median_cps: 250,
                    median_time_sec: 1,
                },
                {
                    model: "b",
                    n: 1,
                    mean: 0,
                    median: 0,
                    pass_rate: 0,
                    fails: 0,
                    critical_fails: 1,
                    errors: 1,
                    judge_errors: 0,
                    median_tps: null,
                    median_cps: null,
                    median_time_sec: null,
                },
            ],
            recommendation: { model: "a", rule: "fastest_above_threshold", confidence: "low" },
            text: "## Summary\n\nA wins.",
        },
        metrics: { a: { total_time_sec: 2.5 } },
    };
}

test("buildReport rejects files in an older format", () => {
    assert.throws(() => lib.buildReport({ questions_results: [] }), lib.ReportFormatError);
    assert.throws(() => lib.buildReport(null), lib.ReportFormatError);
});

test("buildReport: header, verdict and notes", () => {
    const report = lib.buildReport(runFixture());

    assert.equal(report.meta, "finished 2026-01-01 12:00 · judge: j · local judge");
    assert.equal(report.verdict.model, "a");
    assert.equal(report.verdict.label, "recommended");
    assert.equal(report.verdict.rule, "the fastest model among those with a high pass rate");
    assert.equal(report.verdict.figures.length, 4);
    assert.deepEqual(report.notes, ["low confidence: too few graded questions."]);
    assert.equal(report.summaryBlocks[0].type, "heading");
});

test("buildReport: model rows", () => {
    const [a, b] = lib.buildReport(runFixture()).models;

    assert.equal(a.mean, "95");
    assert.equal(a.median, "95");
    assert.equal(a.passRate, "100%");
    assert.equal(
        a.metricsLine,
        "mean 95 · median 95 · pass 100% · fails 0 · critical 0 · errors 0 · judge errors 0 · 250 c/s · 50 t/s · 2.5 s total",
    );
    assert.equal(a.cps, "250");
    assert.equal(b.cps, "–");
    assert.equal(b.tps, "–");
    assert.equal(b.median, "0");
    assert.equal(b.cells[0].text, "err");
    assert.equal(b.cells[0].warn, true);
    assert.equal(b.entries[0].error, true);
    assert.equal(b.entries[0].scoreText, "err");
    assert.equal(b.entries[0].caption, "generation failed");
    assert.equal(b.entries[0].comment, "oom");
});

test("buildReport: question cards rank answers and put failures last", () => {
    const [card] = lib.buildReport(runFixture()).questionCards;

    assert.equal(card.metricsLine, "2 models · generated reference");
    assert.deepEqual(
        card.entries.map((e) => [e.model, e.rankText]),
        [
            ["a", "rank 01 / 02"],
            ["b", "not ranked"],
        ],
    );
    assert.deepEqual(card.marks, [{ score: 95, many: false, title: "95: a" }]);
    assert.equal(card.spread, "one graded answer · 95");
});

test("buildReport: table grid, heads, references and chart", () => {
    const report = lib.buildReport(runFixture());

    assert.equal(
        report.grid,
        "grid-template-columns:minmax(160px,1fr) 64px 64px 64px repeat(1,48px) 64px 64px 64px",
    );
    assert.deepEqual(report.questionHeads, [
        { id: "q1", title: "logic", anchor: lib.domId("question", "q1") },
    ]);
    assert.equal(report.references[0].title, "q1 · logic · generated");
    assert.equal(report.chart.points.length, 1);
    assert.deepEqual(report.chart.missing, ["b"]);
});

test("buildReport: anchors link the comparison table to the 03 cards", () => {
    const report = lib.buildReport(runFixture());
    const [a, b] = report.models;
    const [card] = report.questionCards;
    const answerA = lib.domId("answer", "a", "q1");

    assert.equal(a.anchor, lib.domId("model", "a"));
    assert.equal(card.anchor, report.questionHeads[0].anchor);
    // a cell, its per-model block and its per-question block share one id
    assert.equal(a.cells[0].anchor, answerA);
    assert.equal(a.entries[0].anchor, answerA);
    assert.equal(card.entries.find((e) => e.model === "a").anchor, answerA);
    // a failed cell still points to its eval block
    assert.equal(b.cells[0].anchor, lib.domId("answer", "b", "q1"));

    // a model without a result for the question: nothing to jump to
    const data = runFixture();
    data.questions_results[0].results.pop();
    assert.equal(lib.buildReport(data).models[1].cells[0].anchor, null);
});

test("buildReport: notes for a judge that is a candidate and for missing references", () => {
    const data = runFixture();
    data.judge_is_candidate = true;
    data.questions_results[0].no_reference = true;

    const { notes } = lib.buildReport(data);

    assert.deepEqual(notes, [
        "the judge is also a candidate: its own score may be biased.",
        "1 question(s) have no reference answer: excluded from the scores.",
        "low confidence: too few graded questions.",
    ]);
});

test("buildReport: no recommendation and a cloud judge", () => {
    const data = runFixture();
    data.mode = "cloud";
    data.summary.recommendation = { model: null, rule: "none_graded", confidence: "low" };

    const report = lib.buildReport(data);

    assert.equal(report.verdict.label, "no recommendation");
    assert.equal(report.verdict.short, "");
    assert.deepEqual(report.verdict.figures, []);
    assert.equal(report.verdict.rule, "no answers could be graded");
    assert.deepEqual(report.notes, []);
    assert.ok(report.meta.endsWith("cloud judge"));
});

// --- test cases file ------------------------------------------------------

const FORM_STATE = {
    baseRationale: " Be strict. ",
    cases: [
        { id: 1, tag: " python ", question: " What is 2+2? ", rationale: "Must say 4.", reference: "Four.", open: false },
        { id: 2, tag: "", question: "Q2", rationale: "", reference: "", open: true },
        { id: 3, tag: "x", question: "   ", rationale: "", reference: "", open: true },
    ],
};

function rejects(text, message) {
    assert.throws(
        () => lib.parseCasesFile(text),
        (e) => e instanceof lib.CasesFileError && e.message === message,
    );
}

function fileOf(testCases, extra = {}) {
    return JSON.stringify({ version: 1, test_cases: testCases, ...extra });
}

test("payloadCase trims, maps rationale and leaves out empty optional fields", () => {
    assert.deepEqual(lib.payloadCase(FORM_STATE.cases[0]), {
        tag: "python",
        question: "What is 2+2?",
        specific_rationale: "Must say 4.",
        reference: "Four.",
    });
    assert.deepEqual(lib.payloadCase(FORM_STATE.cases[1]), { question: "Q2" });
});

test("isBlankCase is true only when nothing is typed", () => {
    assert.equal(lib.isBlankCase({ tag: "", question: " ", rationale: "", reference: "" }), true);
    assert.equal(lib.isBlankCase({ tag: "", question: "", rationale: "", reference: "r" }), false);
});

test("buildCasesFile writes the payload shape and skips cases without a question", () => {
    const text = lib.buildCasesFile(FORM_STATE);

    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text), {
        version: 1,
        base_rationale: "Be strict.",
        test_cases: [
            {
                tag: "python",
                question: "What is 2+2?",
                specific_rationale: "Must say 4.",
                reference: "Four.",
            },
            { question: "Q2" },
        ],
    });
});

test("a built file imports back into the same payload cases", () => {
    const parsed = lib.parseCasesFile(lib.buildCasesFile(FORM_STATE));

    assert.equal(parsed.baseRationale, "Be strict.");
    assert.deepEqual(
        parsed.cases.map((raw) => lib.payloadCase(lib.caseFields(raw))),
        FORM_STATE.cases.slice(0, 2).map(lib.payloadCase),
    );
});

test("imported cases take the shape the backend accepts", () => {
    const allowed = new Set(["tag", "question", "specific_rationale", "reference"]);
    const text = fileOf([{ question: "Q", tag: "t", unknown: 1, id: 7, open: true }], { extra: 1 });

    const { cases } = lib.parseCasesFile(text);
    const [payload] = cases.map((raw) => lib.payloadCase(lib.caseFields(raw)));

    assert.deepEqual(payload, { tag: "t", question: "Q" });
    assert.ok(Object.keys(payload).every((key) => allowed.has(key)));
    assert.equal(typeof payload.question, "string");
    assert.ok(payload.question.trim());
});

test("parseCasesFile fills missing optional fields and treats null as missing", () => {
    const { baseRationale, cases } = lib.parseCasesFile(fileOf([{ question: "Q", reference: null }]));

    assert.equal(baseRationale, "");
    assert.deepEqual(cases, [{ question: "Q", tag: "", specific_rationale: "", reference: "" }]);
});

test("parseCasesFile tolerates a BOM and accepts exactly the maximum number of cases", () => {
    const many = Array.from({ length: lib.CASES_MAX_COUNT }, (_, i) => ({ question: `Q${i}` }));

    assert.equal(lib.parseCasesFile(`\uFEFF${fileOf([{ question: "Q" }])}`).cases.length, 1);
    assert.equal(lib.parseCasesFile(fileOf(many)).cases.length, lib.CASES_MAX_COUNT);
});

test("parseCasesFile rejects files that are not valid", () => {
    rejects("{not json", "the file is not valid JSON.");
    rejects("[]", "the file must contain a JSON object.");
    rejects("null", "the file must contain a JSON object.");
    rejects(JSON.stringify({ test_cases: [{ question: "Q" }] }), "unsupported file version: expected 1.");
    rejects(JSON.stringify({ version: 2, test_cases: [{ question: "Q" }] }), "unsupported file version: expected 1.");
    rejects(fileOf([{ question: "Q" }], { base_rationale: 5 }), '"base_rationale" must be a string.');
    rejects(fileOf([]), "the file has no test cases.");
    rejects(JSON.stringify({ version: 1, test_cases: "Q" }), "the file has no test cases.");
});

test("parseCasesFile names the case that is wrong", () => {
    rejects(fileOf([{ question: "a" }, { question: "b" }, { question: "  " }]), "case 03: the question is empty.");
    rejects(fileOf([{ tag: "x" }]), 'case 01: "question" must be a string.');
    rejects(fileOf([{ question: "a" }, "text"]), "case 02: must be an object.");
    rejects(fileOf([{ question: "a" }, { question: "b", tag: 5 }]), 'case 02: "tag" must be a string.');
    rejects(fileOf([{ question: "a", reference: [] }]), 'case 01: "reference" must be a string.');
});

test("parseCasesFile limits the number of cases and the size in bytes", () => {
    const many = Array.from({ length: lib.CASES_MAX_COUNT + 1 }, () => ({ question: "Q" }));

    rejects(fileOf(many), "too many test cases (max 200).");
    rejects("x".repeat(lib.CASES_MAX_BYTES + 1), lib.CASES_TOO_LARGE);
    // fewer characters than the limit, but more bytes
    rejects("я".repeat(lib.CASES_MAX_BYTES / 2 + 1), lib.CASES_TOO_LARGE);
});