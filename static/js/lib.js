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
