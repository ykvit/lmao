// Pure helpers. No DOM, no Alpine, so they can be unit-tested later.

// 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M' -> 'openbmb/MiniCPM5-2B'
// The full name stays in `title` attributes and in the archive meta.
function shortName(name) {
    if (typeof name !== "string") return "";
    return name.replace(/^hf\.co\//, "").replace(/-GGUF:[^:\s]+$/i, "");
}

// 0 -> '01', 11 -> '12'
function pad2(index) {
    return String(index + 1).padStart(2, "0");
}

// --- running screen -------------------------------------------------------

// Same key on both sides: built from the SSE event fields (phase, model, question).
// reference: model = judge; summary: question = null.
function stepKey(phase, model, question) {
    return `${phase}:${model ?? ""}:${question ?? ""}`;
}

// Total steps as the backend counts them: Q * (1 + 2M) + 1 (M = unique candidates).
function totalSteps(questionCount, candidateCount) {
    return questionCount * (1 + 2 * candidateCount) + 1;
}

// All rows of a run in the `queued` state, built from the request payload.
function buildSteps(judge, candidates, questionCount) {
    const ids = Array.from({ length: questionCount }, (_, i) => `q${i + 1}`);
    const unique = [...new Set(candidates)];
    const row = (phase, model, question, label) => ({
        key: stepKey(phase, model, question),
        phase,
        model,
        question,
        label,
        state: "queued", // queued | running | done | error | skipped
        meta: "",
        startedAt: null, // client clock, for the live timer
        startTs: null, // server timestamp, for the final duration
        loading: false, // first call of a model load group: the load notice may apply
    });

    const steps = [];
    ids.forEach((q) => steps.push(row("reference", judge, q, `reference ${q}`)));
    unique.forEach((m) =>
        ids.forEach((q) => steps.push(row("answer", m, q, `${shortName(m)} · ${q}`))),
    );
    // Local mode grades question by question.
    ids.forEach((q) =>
        unique.forEach((m) =>
            steps.push(row("grading", m, q, `judge · ${shortName(m)} · ${q}`)),
        ),
    );
    steps.push(row("summary", judge, null, "final summary"));
    return steps;
}

// The model that has to be loaded for a step, or null when it is not local.
// Judge: loaded once for the references, once for grading + summary.
function loadGroup(phase, model, cloud) {
    if (phase === "answer") return `cand:${model}`;
    if (cloud) return null;
    return phase === "reference" ? "judge-1" : "judge-2";
}

function fmtSeconds(sec) {
    return typeof sec === "number" && isFinite(sec) ? `${sec.toFixed(1)} s` : "";
}

// 151 -> '02:31'
function fmtClock(sec) {
    const total = Math.max(0, Math.floor(sec));
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

// --- results --------------------------------------------------------------

// UI labels for the stable ids stored in the results.
const RULE_LABELS = {
    fastest_above_threshold: "the fastest model among those with a high pass rate",
    highest_median: "the highest median score (no model reached the pass-rate threshold)",
    none_graded: "no answers could be graded",
};
const CATEGORY_LABELS = {
    perfect: "perfect solution",
    acceptable: "generally acceptable",
    instruction_violation: "violation of instructions",
    broken_logic: "broken logic",
    garbage: "garbage",
};

function fmtNum(value) {
    return value === null || value === undefined ? "–" : String(value);
}

// 'Markdown' of the judge summary -> blocks. Nothing here touches the DOM:
// the template renders the blocks with x-text, so no HTML is ever injected.
// Supported: # headings, - lists, paragraphs, **bold**. Everything else stays text.
function parseInline(text) {
    const parts = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
        if (match.index > last) parts.push({ text: text.slice(last, match.index), bold: false });
        parts.push({ text: match[1], bold: true });
        last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold: false });
    return parts;
}

function parseMarkdown(text) {
    const blocks = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list) {
            blocks.push({ type: "list", items: list });
            list = null;
        }
    };

    for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
        const line = raw.trim();
        if (/^```/.test(line)) continue; // models sometimes wrap the answer in ```markdown
        if (!line) {
            flushParagraph();
            flushList();
            continue;
        }
        let match;
        if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
            flushParagraph();
            flushList();
            blocks.push({ type: "heading", inlines: parseInline(match[2]) });
        } else if ((match = /^[-*]\s+(.*)$/.exec(line))) {
            flushParagraph();
            (list ??= []).push(parseInline(match[1]));
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    flushParagraph();
    flushList();
    return blocks;
}

function matrixCell(question, result) {
    if (result.status === "generation_error") {
        return { text: "err", warn: true, muted: false, title: result.error || "" };
    }
    if (result.status === "judge_error") {
        return { text: "?", warn: true, muted: false, title: result.error || "" };
    }
    let title = "";
    if (result.truncated) title = "truncated answer";
    else if (question.no_reference) title = "no reference: not in the median";
    return {
        text: `${result.score}${result.truncated ? "*" : ""}`,
        warn: false,
        muted: Boolean(question.no_reference),
        title,
    };
}

function evalEntry(question, result, index) {
    const generationFailed = result.status === "generation_error";
    const failed = generationFailed || result.status === "judge_error";
    const notes = [];
    if (result.truncated) notes.push("truncated answer: it cannot count as a pass");
    if (question.no_reference) notes.push("no reference answer: not included in the median");

    const tag = question.tag && question.tag.toLowerCase() !== question.id ? ` · ${question.tag}` : "";
    return {
        qid: question.id,
        index,
        label: `${question.id}${tag}`,
        question: question.question,
        error: failed,
        scoreText: failed ? "err" : String(result.score),
        caption: failed ? (generationFailed ? "generation failed" : "grading failed") : "/ 100",
        category: failed ? "" : CATEGORY_LABELS[result.category] || result.category || "",
        comment: failed ? result.error || "" : result.comment || "",
        answer: result.answer || "",
        notes,
    };
}

// Everything the results screen shows, computed once per opened run.
function buildReport(data) {
    const questions = data.questions_results || [];
    const summary = data.summary;
    const rec = summary.recommendation;
    const metrics = data.metrics || {};

    const notes = [];
    if (data.judge_is_candidate) {
        notes.push("the judge is also a candidate: its own score may be biased.");
    }
    const withoutReference = questions.filter((q) => q.no_reference).length;
    if (withoutReference) {
        notes.push(
            `${withoutReference} question(s) have no reference answer and are excluded from the scores.`,
        );
    }
    if (rec.model && rec.confidence === "low") {
        notes.push("low confidence: too few graded questions.");
    }

    const models = summary.models.map((stats) => {
        const cells = [];
        const entries = [];
        questions.forEach((question, index) => {
            const result = (question.results || []).find((r) => r.model_name === stats.model);
            if (!result) {
                cells.push({ text: "–", warn: false, muted: true, title: "" });
                return;
            }
            cells.push(matrixCell(question, result));
            entries.push(evalEntry(question, result, index));
        });

        const total = metrics[stats.model] || {};
        const pass = stats.pass_rate === null ? "–" : `${Math.round(stats.pass_rate * 100)}%`;
        return {
            model: stats.model,
            short: shortName(stats.model),
            median: fmtNum(stats.median),
            passRate: pass,
            tps: fmtNum(stats.median_tps),
            time: fmtNum(stats.median_time_sec),
            cells,
            entries,
            metricsLine: [
                `median ${fmtNum(stats.median)}`,
                `pass ${pass}`,
                `fails ${stats.fails}`,
                `critical ${stats.critical_fails}`,
                `errors ${stats.errors}`,
                `judge errors ${stats.judge_errors}`,
                `${fmtNum(stats.median_tps)} t/s`,
                total.total_time_sec ? `${total.total_time_sec.toFixed(1)} s total` : null,
            ]
                .filter(Boolean)
                .join(" · "),
        };
    });

    const finished = data.finished_at ? data.finished_at.replace("T", " ").slice(0, 16) : "";
    return {
        meta: [
            finished && `finished ${finished}`,
            `judge: ${data.judge_model}`,
            data.mode === "cloud" ? "cloud judge" : "local judge",
        ]
            .filter(Boolean)
            .join(" · "),
        verdict: {
            model: rec.model,
            short: rec.model ? shortName(rec.model) : "",
            label: rec.model ? "recommended" : "no recommendation",
            rule: RULE_LABELS[rec.rule] || rec.rule,
        },
        notes,
        summaryBlocks: parseMarkdown(summary.text),
        // model | median | pass | one column per question | t/s | time
        grid: `grid-template-columns:minmax(160px,1fr) 64px 64px repeat(${questions.length},48px) 64px 64px`,
        questionHeads: questions.map((q) => ({ id: q.id, title: q.tag || "" })),
        models,
        references: questions.map((q) => ({
            id: q.id,
            title: `${q.id} · ${q.tag || "–"} · ${q.reference.source}`,
            question: q.question,
            text: q.reference.text || "no reference answer.",
        })),
    };
}
