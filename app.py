"""Flask application for Local Model Assessment Operator.

This module provides REST API endpoints to trigger and monitor
the asynchronous evaluation of local LLMs using Ollama.
"""

import os
import json
import threading
from datetime import datetime
from flask import Flask, request, jsonify, render_template

from core.ollama_client import OllamaClient
from core.evaluator import EvaluationPipeline
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Global dictionary to store task states in memory.
TASKS = {}

ollama_client = OllamaClient()
pipeline = EvaluationPipeline(ollama_client)


def update_task_status(task_id: str, status: str, message: str) -> None:
    """Updates the status and message of a background task."""
    TASKS[task_id] = {
        "status": status,
        "message": message,
        "timestamp": datetime.now().isoformat()
    }


@app.route("/", methods=["GET"])
def index():
    """Renders the main SPA dashboard."""
    return render_template("index.html")


@app.route("/api/models", methods=["GET"])
def get_models():
    """Retrieves a list of available models from the local Ollama instance."""
    models = ollama_client.get_models()
    return jsonify({"models": models}), 200


@app.route("/api/evaluate", methods=["POST"])
def start_evaluation():
    """Starts a new asynchronous evaluation task."""
    data = request.json
    if not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    tag = data.get("tag", "general")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    task_id = f"run_{tag}_{timestamp}"

    update_task_status(task_id, "started", "Task queued for execution.")

    thread = threading.Thread(
        target=pipeline.run_evaluation,
        args=(task_id, data, update_task_status)
    )
    thread.daemon = True
    thread.start()

    return jsonify({"task_id": task_id, "status": "started"}), 202


@app.route("/api/status/<task_id>", methods=["GET"])
def get_status(task_id: str):
    """Retrieves the current status of an evaluation task."""
    task = TASKS.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(task), 200


@app.route("/api/results/<task_id>", methods=["GET"])
def get_results(task_id: str):
    """Fetches and groups results by model for frontend rendering."""
    history_dir = os.path.join("history", task_id)
    metrics_path = os.path.join(history_dir, "technical_metrics.json")
    results_path = os.path.join(history_dir, "evaluation_results.json")
    
    if not os.path.exists(results_path):
        return jsonify({"error": "Results not found or not ready"}), 404
        
    with open(metrics_path, "r", encoding="utf-8") as f:
        metrics_data = json.load(f)
        
    with open(results_path, "r", encoding="utf-8") as f:
        results_data = json.load(f)
        
    # Group results by models so each model gets its own card on the frontend
    merged_models = {}
    for q_data in results_data.get("questions_results",[]):
        question_text = q_data.get("question")
        for res in q_data.get("results",[]):
            m_name = res.get("model_name")
            
            # Skip results with JSON parsing errors (where model_name is missing)
            if not m_name:
                continue
                
            if m_name not in merged_models:
                merged_models[m_name] = {
                    "model_name": m_name,
                    "metrics": metrics_data.get("metrics", {}).get(m_name, {}),
                    "evaluations": []
                }
                
            merged_models[m_name]["evaluations"].append({
                "question": question_text,
                "clean_answer": res.get("clean_answer", "Error/Empty"),
                "judge_evaluation": res.get("judge_evaluation", {"score": 0, "comment": "No evaluation provided."})
            })
            
    return jsonify({
        "task_id": task_id,
        "final_summary": results_data.get("final_summary", "Summary not available."),
        "results": list(merged_models.values())
    }), 200


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "True").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)