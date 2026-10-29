// Pure helpers. No DOM, no Alpine, so they can be unit-tested later.

// 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M' -> 'openbmb/MiniCPM5-2B'
// The full name stays in `title` attributes and in the archive meta.
function shortName(name) {
    if (typeof name !== "string") return "";
    return name.replace(/^hf\.co\//, "").replace(/-GGUF:[^:\s]+$/i, "");
}

// 'x-GGUF:Q4_K_M' -> 'Q4_K_M', 'llama3:8b' -> '8b', 'llama3' -> 'latest'
function variantOf(name) {
    const quant = /-GGUF:([^:\s]+)$/i.exec(name);
    if (quant) return quant[1];
    const tag = /:([^:/\s]+)$/.exec(name);
    return tag ? tag[1] : "latest";
}

// Display names for a set of models: { fullName: displayName }.
// Names whose short form collides get the quantisation as a suffix
// ('foo · Q4_K_M' / 'foo · Q8_0'); if that is still ambiguous, the full name.
function shortNames(names) {
    const unique = [...new Set((names || []).filter((n) => typeof n === "string" && n))];
    const groups = new Map();
    unique.forEach((name) => {
        const short = shortName(name);
        if (!groups.has(short)) groups.set(short, []);
        groups.get(short).push(name);
    });

    const out = {};
    groups.forEach((group, short) => {
        if (group.length === 1) {
            out[group[0]] = short;
            return;
        }
        const variants = group.map(variantOf);
        const distinct = new Set(variants).size === group.length;
        group.forEach((name, i) => {
            out[name] = distinct ? `${short} · ${variants[i]}` : name;
        });
    });
    return out;
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
// `names` is the map from shortNames(); missing names fall back to shortName().
function buildSteps(judge, candidates, questionCount, names = {}) {
    const display = (m) => names[m] || shortName(m);
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
        endTs: null, // server timestamp, for the phase duration
        loading: false, // first call of a model load group: the load notice may apply
        announced: false, // the load notice was already announced to screen readers
    });

    const steps = [];
    ids.forEach((q) => steps.push(row("reference", judge, q, `reference ${q}`)));
    unique.forEach((m) =>
        ids.forEach((q) => steps.push(row("answer", m, q, `${display(m)} · ${q}`))),
    );
    // Local mode grades question by question.
    ids.forEach((q) =>
        unique.forEach((m) =>
            steps.push(row("grading", m, q, `judge · ${display(m)} · ${q}`)),
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

// Empty for missing, broken or negative durations (clock skew, lost start event).
function fmtSeconds(sec) {
    return typeof sec === "number" && isFinite(sec) && sec >= 0 ? `${sec.toFixed(1)} s` : "";
}

// 151 -> '02:31'
function fmtClock(sec) {
    const total = Math.max(0, Math.floor(sec));
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

// Phase duration: '41.2 s' under a minute, '05:12' above.
function fmtSpan(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
    return sec < 60 ? `${sec.toFixed(1)} s` : fmtClock(sec);
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
// One wording for questions without a reference, everywhere in the UI.
const NO_REFERENCE = "excluded from the scores";

// A run file the UI cannot read: the message is shown to the user as is.
class ReportFormatError extends Error {}

function fmtNum(value) {
    return value === null || value === undefined ? "–" : String(value);
}

// Score as a 0..100 number for bars and scales, or null.
function clampScore(value) {
    return typeof value === "number" && isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
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

function isFailed(result) {
    return result.status === "generation_error" || result.status === "judge_error";
}

function questionLabel(question) {
    const tag =
        question.tag && String(question.tag).toLowerCase() !== question.id ? ` · ${question.tag}` : "";
    return `${question.id}${tag}`;
}

function matrixCell(question, result) {
    if (result.status === "generation_error") {
        return { text: "err", warn: true, muted: false, title: result.error || "", bar: null };
    }
    if (result.status === "judge_error") {
        return { text: "?", warn: true, muted: false, title: result.error || "", bar: null };
    }
    let title = "";
    if (result.truncated) title = "truncated answer";
    else if (question.no_reference) title = `no reference: ${NO_REFERENCE}`;
    return {
        text: `${fmtNum(result.score)}${result.truncated ? "*" : ""}`,
        warn: false,
        muted: Boolean(question.no_reference),
        title,
        bar: clampScore(result.score),
    };
}

function evalEntry(question, result, index) {
    const generationFailed = result.status === "generation_error";
    const failed = isFailed(result);
    const notes = [];
    if (result.truncated) notes.push("truncated answer: it cannot count as a pass");
    if (question.no_reference) notes.push(`no reference answer: ${NO_REFERENCE}`);

    return {
        qid: question.id,
        index,
        label: questionLabel(question),
        question: question.question || "",
        error: failed,
        score: failed ? null : clampScore(result.score),
        scoreText: failed ? "err" : fmtNum(result.score),
        caption: failed ? (generationFailed ? "generation failed" : "grading failed") : "/ 100",
        category: failed ? "" : CATEGORY_LABELS[result.category] || result.category || "",
        comment: failed ? result.error || "" : result.comment || "",
        answer: result.answer || "",
        notes,
    };
}

// Competition ranking (1, 1, 3): equal scores share a rank, null (failed) is not ranked.
function competitionRanks(scores) {
    return scores.map((score) =>
        score === null ? null : 1 + scores.filter((other) => other !== null && other > score).length,
    );
}

function pad2digits(number) {
    return String(number).padStart(2, "0");
}

// One card per question: the answers of all models, best first, failed ones last.
function buildQuestionCard(question, summaryModels, display) {
    const rows = [];
    summaryModels.forEach((stats, order) => {
        const result = (question.results || []).find((r) => r.model_name === stats.model);
        if (result) rows.push({ stats, result, order });
    });

    const ranks = competitionRanks(
        rows.map(({ result }) => (isFailed(result) ? null : (result.score ?? null))),
    );

    const entries = rows.map(({ stats, result, order }, i) => ({
        ...evalEntry(question, result, order),
        model: stats.model,
        short: display(stats.model),
        rank: ranks[i],
        rankText:
            ranks[i] === null
                ? "not ranked"
                : `rank ${pad2digits(ranks[i])} / ${pad2digits(rows.length)}`,
        order,
    }));
    entries.sort(
        (a, b) =>
            (a.rank === null) - (b.rank === null) || (a.rank ?? 0) - (b.rank ?? 0) || a.order - b.order,
    );

    // Score scale: one mark per distinct score; several models on one score = a tall tick.
    const graded = entries.filter((e) => e.score !== null);
    const byScore = new Map();
    graded.forEach((e) => {
        if (!byScore.has(e.score)) byScore.set(e.score, []);
        byScore.get(e.score).push(e.short);
    });
    const marks = [...byScore].map(([score, names]) => ({
        score,
        many: names.length > 1,
        title: `${score}: ${names.join(", ")}`,
    }));
    const scores = graded.map((e) => e.score);
    let spread = "";
    if (scores.length === 1) spread = `one graded answer · ${scores[0]}`;
    else if (scores.length > 1) spread = `range ${Math.min(...scores)}–${Math.max(...scores)}`;

    const source = (question.reference || {}).source || "none";
    return {
        id: question.id,
        label: questionLabel(question),
        question: question.question || "",
        metricsLine: `${rows.length} models · ${source === "none" ? "no reference" : `${source} reference`}`,
        entries,
        marks,
        spread,
    };
}

// Everything the results screen shows, computed once per opened run.
// Throws ReportFormatError for files the UI cannot read (older schema).
function buildReport(data) {
    if (
        !data ||
        !Array.isArray(data.questions_results) ||
        !data.summary ||
        !Array.isArray(data.summary.models)
    ) {
        throw new ReportFormatError("this run was saved in an older format and cannot be shown.");
    }

    const questions = data.questions_results;
    const summary = data.summary;
    const rec = summary.recommendation || {};
    const metrics = data.metrics || {};
    const summaryModels = summary.models.filter((s) => s && typeof s.model === "string");

    const names = shortNames([...summaryModels.map((s) => s.model), rec.model]);
    const display = (m) => names[m] || shortName(m);

    const notes = [];
    if (data.judge_is_candidate) {
        notes.push("the judge is also a candidate: its own score may be biased.");
    }
    const withoutReference = questions.filter((q) => q.no_reference).length;
    if (withoutReference) {
        notes.push(`${withoutReference} question(s) have no reference answer: ${NO_REFERENCE}.`);
    }
    if (rec.model && rec.confidence === "low") {
        notes.push("low confidence: too few graded questions.");
    }

    const models = summaryModels.map((stats) => {
        const cells = [];
        const entries = [];
        questions.forEach((question, index) => {
            const result = (question.results || []).find((r) => r.model_name === stats.model);
            if (!result) {
                cells.push({ text: "–", warn: false, muted: true, title: "", bar: null });
                return;
            }
            cells.push(matrixCell(question, result));
            entries.push(evalEntry(question, result, index));
        });

        const total = metrics[stats.model] || {};
        const pass = stats.pass_rate == null ? "–" : `${Math.round(stats.pass_rate * 100)}%`;
        const totalTime =
            typeof total.total_time_sec === "number" && total.total_time_sec > 0
                ? `${total.total_time_sec.toFixed(1)} s total`
                : null;
        return {
            model: stats.model,
            short: display(stats.model),
            median: fmtNum(stats.median),
            passRate: pass,
            tps: fmtNum(stats.median_tps),
            time: fmtNum(stats.median_time_sec),
            cells,
            entries,
            metricsLine: [
                `median ${fmtNum(stats.median)}`,
                `pass ${pass}`,
                `fails ${fmtNum(stats.fails)}`,
                `critical ${fmtNum(stats.critical_fails)}`,
                `errors ${fmtNum(stats.errors)}`,
                `judge errors ${fmtNum(stats.judge_errors)}`,
                `${fmtNum(stats.median_tps)} t/s`,
                totalTime,
            ]
                .filter(Boolean)
                .join(" · "),
        };
    });

    const finished =
        typeof data.finished_at === "string" ? data.finished_at.replace("T", " ").slice(0, 16) : "";
    return {
        meta: [
            finished && `finished ${finished}`,
            data.judge_model && `judge: ${data.judge_model}`,
            data.mode === "cloud" ? "cloud judge" : "local judge",
        ]
            .filter(Boolean)
            .join(" · "),
        verdict: {
            model: rec.model || null,
            short: rec.model ? display(rec.model) : "",
            label: rec.model ? "recommended" : "no recommendation",
            rule: RULE_LABELS[rec.rule] || rec.rule || "",
        },
        notes,
        summaryBlocks: parseMarkdown(summary.text),
        // model | median | pass | one column per question | t/s | time
        grid: `grid-template-columns:minmax(160px,1fr) 64px 64px repeat(${questions.length},48px) 64px 64px`,
        questionHeads: questions.map((q) => ({ id: q.id, title: q.tag || "" })),
        models,
        questionCards: questions.map((q) => buildQuestionCard(q, summaryModels, display)),
        references: questions.map((q) => {
            const ref = q.reference || {};
            return {
                id: q.id,
                title: `${q.id} · ${q.tag || "–"} · ${ref.source || "none"}`,
                question: q.question || "",
                text: ref.text || "no reference answer.",
            };
        }),
    };
}