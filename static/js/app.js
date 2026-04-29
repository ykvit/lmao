let lastStatusMessage = "";

document.addEventListener("DOMContentLoaded", () => {
    loadModels();
    
    document.getElementById("evalForm").addEventListener("submit", startEvaluation);
    
    // Add dynamic questions
    document.getElementById("addQuestionBtn").addEventListener("click", () => {
        const list = document.getElementById("questionsList");
        const newTextarea = document.createElement("textarea");
        newTextarea.className = "question-input";
        newTextarea.rows = "3";
        newTextarea.style.marginTop = "10px";
        newTextarea.placeholder = "Another question or prompt...";
        list.appendChild(newTextarea);
    });

    // Sidebar Toggle Logic
    document.getElementById("toggleSidebarBtn").addEventListener("click", function() {
        const sidebar = document.getElementById("sidebar");
        sidebar.classList.toggle("collapsed");
        this.innerText = sidebar.classList.contains("collapsed") ? "▶" : "◀";
    });
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
            label.innerHTML = `<input type="checkbox" name="candidates" value="${model}"> ${model}`;
            candidatesDiv.appendChild(label);
        });
    } catch (err) { 
        console.error("Models load error:", err); 
    }
}

async function startEvaluation(e) {
    e.preventDefault();
    
    const candidates = Array.from(document.querySelectorAll('input[name="candidates"]:checked')).map(cb => cb.value);
    const questions = Array.from(document.querySelectorAll('.question-input')).map(ta => ta.value).filter(val => val.trim() !== "");
    
    if (candidates.length === 0) return alert("Select at least one candidate model.");
    if (questions.length === 0) return alert("Add at least one question.");

    const payload = {
        tag: document.getElementById('tag').value,
        judge: document.getElementById('judgeModel').value,
        candidates: candidates,
        questions: questions,
        base_rationale: document.getElementById('baseRationale').value,
        specific_rationale: document.getElementById('specificRationale').value
    };

    document.getElementById('runBtn').disabled = true;
    document.getElementById('resultsContainer').innerHTML = '';
    
    // Show central progress modal
    document.getElementById('progressOverlay').classList.remove('hidden');
    document.getElementById('logList').innerHTML = '';
    lastStatusMessage = "";
    addLogItem("Starting task...");

    try {
        const response = await fetch('/api/evaluate', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.task_id) pollStatus(data.task_id);
    } catch (err) {
        addLogItem("❌ Failed to start the task.");
        document.getElementById('runBtn').disabled = false;
    }
}

function addLogItem(message, isDone = false) {
    const list = document.getElementById('logList');
    
    // Mark the previous active item as done
    const currentActive = list.querySelector('.active');
    if (currentActive) {
        currentActive.classList.remove('active');
        currentActive.classList.add('done');
        currentActive.innerHTML = `✅ ${currentActive.dataset.text}`;
    }

    // Add new item
    const li = document.createElement('li');
    li.className = 'log-item active';
    li.dataset.text = message;
    li.innerHTML = isDone ? `✅ ${message}` : `<div class="spinner"></div> ${message}`;
    list.appendChild(li);
    
    // Auto-scroll to bottom
    list.scrollTop = list.scrollHeight;
}

function pollStatus(taskId) {
    const interval = setInterval(async () => {
        try {
            const response = await fetch(`/api/status/${taskId}`);
            const data = await response.json();
            
            if (data.message && data.message !== lastStatusMessage) {
                addLogItem(data.message);
                lastStatusMessage = data.message;
            }
            
            if (data.status === 'completed' || data.status === 'failed') {
                clearInterval(interval);
                addLogItem("Task Completed Successfully!", true);
                setTimeout(() => {
                    document.getElementById('progressOverlay').classList.add('hidden');
                    fetchAndRenderResults(taskId);
                }, 1500); // Wait 1.5 sec before hiding the modal
                document.getElementById('runBtn').disabled = false;
            }
        } catch (err) { 
            console.error(err); 
        }
    }, 2000);
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

        // 1. Render Final Summary
        if (data.final_summary) {
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'summary-card';
            // Replace newlines with <br> to format markdown-like text
            summaryDiv.innerHTML = `
                <h3>🏆 Judge Final Summary</h3>
                <div style="color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(data.final_summary).replace(/\n/g, '<br>')}</div>
            `;
            container.appendChild(summaryDiv);
        }

        // 2. Render Cards
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
                        <div style="margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">
                            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px; font-weight: bold;">Q${idx+1}: ${escapeHtml(eval.question)}</div>
                            <div class="score ${sClass}" style="font-size: 1.2rem; margin-bottom: 5px;">Score: ${score}/100</div>
                            <div class="comment" style="margin-bottom: 10px;">"${escapeHtml(comment)}"</div>
                            <pre style="max-height: 250px;"><code>${escapeHtml(eval.clean_answer)}</code></pre>
                        </div>
                    `;
                });

                const avgScore = validEvals > 0 ? Math.round(totalScore / validEvals) : 0;

                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = `
                    <div class="card-header">
                        <div class="card-title">${modelData.model_name} <span style="font-size:0.85rem; color:var(--text-secondary); font-weight:normal;">(Avg Score: ${avgScore})</span></div>
                        <div class="card-metrics">
                            <span class="badge">⏱️ ${time}s</span>
                            <span class="badge">🚀 ${tps} t/s</span>
                        </div>
                    </div>
                    <div class="card-body">
                        ${evalsHtml}
                    </div>
                `;
                container.appendChild(card);
            } catch (cardErr) {
                console.error("Error rendering card for model:", modelData.model_name, cardErr);
            }
        });
    } catch (err) {
        console.error("Failed to fetch results:", err);
        document.getElementById('resultsContainer').innerHTML = '<div class="welcome-msg" style="color:red;">Error rendering UI. Check console logs.</div>';
    }
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return JSON.stringify(unsafe);
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}