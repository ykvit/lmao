"""Flask application for the Local Model Assessment Operator.

This module provides REST API endpoints to trigger and monitor the asynchronous
evaluation of local Large Language Models (LLMs) using Ollama. It serves the SPA,
handles Server-Sent Events (SSE) for real-time UI updates, and manages task history.
"""

import os
import json
import threading
import time
from datetime import datetime
from flask import Flask, request, jsonify, render_template, Response
from dotenv import load_dotenv

from core.ollama_client import OllamaClient
from core.evaluator import EvaluationPipeline

load_dotenv()

app = Flask(__name__)

# Global dictionary to store task states and their event logs in memory.
# Format: { "task_id": { "status": str, "events": list[dict] } }
TASKS = {}

ollama_client = OllamaClient()
pipeline = EvaluationPipeline(ollama_client)


def update_task_status(task_id: str, payload: dict) -> None:
    """Appends a new structured event payload to the task's event stream.

    Args:
        task_id (str): The unique identifier of the task.
        payload (dict): The event data to append (e.g., {"type": "info", "message": "..."}).
    """
    if task_id in TASKS:
        payload["timestamp"] = datetime.now().isoformat()
        TASKS[task_id]["events"].append(payload)
        
        if payload.get("type") in ["completed", "error"]:
            TASKS[task_id]["status"] = payload.get("type")


@app.route("/", methods=["GET"])
def index():
    """Renders the main Single Page Application (SPA) dashboard.

    Returns:
        str: The rendered HTML template.
    """
    return render_template("index.html")


@app.route("/api/models", methods=["GET"])
def get_models():
    """Retrieves a list of available models from the local Ollama instance.

    Returns:
        Response: A JSON response containing the list of model names.
    """
    models = ollama_client.get_models()
    return jsonify({"models": models}), 200


@app.route("/api/evaluate", methods=["POST"])
def start_evaluation():
    """Starts a new asynchronous evaluation task.

    Expects a JSON payload containing judge, candidates, base_rationale,
    and a list of test_cases.

    Returns:
        Response: A JSON response containing the generated task_id and status.
    """
    data = request.json
    if not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    test_cases = data.get("test_cases", [])
    first_tag = test_cases[0].get("tag", "run") if test_cases else "run"
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    task_id = f"run_{first_tag}_{timestamp}"

    # Initialize the task with an empty event list.
    TASKS[task_id] = {
        "status": "started",
        "events":[
            {"type": "info", "message": "Task queued for execution."}
        ]
    }

    # Start the evaluation pipeline in a background thread.
    thread = threading.Thread(
        target=pipeline.run_evaluation,
        args=(task_id, data, update_task_status)
    )
    thread.daemon = True
    thread.start()

    return jsonify({"task_id": task_id, "status": "started"}), 202


@app.route("/api/stream/<task_id>", methods=["GET"])
def stream_status(task_id: str):
    """Server-Sent Events (SSE) endpoint to push real-time updates to the client.

    Args:
        task_id (str): The unique identifier of the task to monitor.

    Returns:
        Response: A continuous text/event-stream response.
    """
    def generate():
        task = TASKS.get(task_id)
        if not task:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Task not found'})}\n\n"
            return
            
        idx = 0
        while True:
            # Yield new events as they become available in the memory buffer.
            if idx < len(task["events"]):
                event = task["events"][idx]
                yield f"data: {json.dumps(event)}\n\n"
                
                # Stop streaming if the task has finished or failed.
                if event.get("type") in ["completed", "error"]:
                    break
                idx += 1
            else:
                # Sleep briefly to avoid CPU spinning while waiting for events.
                time.sleep(0.5)
                
    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/history", methods=["GET"])
def get_history():
    """Retrieves a list of all past evaluations stored on disk.

    Parses the directory names and evaluation_results.json to extract
    rich metadata including readable timestamps, judge name, and counts.

    Returns:
        Response: A JSON list of historical run metadata, sorted by newest first.
    """
    history_dir = "history"
    if not os.path.exists(history_dir):
        return jsonify([])

    runs =[]
    for task_id in os.listdir(history_dir):
        task_path = os.path.join(history_dir, task_id)
        if os.path.isdir(task_path):
            results_path = os.path.join(task_path, "evaluation_results.json")
            if os.path.exists(results_path):
                try:
                    with open(results_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        
                        # Parse task_id format: run_{tag}_{YYYYMMDD}_{HHMMSS}
                        parts = task_id.split('_')
                        if len(parts) >= 4:
                            tag_name = "_".join(parts[1:-2]).replace("_", " ").title()
                            date_str = parts[-2]
                            time_str = parts[-1]
                            try:
                                dt = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
                                timestamp = dt.strftime("%Y-%m-%d %H:%M")
                            except ValueError:
                                timestamp = f"{date_str} {time_str}"
                        else:
                            tag_name = task_id
                            timestamp = "Unknown"
                        
                        # Extract counts and judge
                        questions = data.get("questions_results",[])
                        q_count = len(questions)
                        # Find max models tested across questions
                        models_count = len(questions[0].get("results",[])) if q_count > 0 else 0
                        judge_model = data.get("judge_model", "Unknown Judge")
                        
                        runs.append({
                            "task_id": task_id,
                            "tag_name": tag_name,
                            "timestamp": timestamp,
                            "models_tested": models_count,
                            "questions_count": q_count,
                            "judge_model": judge_model
                        })
                except Exception:
                    pass # Silently skip corrupted directories
    
    # Sort by task_id descending (newest first).
    runs.sort(key=lambda x: x["task_id"], reverse=True)
    return jsonify(runs), 200


@app.route("/api/results/<task_id>", methods=["GET"])
def get_results(task_id: str):
    """Fetches and formats the results of a specific task for frontend rendering.

    Groups the questions and judge scores by the candidate model name, making it 
    easier for the UI to build per-model comparison cards. Explicitly propagates
    errors if the judge evaluation failed.

    Args:
        task_id (str): The unique identifier of the completed task.

    Returns:
        Response: A JSON object containing the formatted results and metrics.
    """
    history_dir = os.path.join("history", task_id)
    metrics_path = os.path.join(history_dir, "technical_metrics.json")
    results_path = os.path.join(history_dir, "evaluation_results.json")
    
    if not os.path.exists(results_path):
        return jsonify({"error": "Results not found or not ready"}), 404
        
    with open(metrics_path, "r", encoding="utf-8") as f:
        metrics_data = json.load(f)
        
    with open(results_path, "r", encoding="utf-8") as f:
        results_data = json.load(f)
        
    merged_models = {}
    for q_data in results_data.get("questions_results",[]):
        question_text = q_data.get("question")
        tag = q_data.get("tag", "General")
        
        for res in q_data.get("results",[]):
            m_name = res.get("model_name")
            if not m_name:
                continue
                
            if m_name not in merged_models:
                merged_models[m_name] = {
                    "model_name": m_name,
                    "metrics": metrics_data.get("metrics", {}).get(m_name, {}),
                    "evaluations":[]
                }
                
            # Explicitly append the error field if it exists to notify the UI
            merged_models[m_name]["evaluations"].append({
                "tag": tag,
                "question": question_text,
                "clean_answer": res.get("clean_answer", "Error/Empty"),
                "error": res.get("error"),
                "judge_evaluation": res.get("judge_evaluation", {"score": 0, "comment": "No evaluation provided."})
            })
            
    return jsonify({
        "task_id": task_id,
        "final_summary": results_data.get("final_summary", "Summary not available."),
        "results": list(merged_models.values())
    }), 200



@app.route('/health')
def health_check():
  """Checks the health status of the service.

  Returns:
      A tuple containing a dictionary with the status and an HTTP 200 code.
  """
  return {'status': 'ok'}, 200


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "True").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)