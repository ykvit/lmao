let testCaseCount = 1;

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
            option.value = model; option.textContent = model;
            judgeSelect.appendChild(option);
            
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.innerHTML = `<input type="checkbox" name="candidates" value="${model}"> ${model}`;
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
            item.innerHTML = `<div class="hist-id">${run.task_id.replace('run_', '')}</div><div class="hist-meta">${run.timestamp} • ${run.models_tested} Models</div>`;
            item.onclick = () => {
                document.getElementById('resultsContainer').innerHTML = '<div class="spinner" style="margin: 50px auto;"></div>';
                fetchAndRenderResults(run.task_id);
                if(window.innerWidth < 1000) document.getElementById("historySidebar").classList.add("collapsed");
            };
            list.appendChild(item);
        });
    } catch (err) { console.error(err); }
}

async function startEvaluation(e) {
    e.preventDefault();
    const candidates = Array.from(document.querySelectorAll('input[name="candidates"]:checked')).map(cb => cb.value);
    
    const testCasesBlocks = document.querySelectorAll('.test-case-block');
    const testCases =[];
    testCasesBlocks.forEach(block => {
        testCases.push({
            tag: block.querySelector('.tc-tag').value.trim(),
            question: block.querySelector('.tc-question').value.trim(),
            specific_rationale: block.querySelector('.tc-specific').value.trim()
        });
    });
    
    if (candidates.length === 0) return alert("Select at least one candidate model.");
    if (testCases.length === 0) return alert("Add at least one test case.");

    const payload = {
        judge: document.getElementById('judgeModel').value,
        candidates: candidates,
        base_rationale: document.getElementById('baseRationale').value,
        test_cases: testCases
    };

    document.getElementById('runBtn').disabled = true;
    document.getElementById('resultsContainer').innerHTML = '';
    
    document.getElementById('progressOverlay').classList.remove('hidden');
    document.getElementById('logList').innerHTML = '';

    try {
        const response = await fetch('/api/evaluate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.task_id) monitorSSE(data.task_id);
    } catch (err) {
        alert("Failed to start task");
        document.getElementById('runBtn').disabled = false;
    }
}

// SSE Connection & UI Parsing
function monitorSSE(taskId) {
    const source = new EventSource(`/api/stream/${taskId}`);
    let currentCaseBlock = null;

    source.onmessage = function(event) {
        const data = JSON.parse(event.data);
        const list = document.getElementById('logList');

        if (data.type === 'info') {
            const item = document.createElement('div');
            item.className = 'log-item-plain';
            item.innerHTML = `ℹ️ ${data.message}`;
            list.appendChild(item);
        }
        else if (data.type === 'case_start') {
            currentCaseBlock = document.createElement('div');
            currentCaseBlock.className = 'log-case-block';
            currentCaseBlock.innerHTML = `
                <div class="log-case-title">${data.case}/${data.total} <span class="tag-badge">${data.tag}</span></div>
            `;
            list.appendChild(currentCaseBlock);
        }
        else if (data.type === 'model_start') {
            const stepId = `step-c${data.case}-m-${data.model.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const step = document.createElement('div');
            step.className = 'log-step active';
            step.id = stepId;
            step.innerHTML = `<div class="spinner"></div> Model <b>${data.model}</b> is generating...`;
            if (currentCaseBlock) currentCaseBlock.appendChild(step);
            else list.appendChild(step);
        }
        else if (data.type === 'model_done') {
            const stepId = `step-c${data.case}-m-${data.model.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const step = document.getElementById(stepId);
            if (step) {
                step.classList.remove('active');
                if (data.success) {
                    step.classList.add('success');
                    step.innerHTML = `✅ Model <b>${data.model}</b> is generating...`;
                } else {
                    step.classList.add('error');
                    step.innerHTML = `❌ Model <b>${data.model}</b> error: ${data.error}`;
                }
            }
        }
        else if (data.type === 'judge_start') {
            const stepId = `step-c${data.case}-j-${data.model.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const step = document.createElement('div');
            step.className = 'log-step active';
            step.id = stepId;
            step.innerHTML = `<div class="spinner"></div> Judge <b>${data.model}</b> is analyzing...`;
            if (currentCaseBlock) currentCaseBlock.appendChild(step);
            else list.appendChild(step);
        }
        else if (data.type === 'judge_done') {
            const stepId = `step-c${data.case}-j-${data.model.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const step = document.getElementById(stepId);
            if (step) {
                step.classList.remove('active');
                if (data.success) {
                    step.classList.add('success');
                    step.innerHTML = `✅ Judge <b>${data.model}</b> is analyzing...`;
                } else {
                    step.classList.add('error');
                    step.innerHTML = `❌ Judge <b>${data.model}</b> failed.`;
                }
            }
        }
        else if (data.type === 'summary_start') {
            const step = document.createElement('div');
            step.className = 'log-step active';
            step.id = 'step-summary';
            step.innerHTML = `<div class="spinner"></div> Generating final summary...`;
            list.appendChild(step);
        }
        else if (data.type === 'summary_done') {
            const step = document.getElementById('step-summary');
            if (step) {
                step.classList.remove('active');
                step.classList.add('success');
                step.innerHTML = `✅ Generating final summary...`;
            }
        }
        else if (data.type === 'completed' || data.type === 'error') {
            const item = document.createElement('div');
            item.className = data.type === 'completed' ? 'log-item-plain success' : 'log-item-plain error';
            item.innerHTML = data.type === 'completed' ? `🎉 ${data.message}` : `🛑 Error: ${data.message}`;
            list.appendChild(item);
            
            source.close();
            
            if(data.type === 'completed') {
                setTimeout(() => {
                    document.getElementById('progressOverlay').classList.add('hidden');
                    fetchAndRenderResults(taskId);
                    loadHistory();
                }, 1500);
            }
            document.getElementById('runBtn').disabled = false;
        }

        list.scrollTop = list.scrollHeight;
    };

    source.onerror = function(err) {
        console.error("SSE Error", err);
        source.close();
        document.getElementById('runBtn').disabled = false;
    };
}

async function fetchAndRenderResults(taskId) { 
    try {
        const response = await fetch(`/api/results/${taskId}`);
        const data = await response.json();
        const container = document.getElementById('resultsContainer');
        container.innerHTML = '';
        
        if (!data.results || data.results.length === 0) {
            container.innerHTML = '<div class="welcome-msg">No results found or parsing failed. Check server logs.</div>';
            return;
        }

        if (data.final_summary) {
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'summary-card';
            summaryDiv.innerHTML = `
                <h3>🏆 Judge Final Summary</h3>
                <div style="color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(data.final_summary).replace(/\n/g, '<br>')}</div>
            `;
            container.appendChild(summaryDiv);
        }

        data.results.forEach(modelData => {
            try {
                const tps = modelData.metrics.tokens_per_second || 0;
                const time = modelData.metrics.total_time_sec ? modelData.metrics.total_time_sec.toFixed(1) : 0;
                let evalsHtml = "";
                let totalScore = 0;
                let validEvals = 0;
                
                modelData.evaluations.forEach((eval, idx) => {
                    const score = eval.judge_evaluation.score || 0;
                    const comment = eval.judge_evaluation.comment || "No comment provided.";
                    totalScore += score;
                    validEvals++;
                    let sClass = score >= 80 ? "good" : (score >= 50 ? "average" : "bad");
                    evalsHtml += `
                        <div class="eval-block">
                            <div class="eval-tag">${escapeHtml(eval.tag)}</div>
                            <div class="eval-question">Q${idx+1}: ${escapeHtml(eval.question)}</div>
                            <div class="score ${sClass}" style="font-size: 1.1rem; margin-bottom: 5px;">Score: ${score}/100</div>
                            <div class="comment">"${escapeHtml(comment)}"</div>
                            <pre><code>${escapeHtml(eval.clean_answer)}</code></pre>
                        </div>
                    `;
                });
                const avgScore = validEvals > 0 ? Math.round(totalScore / validEvals) : 0;

                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = `
                    <div class="card-header">
                        <div class="card-title">${modelData.model_name} <span style="font-size:0.85rem; color:var(--text-secondary); font-weight:normal;">(Avg: ${avgScore})</span></div>
                        <div class="card-metrics"><span class="badge">⏱️ ${time}s</span><span class="badge">🚀 ${tps} t/s</span></div>
                    </div>
                    <div class="card-body">${evalsHtml}</div>
                `;
                container.appendChild(card);
            } catch (cardErr) { console.error("Error rendering card:", cardErr); }
        });
    } catch (err) {
        console.error("Failed to fetch results:", err);
        document.getElementById('resultsContainer').innerHTML = '<div class="welcome-msg" style="color:red;">Error rendering UI.</div>';
    }
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return JSON.stringify(unsafe);
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}