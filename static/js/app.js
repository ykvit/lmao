let testCaseCount = 1;

// UI labels for the stable category ids stored in the results.
const CATEGORY_LABELS = {
    perfect: "Perfect solution",
    acceptable: "Generally acceptable",
    instruction_violation: "Violation of instructions",
    broken_logic: "Broken logic",
    garbage: "Garbage / cognitive crash",
};
const RULE_LABELS = {
    fastest_above_threshold: "the fastest model among those with a high pass rate",
    highest_median: "the highest median score (no model reached the pass-rate threshold)",
    none_graded: "no answers could be graded",
};
const PHASE_TITLES = { reference: "Reference answers", grading: "Grading", summary: "Summary" };
const PASS_SCORE = 70;
const CRITICAL_SCORE = 40;

document.addEventListener("DOMContentLoaded", () => {
    loadModels();
    loadHistory();

    document.getElementById("evalForm").addEventListener("submit", startEvaluation);

    document.getElementById("addTestCaseBtn").addEventListener("click", () => {
        testCaseCount++;
        const container = document.getElementById("testCasesContainer");
        const block = document.createElement("div");
        block.className = "test-case-block";
        block.innerHTML = `
            <div class="test-case-header">
                Test Case ${testCaseCount} 
                <button type="button" class="remove-tc-btn" onclick="this.parentElement.parentElement.remove()">✕</button>
            </div>
            <div class="form-group"><input type="text" class="tc-tag" placeholder="Tag (e.g., Logic Puzzle)" required></div>
            <div class="form-group"><textarea class="tc-question" rows="2" placeholder="Question / Prompt" required></textarea></div>
            <div class="form-group"><textarea class="tc-specific" rows="2" placeholder="Specific Prompt / Rationale (Optional)"></textarea></div>
            <div class="form-group"><textarea class="tc-reference" rows="2" placeholder="Reference answer (Optional, overrides the judge's)"></textarea></div>
        `;
        container.appendChild(block);
    });

    document.getElementById("toggleSetupBtn").addEventListener("click", () => document.getElementById("setupSidebar").classList.toggle("collapsed"));
    document.getElementById("toggleHistoryBtn").addEventListener("click", () => document.getElementById("historySidebar").classList.toggle("collapsed"));
});

async function loadModels() {
    try {
        const response = await fetch('/api/models');
        const data = await response.json();
        const judgeSelect = document.getElementById('judgeModel');
        const candidatesDiv = document.getElementById('candidatesList');

        data.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            judgeSelect.appendChild(option);

            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'candidates';
            checkbox.value = model;
            label.append(checkbox, ` ${model}`);
            candidatesDiv.appendChild(label);
        });
    } catch (err) { console.error(err); }
}

async function loadHistory() {
    try {
        const response = await fetch('/api/history');
        const runs = await response.json();
        const list = document.getElementById('historyList');
        list.innerHTML = '';
        if (runs.length === 0) return list.innerHTML = '<div style="color:var(--text-secondary); font-size:0.9rem;">No history found.</div>';

        runs.forEach(run => {
            const item = document.createElement('div');
            item.className = 'history-item';
            item.innerHTML = `
                <div class="hist-id" style="font-size: 1rem; color: var(--accent-color);">${escapeHtml(run.tag_name)}</div>
                <div class="hist-meta" style="margin-top: 4px; font-size: 0.8rem;">
                    ${escapeHtml(run.timestamp)} <br>
                    ${run.models_tested} Models • ${run.questions_count} Qs <br>
                    Judge: <span style="color: var(--text-primary);">${escapeHtml(run.judge_model)}</span>
                </div>
            `;
            item.onclick = () => {
                document.getElementById('resultsContainer').innerHTML = '<div class="spinner" style="margin: 50px auto;"></div>';
                fetchAndRenderResults(run.task_id);
                if (window.innerWidth < 1000) document.getElementById("historySidebar").classList.add("collapsed");
            };
            list.appendChild(item);
        });
    } catch (err) { console.error(err); }
}

async function startEvaluation(e) {
    e.preventDefault();
    const candidates = Array.from(document.querySelectorAll('input[name="candidates"]:checked')).map(cb => cb.value);

    const testCases = [];
    document.querySelectorAll('.test-case-block').forEach(block => {
        testCases.push({
            tag: block.querySelector('.tc-tag').value.trim(),
            question: block.querySelector('.tc-question').value.trim(),
            specific_rationale: block.querySelector('.tc-specific').value.trim(),
            reference: block.querySelector('.tc-reference').value.trim()
        });
    });

    if (candidates.length === 0) return alert("Select at least one candidate model.");
    if (testCases.length === 0) return alert("Add at least one test case.");

    const payload = {
        judge: document.getElementById('judgeModel').value,
        judge_cloud: document.getElementById('judgeCloud').checked,
        candidates: candidates,
        base_rationale: document.getElementById('baseRationale').value.trim(),
        test_cases: testCases
    };

    const runBtn = document.getElementById('runBtn');
    const overlay = document.getElementById('progressOverlay');
    runBtn.disabled = true;
    document.getElementById('resultsContainer').innerHTML = '';
    overlay.classList.remove('hidden');
    document.getElementById('logList').innerHTML = '';
    document.getElementById('progressText').textContent = '';

    try {
        const response = await fetch('/api/evaluate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to start task");
        monitorSSE(data.task_id);
    } catch (err) {
        alert(err.message);
        overlay.classList.add('hidden');
        runBtn.disabled = false;
    }
}

function monitorSSE(taskId) {
    const source = new EventSource(`/api/stream/${taskId}`);
    const list = document.getElementById('logList');
    const progressText = document.getElementById('progressText');
    const runBtn = document.getElementById('runBtn');
    let currentBlock = null;
    let lastPhase = null;
    let finished = false;

    const stepId = (...parts) => 'step-' + parts.join('-').replace(/[^a-zA-Z0-9]/g, '-');

    const openBlock = (title) => {
        // In cloud mode the phases overlap, so the log stays flat.
        if (cloud) return;
        currentBlock = document.createElement('div');
        currentBlock.className = 'log-case-block';
        currentBlock.innerHTML = `<div class="log-case-title">${escapeHtml(title)}</div>`;
        list.appendChild(currentBlock);
    };

    const addStep = (id, html) => {
        const step = document.createElement('div');
        step.className = 'log-step active';
        step.id = id;
        step.innerHTML = `<div class="spinner"></div> ${html}`;
        (currentBlock || list).appendChild(step);
    };

    const finishStep = (id, success, okHtml, errorHtml) => {
        const step = document.getElementById(id);
        if (!step) return;
        step.classList.remove('active');
        step.classList.add(success ? 'success' : 'error');
        step.innerHTML = success ? `✅ ${okHtml}` : `❌ ${errorHtml}`;
    };

    const addPlain = (className, text) => {
        const item = document.createElement('div');
        item.className = className;
        item.textContent = text;
        list.appendChild(item);
    };

    const showFailure = (message) => {
        finished = true;
        source.close();
        addPlain('log-item-plain error', `🛑 ${message}`);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'secondary-btn';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = () => document.getElementById('progressOverlay').classList.add('hidden');
        list.appendChild(closeBtn);
        runBtn.disabled = false;
    };

    source.onmessage = function(event) {
        const data = JSON.parse(event.data);
        const model = escapeHtml(data.model || '');
        const q = escapeHtml(data.question || '');

        if (data.phase !== lastPhase) {
            lastPhase = data.phase;
            if (PHASE_TITLES[data.phase]) openBlock(PHASE_TITLES[data.phase]);
        }
        if (data.progress) progressText.textContent = `Step ${data.progress.done} / ${data.progress.total}`;

        switch (data.type) {
            case 'info':
                addPlain('log-item-plain', `ℹ️ ${data.message}`);
                break;
            case 'reference_start':
                addStep(stepId('ref', data.question), `Judge <b>${model}</b> is preparing the reference for <b>${q}</b>...`);
                break;
            case 'reference_done':
                finishStep(stepId('ref', data.question), data.success,
                    `Reference for <b>${q}</b> ready (${escapeHtml(data.source)}).`,
                    `No reference for <b>${q}</b>; it will be graded without one.`);
                break;
            case 'candidate_start':
                openBlock(data.model);
                break;
            case 'answer_start':
                addStep(stepId('a', data.model, data.question), `<b>${model}</b> is answering <b>${q}</b>...`);
                break;
            case 'answer_done':
                finishStep(stepId('a', data.model, data.question), data.success,
                    `<b>${model}</b> answered <b>${q}</b>.`,
                    `<b>${model}</b> failed <b>${q}</b>: ${escapeHtml(data.error || '')}`);
                break;
            case 'grading_start':
                addStep(stepId('g', data.model, data.question), `Judge is grading <b>${model}</b> on <b>${q}</b>...`);
                break;
            case 'grading_done':
                finishStep(stepId('g', data.model, data.question), data.success,
                    `<b>${model}</b> graded on <b>${q}</b>.`,
                    `Grading of <b>${model}</b> on <b>${q}</b> failed: ${escapeHtml(data.error || '')}`);
                break;
            case 'summary_start':
                addStep('step-summary', `Generating final summary...`);
                break;
            case 'summary_done':
                finishStep('step-summary', data.success, `Final summary generated.`, `Final summary failed.`);
                break;
            case 'completed':
                finished = true;
                source.close();
                addPlain('log-item-plain success', `🎉 ${data.message}`);
                runBtn.disabled = false;
                setTimeout(() => {
                    document.getElementById('progressOverlay').classList.add('hidden');
                    fetchAndRenderResults(taskId);
                    loadHistory();
                }, 1500);
                break;
            case 'error':
                showFailure(`Error: ${data.message}`);
                break;
        }

        list.scrollTop = list.scrollHeight;
    };

    source.onerror = function(err) {
        console.error("SSE Error", err);
        if (!finished) showFailure("Connection to the server was lost.");
    };
}

function parseSimpleMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);

    html = html.replace(/^```markdown\n?/gim, '');
    html = html.replace(/```$/gim, '');

    html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 10px 0 5px 0; color: var(--accent-color);">$1</h4>');
    html = html.replace(/^## (.*$)/gim, '<h3 style="margin: 15px 0 5px 0; color: var(--text-primary);">$1</h3>');
    html = html.replace(/^# (.*$)/gim, '<h2 style="margin: 20px 0 10px 0; border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">$1</h2>');

    html = html.replace(/\*\*(.*?)\*\*/gim, '<b style="color: var(--text-primary);">$1</b>');

    html = html.replace(/^\- (.*$)/gim, '<li style="margin-left: 20px;">$1</li>');

    html = html.replace(/\n/g, '<br>');

    return html;
}

function createCard(className, html) {
    const div = document.createElement('div');
    div.className = className;
    div.innerHTML = html;
    return div;
}

function scoreColor(score) {
    if (score >= PASS_SCORE) return 'var(--accent-color)';
    return score >= CRITICAL_SCORE ? '#f59e0b' : '#ef4444';
}

function scoreClass(score) {
    if (score >= PASS_SCORE) return 'good';
    return score >= CRITICAL_SCORE ? 'average' : 'bad';
}

function fmt(value) {
    return value === null || value === undefined ? '–' : value;
}

// Groups the answers by model: Map(model -> [{ question, result }]) in question order.
function collectByModel(data) {
    const byModel = new Map();
    data.questions_results.forEach(question => {
        question.results.forEach(result => {
            if (!byModel.has(result.model_name)) byModel.set(result.model_name, []);
            byModel.get(result.model_name).push({ question, result });
        });
    });
    return byModel;
}

function renderSummary(data) {
    const { summary, questions_results: questions } = data;
    const rec = summary.recommendation;
    const rule = escapeHtml(RULE_LABELS[rec.rule] || rec.rule);
    const verdict = rec.model
        ? `Recommended: <b>${escapeHtml(rec.model)}</b> — ${rule}.`
        : `No recommendation: ${rule}.`;

    const notes = [];
    if (data.judge_is_candidate) notes.push("⚠️ The judge is also a candidate; its own score may be biased.");
    const withoutReference = questions.filter(q => q.no_reference).length;
    if (withoutReference) notes.push(`⚠️ ${withoutReference} question(s) have no reference answer and are excluded from the scores.`);
    if (rec.model && rec.confidence === 'low') notes.push("⚠️ Low confidence: too few graded questions.");

    return createCard('summary-card', `
        <h3>🏆 Judge Final Summary</h3>
        <div style="margin-bottom: 10px;">${verdict}</div>
        ${notes.map(note => `<div class="comment">${escapeHtml(note)}</div>`).join('')}
        <div style="color: var(--text-secondary); font-size: 0.95rem; line-height: 1.5;">
            ${parseSimpleMarkdown(summary.text)}
        </div>
    `);
}

function matrixCell(result) {
    if (result.status === 'generation_error') {
        return `<td style="color: #ef4444; font-weight: bold;" title="${escapeHtml(result.error || '')}">Err</td>`;
    }
    if (result.status === 'judge_error') {
        return `<td style="color: #f59e0b; font-weight: bold;" title="${escapeHtml(result.error || '')}">?</td>`;
    }
    const title = result.truncated ? ' title="truncated answer"' : '';
    return `<td style="color: ${scoreColor(result.score)}; font-weight: bold;"${title}>${result.score}${result.truncated ? '*' : ''}</td>`;
}

function renderMatrix(data) {
    const byModel = collectByModel(data);
    const questionHeaders = data.questions_results
        .map((q, i) => `<th title="${escapeHtml(q.tag)}">Q${i + 1}</th>`).join('');

    const rows = data.summary.models.map(stats => {
        const metrics = data.metrics[stats.model] || {};
        const cells = (byModel.get(stats.model) || []).map(({ result }) => matrixCell(result)).join('');
        const passRate = stats.pass_rate === null ? '–' : `${Math.round(stats.pass_rate * 100)}%`;
        return `
            <tr>
                <td style="font-weight: bold; color: var(--text-primary);">${escapeHtml(stats.model)}</td>
                <td style="font-weight: bold; font-size: 1.1rem; border-right: 1px solid var(--border-color);">${fmt(stats.median)}</td>
                <td>${passRate}</td>
                <td>${stats.fails}</td>
                <td>${stats.critical_fails}</td>
                <td>${stats.errors}</td>
                <td>${stats.judge_errors}</td>
                ${cells}
                <td style="border-left: 1px solid var(--border-color);">${fmt(stats.median_tps)}</td>
                <td>${fmt(stats.median_time_sec)}</td>
                <td>${fmt(metrics.tokens_generated)}</td>
            </tr>
        `;
    }).join('');

    return createCard('summary-card', `
        <div style="overflow-x: auto;">
            <h3 style="margin-bottom: 15px;">📊 Models Comparison Matrix</h3>
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Model</th>
                        <th title="Median score">Median</th>
                        <th title="Share of answers scoring ${PASS_SCORE}+">Pass</th>
                        <th title="Scores ${CRITICAL_SCORE}-${PASS_SCORE - 1}">Fails</th>
                        <th title="Scores below ${CRITICAL_SCORE}">Crit.</th>
                        <th title="Generation errors (count as 0)">Err</th>
                        <th title="Judge errors (excluded from the scores)">J.Err</th>
                        ${questionHeaders}
                        <th title="Median tokens per second">t/s</th>
                        <th title="Median answer time without model loading, seconds">Time (s)</th>
                        <th>Tokens</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="comment" style="margin-top: 10px;">* truncated answer · Err generation error · ? judge error</div>
        </div>
    `);
}

function renderReferences(data) {
    const items = data.questions_results.map((q, i) => {
        const text = q.reference.text ? escapeHtml(q.reference.text) : 'No reference answer.';
        return `
            <details style="margin-bottom: 8px;">
                <summary>Q${i + 1} · ${escapeHtml(q.tag)} · ${escapeHtml(q.reference.source)}</summary>
                <div class="eval-question" style="margin-top: 8px;">${escapeHtml(q.question)}</div>
                <pre><code>${text}</code></pre>
            </details>
        `;
    }).join('');
    return createCard('summary-card', `<h3>📌 Reference answers</h3>${items}`);
}

function renderEvalBlock(question, result, idx) {
    const head = `
        <div class="eval-tag">${escapeHtml(question.tag)}</div>
        <div class="eval-question">Q${idx + 1}: ${escapeHtml(question.question)}</div>
    `;
    const answer = result.answer ? `<pre><code>${escapeHtml(result.answer)}</code></pre>` : '';

    if (result.status === 'generation_error' || result.status === 'judge_error') {
        const title = result.status === 'generation_error' ? 'GENERATION FAILED' : 'GRADING FAILED';
        return `
            <div class="eval-block" style="border: 2px solid #ef4444; background: rgba(239, 68, 68, 0.05);">
                ${head}
                <div style="color: #ef4444; font-weight: bold; font-size: 1.1rem; margin-bottom: 5px;">⚠️ ${title}</div>
                <div class="comment" style="color: #ef4444;">${escapeHtml(result.error || '')}</div>
                ${answer}
            </div>
        `;
    }

    const notes = [];
    if (result.truncated) notes.push("⚠️ truncated answer: it cannot count as a pass");
    if (question.no_reference) notes.push("no reference answer: not included in the median");
    const label = CATEGORY_LABELS[result.category] || result.category;

    return `
        <div class="eval-block">
            ${head}
            <div class="score ${scoreClass(result.score)}" style="font-size: 1.1rem; margin-bottom: 5px;">Score: ${result.score}/100 · ${escapeHtml(label)}</div>
            ${notes.map(note => `<div class="comment">${escapeHtml(note)}</div>`).join('')}
            <div class="comment">"${escapeHtml(result.comment)}"</div>
            ${answer}
        </div>
    `;
}

function renderModelCard(stats, entries, metrics) {
    const evals = entries.map(({ question, result }, idx) => renderEvalBlock(question, result, idx)).join('');
    const time = metrics.total_time_sec ? metrics.total_time_sec.toFixed(1) : 0;
    const tps = metrics.tokens_per_second || 0;

    return createCard('card', `
        <div class="card-header">
            <div class="card-title">${escapeHtml(stats.model)} <span style="font-size:0.85rem; color:var(--text-secondary); font-weight:normal;">(Median: ${fmt(stats.median)})</span></div>
            <div class="card-metrics"><span class="badge">⏱️ ${time}s</span><span class="badge">🚀 ${tps} t/s</span></div>
        </div>
        <div class="card-body">${evals}</div>
    `);
}

async function fetchAndRenderResults(taskId) {
    const container = document.getElementById('resultsContainer');
    try {
        const response = await fetch(`/api/results/${taskId}`);
        const data = await response.json();
        if (!response.ok) {
            container.innerHTML = `<div class="welcome-msg" style="color:#ef4444;">${escapeHtml(data.error || 'Failed to load results.')}</div>`;
            return;
        }

        container.innerHTML = '';
        container.appendChild(renderSummary(data));
        container.appendChild(renderMatrix(data));
        container.appendChild(renderReferences(data));

        const byModel = collectByModel(data);
        data.summary.models.forEach(stats => {
            container.appendChild(renderModelCard(stats, byModel.get(stats.model) || [], data.metrics[stats.model] || {}));
        });
    } catch (err) {
        console.error("Failed to fetch results:", err);
        container.innerHTML = '<div class="welcome-msg" style="color:#ef4444;">Error rendering UI.</div>';
    }
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return JSON.stringify(unsafe);
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}