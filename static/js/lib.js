// Pure helpers. No DOM, no Alpine: tested with `node --test` (tests/js/).

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
    // Grading rows go model by model in both modes, like the backend grades.
    // Display only: SSE events find their row by key.
    unique.forEach((m) =>
        ids.forEach((q) => steps.push(row("grading", m, q, `judge · ${display(m)} · ${q}`))),
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

// Rows of one phase grouped by model, in row order. Reference and summary have
// one group (the judge). The state is derived from the rows, so no new events.
function modelGroups(steps, phase) {
    const groups = new Map();
    for (const s of steps) {
        if (s.phase !== phase) continue;
        if (!groups.has(s.model)) groups.set(s.model, []);
        groups.get(s.model).push(s);
    }
    return [...groups].map(([model, rows]) => {
        const count = (state) => rows.filter((r) => r.state === state).length;
        const ok = count("done");
        const errors = count("error");
        const skipped = count("skipped");
        const total = rows.length;
        const finished = ok + errors + skipped;

        // Between two rows of one model nothing runs for a moment: still running.
        let state = "queued";
        if (count("running") || (finished > 0 && finished < total)) state = "running";
        else if (finished === total) state = "done";

        // Wall clock from the first start to the last end (server timestamps).
        const starts = rows.map((r) => r.startTs).filter((t) => t !== null);
        const ends = rows.map((r) => r.endTs).filter((t) => t !== null);
        const span =
            state === "done" && starts.length && ends.length
                ? fmtSpan((Math.max(...ends) - Math.min(...starts)) / 1000)
                : "";

        // Running: how far it got. Done: how many succeeded, and how long it took.
        const side =
            state === "done"
                ? [`${ok}/${total}`, span].filter(Boolean).join(" · ")
                : `${finished}/${total}`;
        return { model, rows, total, ok, errors, skipped, state, side };
    });
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

// --- dom anchors ----------------------------------------------------------

// Model names contain ':', '/' and '.', so they cannot be used as ids as is.
// The id is a readable slug plus a FNV-1a hash of the raw parts, so names
// with the same slug ('a:b' and 'a/b') still get different ids.
// domId('answer', 'hf.co/o/m-GGUF:Q4_K_M', 'q1')
//   -> 'answer-hf-co-o-m-gguf-q4_k_m-q1-<hash>'
function domId(prefix, ...parts) {
    const raw = parts.map((p) => String(p ?? "")).join("\n");
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return [prefix, slug, (hash >>> 0).toString(36)].filter(Boolean).join("-");
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

// Markdown -> blocks. Nothing here touches the DOM: the template renders the
// blocks with x-text, so no HTML from a model is ever injected or executed.
// Blocks: heading, paragraph, list (- * + and 1.), code (``` fences), table, rule.
// Inline: **bold**, `code`. Everything else (links, italics, HTML) stays text.
function parseInline(text) {
    const parts = [];
    const re = /`([^`]+)`|\*\*(.+?)\*\*/g;
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
        if (match.index > last) parts.push({ text: text.slice(last, match.index), bold: false, code: false });
        if (match[1] !== undefined) parts.push({ text: match[1], bold: false, code: true });
        else parts.push({ text: match[2], bold: true, code: false });
        last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold: false, code: false });
    return parts;
}

// Models often wrap the whole text in ```markdown ... ```. Unwrap it;
// with `bareToo` also a fence without a language (the judge summary).
function unwrapFence(text, bareToo) {
    const match = /^\s*```([\w-]*)[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
    if (!match) return text;
    const lang = match[1].toLowerCase();
    return lang === "markdown" || lang === "md" || (bareToo && !lang) ? match[2] : text;
}

// '| a | b |' -> ['a', 'b']
function tableCells(line) {
    return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => parseInline(cell.trim()));
}

function parseMarkdown(text, options = {}) {
    const source = unwrapFence(String(text || "").replace(/\r\n?/g, "\n"), options.bareFence);
    const blocks = [];
    let paragraph = [];
    let list = null;
    let table = null;
    let code = null;

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list) {
            blocks.push({ type: "list", ...list });
            list = null;
        }
    };
    const flushTable = () => {
        if (table) {
            // a header row needs the |---| separator; otherwise every row is data
            const hasHead = table.length > 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(table[1]) && table[1].includes("-");
            const rows = table.filter((_, i) => !(hasHead && i === 1)).map(tableCells);
            blocks.push({ type: "table", head: hasHead ? rows[0] : [], rows: hasHead ? rows.slice(1) : rows });
            table = null;
        }
    };
    const flushAll = () => {
        flushParagraph();
        flushList();
        flushTable();
    };

    for (const raw of source.split("\n")) {
        if (code) {
            if (/^\s*```\s*$/.test(raw)) {
                blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
                code = null;
            } else {
                code.lines.push(raw);
            }
            continue;
        }

        const fence = /^\s*```\s*([\w+#.-]*)/.exec(raw);
        if (fence) {
            flushAll();
            code = { lang: fence[1].toLowerCase(), lines: [] };
            continue;
        }

        const line = raw.trim();
        if (!line) {
            flushAll();
            continue;
        }

        if (line.startsWith("|")) {
            flushParagraph();
            flushList();
            (table ??= []).push(line);
            continue;
        }
        flushTable();

        let match;
        if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
            flushParagraph();
            flushList();
            blocks.push({ type: "heading", level: match[1].length, inlines: parseInline(match[2]) });
        } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
            flushParagraph();
            flushList();
            blocks.push({ type: "rule" });
        } else if ((match = /^[-*+]\s+(.*)$/.exec(line))) {
            flushParagraph();
            if (list && list.ordered) flushList();
            (list ??= { ordered: false, start: 1, items: [] }).items.push(parseInline(match[1]));
        } else if ((match = /^(\d+)[.)]\s+(.*)$/.exec(line))) {
            flushParagraph();
            if (list && !list.ordered) flushList();
            (list ??= { ordered: true, start: Number(match[1]), items: [] }).items.push(parseInline(match[2]));
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    // an unclosed fence: the rest is code
    if (code) blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
    flushAll();
    return blocks;
}

// An answer appears in both views: parse it once.
const blockCache = new WeakMap();
function answerBlocks(result) {
    if (!blockCache.has(result)) blockCache.set(result, parseMarkdown(result.answer || ""));
    return blockCache.get(result);
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
        anchor: domId("answer", result.model_name, question.id),
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
        answerBlocks: answerBlocks(result),
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
        anchor: domId("question", question.id),
        label: questionLabel(question),
        question: question.question || "",
        metricsLine: `${rows.length} models · ${source === "none" ? "no reference" : `${source} reference`}`,
        entries,
        marks,
        spread,
    };
}

// --- archive --------------------------------------------------------------

// Run time in ms: the id ends with YYYYMMDD_HHMMSS; the timestamp field is the fallback.
function runTime(run) {
    const match = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(run?.task_id || "");
    if (match) {
        const [, y, mo, d, h, mi, s] = match.map(Number);
        return new Date(y, mo - 1, d, h, mi, s).getTime();
    }
    const parsed = Date.parse(run?.timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}

// Newest first. Stable: runs with the same time keep the API order.
function sortHistory(runs) {
    return [...(Array.isArray(runs) ? runs : [])].sort((a, b) => runTime(b) - runTime(a));
}

// --- answers by category -------------------------------------------------

const CATEGORY_ORDER = ["perfect", "acceptable", "instruction_violation", "broken_logic", "garbage"];

// One row per judge category (always, also with 0, so cards compare),
// then uncategorised and errors only when they occur.
function buildDistribution(results) {
    const n = results.length;
    const counts = {};
    let other = 0;
    let generation = 0;
    let judge = 0;
    results.forEach((r) => {
        if (r.status === "generation_error") generation += 1;
        else if (r.status === "judge_error") judge += 1;
        else if (CATEGORY_ORDER.includes(r.category)) counts[r.category] = (counts[r.category] || 0) + 1;
        else other += 1;
    });

    const row = (label, count, warn = false) => {
        const pct = n ? Math.round((100 * count) / n) : 0;
        return { label, count, warn, pct, text: `${count} · ${pct}%` };
    };
    const rows = CATEGORY_ORDER.map((c) => row(CATEGORY_LABELS[c], counts[c] || 0));
    if (other) rows.push(row("uncategorised", other));
    if (generation) rows.push(row("generation error", generation, true));
    if (judge) rows.push(row("judge error", judge, true));
    return { n, rows };
}

// --- chart: mean score against median chars/s ----------------------------

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

// 1 / 2 / 5 x 10^n, so ticks read as round numbers.
function niceStep(range, count) {
    const raw = range / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Positions are percentages of the plot box: left = x, top = 100 - y.
// The quadrant is bounded by the medians of the plotted models: "faster and
// better than half of this run". Pareto front: no other model is both faster
// and better.
function buildChart(summaryModels, display, recommended) {
    const points = [];
    const missing = [];
    summaryModels.forEach((stats) => {
        const score = clampScore(stats.mean);
        const cps =
            typeof stats.median_cps === "number" && isFinite(stats.median_cps) && stats.median_cps >= 0
                ? stats.median_cps
                : null;
        const short = display(stats.model);
        if (score === null || cps === null) missing.push(short);
        else points.push({ model: stats.model, short, score, cps, best: stats.model === recommended });
    });
    if (!points.length) {
        return { points, missing, xTicks: [], yTicks: [], pareto: "", mid: null, label: "" };
    }

    const maxCps = Math.max(...points.map((p) => p.cps));
    const span = maxCps > 0 ? maxCps * 1.05 : 1;
    const step = niceStep(span, 4);
    const tickCount = Math.max(1, Math.ceil(span / step));
    const xMax = step * tickCount;
    const digits = step < 1 ? 1 : 0;
    const xPos = (v) => (100 * v) / xMax;
    const xTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
        text: (i * step).toFixed(digits),
        pos: xPos(i * step),
    }));
    // Fixed 0..100: charts of different runs stay comparable.
    const yTicks = [0, 25, 50, 75, 100].map((v) => ({ text: String(v), pos: 100 - v }));

    const midCps = median(points.map((p) => p.cps));
    const midScore = median(points.map((p) => p.score));
    points.forEach((p) => {
        p.left = xPos(p.cps);
        p.top = 100 - p.score;
        p.flip = p.left > 70; // label on the left near the right edge
        p.leading = p.cps >= midCps && p.score >= midScore;
        p.title = `${p.short}: mean score ${p.score} · ${round1(p.cps)} c/s`;
    });

    // Walk from the fastest; a point is on the front when it beats every faster one.
    const byCps = [...points].sort((a, b) => b.cps - a.cps || b.score - a.score);
    const front = [];
    let best = -Infinity;
    byCps.forEach((p) => {
        if (p.score > best) {
            front.push(p);
            best = p.score;
        }
    });
    front.reverse();

    const leading = points.filter((p) => p.leading).map((p) => p.short);
    return {
        points,
        missing,
        xTicks,
        yTicks,
        pareto: front.length > 1 ? front.map((p) => `${p.left},${p.top}`).join(" ") : "",
        mid: {
            left: xPos(midCps),
            bottom: midScore,
            flipX: xPos(midCps) > 70, // c/s label left of its line near the right edge
            flipY: midScore > 90, // score label below its line near the top
            cpsText: `median ${round1(midCps)} c/s`,
            scoreText: `median ${round1(midScore)}`,
        },
        label: `mean score against median chars/s, ${points.length} models. faster and better than the median: ${
            leading.length ? leading.join(", ") : "none"
        }.`,
    };
}

// --- summary --------------------------------------------------------------

// Rank of one model among all for a stats key; null when it has no value.
function rankOf(summaryModels, model, key, higherIsBetter) {
    const values = summaryModels
        .map((m) => m[key])
        .filter((v) => typeof v === "number" && isFinite(v));
    const own = summaryModels.find((m) => m.model === model)?.[key];
    if (typeof own !== "number" || !isFinite(own) || !values.length) return null;
    const better = values.filter((v) => (higherIsBetter ? v > own : v < own)).length;
    return {
        rank: better + 1,
        n: values.length,
        best: higherIsBetter ? Math.max(...values) : Math.min(...values),
    };
}

// Four key figures of the recommended model, each with its place in the run.
function verdictFigures(summaryModels, model) {
    const s = summaryModels.find((m) => m.model === model);
    if (!s) return [];
    const num = (v) => (typeof v === "number" && isFinite(v) ? String(round1(v)) : "–");
    const caption = (r, fmt) => {
        if (!r) return "";
        if (r.rank === 1) return r.n > 1 ? `best of ${r.n}` : "only model";
        return `#${r.rank} of ${r.n} · best ${fmt(r.best)}`;
    };
    return [
        {
            label: "mean score",
            value: num(s.mean),
            unit: "/ 100",
            caption: caption(rankOf(summaryModels, model, "mean", true), num),
        },
        {
            label: "pass rate",
            value: s.pass_rate == null ? "–" : String(Math.round(s.pass_rate * 100)),
            unit: "%",
            caption: caption(rankOf(summaryModels, model, "pass_rate", true), (v) => `${Math.round(v * 100)}%`),
        },
        {
            label: "speed",
            value: num(s.median_cps),
            unit: "c/s",
            caption: caption(rankOf(summaryModels, model, "median_cps", true), num),
        },
        {
            label: "median time",
            value: num(s.median_time_sec),
            unit: "s",
            caption: caption(rankOf(summaryModels, model, "median_time_sec", false), (v) => `${num(v)} s`),
        },
    ];
}

// The judge writes full model names; show the same short names as the rest of the UI.
// Longest first, so a name that contains another one is replaced as a whole.
function shortenNames(blocks, names) {
    const pairs = Object.entries(names)
        .filter(([full, short]) => full !== short)
        .sort((a, b) => b[0].length - a[0].length);
    if (!pairs.length) return blocks;
    const fix = (parts) =>
        parts.forEach((p) => {
            pairs.forEach(([full, short]) => {
                if (p.text.includes(full)) p.text = p.text.split(full).join(short);
            });
        });
    blocks.forEach((b) => {
        if (b.inlines) fix(b.inlines);
        if (b.items) b.items.forEach(fix);
        if (b.head) b.head.forEach(fix);
        if (b.rows) b.rows.forEach((row) => row.forEach(fix));
    });
    return blocks;
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
        const results = [];
        questions.forEach((question, index) => {
            const result = (question.results || []).find((r) => r.model_name === stats.model);
            if (!result) {
                cells.push({ text: "–", warn: false, muted: true, title: "", bar: null, anchor: null });
                return;
            }
            results.push(result);
            cells.push({
                ...matrixCell(question, result),
                anchor: domId("answer", stats.model, question.id),
            });
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
            anchor: domId("model", stats.model),
            short: display(stats.model),
            mean: fmtNum(stats.mean),
            median: fmtNum(stats.median),
            passRate: pass,
            cps: fmtNum(stats.median_cps),
            tps: fmtNum(stats.median_tps),
            time: fmtNum(stats.median_time_sec),
            cells,
            entries,
            distribution: buildDistribution(results),
            metricsLine: [
                `mean ${fmtNum(stats.mean)}`,
                `median ${fmtNum(stats.median)}`,
                `pass ${pass}`,
                `fails ${fmtNum(stats.fails)}`,
                `critical ${fmtNum(stats.critical_fails)}`,
                `errors ${fmtNum(stats.errors)}`,
                `judge errors ${fmtNum(stats.judge_errors)}`,
                `${fmtNum(stats.median_cps)} c/s`,
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
            figures: rec.model ? verdictFigures(summaryModels, rec.model) : [],
        },
        notes,
        summaryBlocks: shortenNames(parseMarkdown(summary.text, { bareFence: true }), names),
        chart: buildChart(summaryModels, display, rec.model),
        // model | mean | median | pass | one column per question | c/s | t/s | time
        grid: `grid-template-columns:minmax(160px,1fr) 64px 64px 64px repeat(${questions.length},48px) 64px 64px 64px`,
        questionHeads: questions.map((q) => ({
            id: q.id,
            title: q.tag || "",
            anchor: domId("question", q.id),
        })),
        models,
        questionCards: questions.map((q) => buildQuestionCard(q, summaryModels, display)),
        references: questions.map((q) => {
            const ref = q.reference || {};
            return {
                id: q.id,
                title: `${q.id} · ${q.tag || "–"} · ${ref.source || "none"}`,
                question: q.question || "",
                text: ref.text || "",
                blocks: parseMarkdown(ref.text || ""),
            };
        }),
    };
}

// --- test cases file ------------------------------------------------------

// The file holds the setup form the way /api/evaluate takes it:
// {"version": 1, "base_rationale": "...",
//  "test_cases": [{tag, question, specific_rationale, reference}]}
const CASES_FILE_VERSION = 1;
const CASES_MAX_BYTES = 256 * 1024;
const CASES_MAX_COUNT = 200;
const CASES_TOO_LARGE = "the file is too large (max 256 KB).";
const CASE_OPTIONAL_FIELDS = ["tag", "specific_rationale", "reference"];

// A file the UI cannot import: the message is shown to the user as is.
class CasesFileError extends Error {}

// Form case { tag, question, rationale, reference } -> the case of the payload
// and of the file. Empty optional fields are left out: the backend would keep
// an empty tag as the tag instead of using its default.
function payloadCase(c) {
    const text = (value) => String(value ?? "").trim();
    const optional = (key, value) => (text(value) ? { [key]: text(value) } : {});
    return {
        ...optional("tag", c.tag),
        question: text(c.question),
        ...optional("specific_rationale", c.rationale),
        ...optional("reference", c.reference),
    };
}

// File case -> form fields. lmao.js adds `id` and `open` (caseCounter lives there).
function caseFields(raw) {
    return {
        tag: raw.tag,
        question: raw.question,
        rationale: raw.specific_rationale,
        reference: raw.reference,
    };
}

// A case with nothing typed in it (the initial empty case).
function isBlankCase(c) {
    return !["tag", "question", "rationale", "reference"].some((key) =>
        String(c[key] ?? "").trim(),
    );
}

// Cases without a question are skipped: the importer would reject them.
function buildCasesFile({ baseRationale, cases }) {
    const file = {
        version: CASES_FILE_VERSION,
        base_rationale: String(baseRationale ?? "").trim(),
        test_cases: cases.filter((c) => !isBlankQuestion(c)).map(payloadCase),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
}

function isBlankQuestion(c) {
    return !String(c.question ?? "").trim();
}

// Text of a file -> { baseRationale, cases }. The cases are raw: they keep the
// file's field names (specific_rationale), see caseFields(). Unknown fields are
// ignored, null counts as a missing optional field. Throws CasesFileError.
function parseCasesFile(text) {
    const source = String(text ?? "").replace(/^\uFEFF/, "");
    if (new TextEncoder().encode(source).length > CASES_MAX_BYTES) {
        throw new CasesFileError(CASES_TOO_LARGE);
    }

    let data;
    try {
        data = JSON.parse(source);
    } catch {
        throw new CasesFileError("the file is not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new CasesFileError("the file must contain a JSON object.");
    }
    if (data.version !== CASES_FILE_VERSION) {
        throw new CasesFileError(`unsupported file version: expected ${CASES_FILE_VERSION}.`);
    }

    const baseRationale = data.base_rationale ?? "";
    if (typeof baseRationale !== "string") {
        throw new CasesFileError('"base_rationale" must be a string.');
    }

    const list = data.test_cases;
    if (!Array.isArray(list) || list.length === 0) {
        throw new CasesFileError("the file has no test cases.");
    }
    if (list.length > CASES_MAX_COUNT) {
        throw new CasesFileError(`too many test cases (max ${CASES_MAX_COUNT}).`);
    }

    const cases = list.map((item, index) => {
        const label = `case ${pad2(index)}`;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new CasesFileError(`${label}: must be an object.`);
        }
        if (typeof item.question !== "string") {
            throw new CasesFileError(`${label}: "question" must be a string.`);
        }
        if (!item.question.trim()) {
            throw new CasesFileError(`${label}: the question is empty.`);
        }
        const out = { question: item.question };
        for (const key of CASE_OPTIONAL_FIELDS) {
            const value = item[key] ?? "";
            if (typeof value !== "string") {
                throw new CasesFileError(`${label}: "${key}" must be a string.`);
            }
            out[key] = value;
        }
        return out;
    });

    return { baseRationale, cases };
}

// Lets `node --test` load this file. In the browser `module` does not exist
// and the functions above stay plain globals.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        CASES_FILE_VERSION,
        CASES_MAX_BYTES,
        CASES_MAX_COUNT,
        CASES_TOO_LARGE,
        CasesFileError,
        ReportFormatError,
        answerBlocks,
        buildCasesFile,
        buildChart,
        buildDistribution,
        buildReport,
        buildSteps,
        caseFields,
        clampScore,
        competitionRanks,
        domId,
        fmtClock,
        fmtNum,
        fmtSeconds,
        fmtSpan,
        isBlankCase,
        isFailed,
        loadGroup,
        matrixCell,
        modelGroups,
        median,
        niceStep,
        pad2,
        parseCasesFile,
        parseInline,
        parseMarkdown,
        payloadCase,
        questionLabel,
        rankOf,
        round1,
        runTime,
        shortName,
        shortNames,
        shortenNames,
        sortHistory,
        stepKey,
        totalSteps,
        variantOf,
        verdictFigures,
    };
}