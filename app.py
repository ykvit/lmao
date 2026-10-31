"""Flask application for the Local Model Assessment Operator.

This module provides REST API endpoints to trigger and monitor the asynchronous
evaluation of local Large Language Models (LLMs) using Ollama. It serves the SPA,
handles Server-Sent Events (SSE) for real-time UI updates, and manages task history.
"""

import json
import os
import re
import threading
import time
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request
from werkzeug.utils import secure_filename

from core.evaluator import SCHEMA_VERSION, EvaluationPipeline
from core.export import to_csv, to_markdown
from core.ollama_client import OllamaClient

load_dotenv()

app = Flask(__name__)

# Global dictionary to store task states and their event logs in memory.
# Format: { "task_id": { "status": str, "events": list[dict] } }
TASKS = {}

ollama_client = OllamaClient()
pipeline = EvaluationPipeline(ollama_client)

_SAFE_TAG_RE = re.compile(r"[^a-zA-Z0-9_-]")
_OPTIONAL_TEXT_FIELDS = ("tag", "specific_rationale", "reference")

# An SSE stream that writes nothing never notices a closed connection, and
# gunicorn has only a few threads. A comment line every few seconds fixes that.
HEARTBEAT_SEC = 15


def _to_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


# format -> (renderer, mimetype) for /api/results/<task_id>/export
_EXPORTS = {
    "json": (_to_json, "application/json"),
    "csv": (to_csv, "text/csv"),
    "md": (to_markdown, "text/markdown"),
}


def _sanitize_tag(tag, fallback="run", max_length=40):
    """Strip anything unsafe for a filesystem path segment."""
    if not isinstance(tag, str) or not tag.strip():
        return fallback
    cleaned = _SAFE_TAG_RE.sub("_", tag.strip())[:max_length]
    return cleaned or fallback


def _validate_payload(data: dict) -> str | None:
    """Checks the shape of an evaluation request.

    Args:
        data (dict): The parsed JSON payload.

    Returns:
        str | None: A description of the first problem, or None if valid.
    """
    judge = data.get("judge")
    candidates = data.get("candidates")
    test_cases = data.get("test_cases")

    if not isinstance(judge, str) or not judge:
        return "Field 'judge' must be a model name."
    if (
        not isinstance(candidates, list)
        or not candidates
        or not all(isinstance(model, str) and model for model in candidates)
    ):
        return "Field 'candidates' must be a non-empty list of model names."
    if (
        not isinstance(test_cases, list)
        or not test_cases
        or not all(
            isinstance(case, dict)
            and isinstance(case.get("question"), str)
            and case["question"].strip()
            for case in test_cases
        )
    ):
        return "Field 'test_cases' must be a non-empty list of objects with a question."
    if not isinstance(data.get("base_rationale", ""), str) or not all(
        isinstance(case.get(field, ""), str)
        for case in test_cases
        for field in _OPTIONAL_TEXT_FIELDS
    ):
        return "Text fields must be strings."
    if not isinstance(data.get("judge_cloud", False), bool):
        return "Field 'judge_cloud' must be a boolean."
    return None


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


def _run_task(task_id: str, payload: dict) -> None:
    """Runs the pipeline in a worker thread and reports a crash to the stream.

    Without this, an exception would end the thread silently and the SSE stream
    would wait forever for a final event.
    """
    try:
        pipeline.run_evaluation(task_id, payload, update_task_status)
    except Exception as e:
        update_task_status(
            task_id, {"type": "error", "message": f"Evaluation failed: {e}"}
        )


def _read_json(path: str) -> dict | None:
    """Reads a JSON object from disk, or None if it is missing or unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError:
        return None
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _read_run(task_id: str) -> dict | None:
    """Reads the results of a run, or None if it is missing or not schema v2."""
    path = os.path.join(pipeline.history_dir, task_id, "evaluation_results.json")
    data = _read_json(path)
    if data is None or data.get("schema_version") != SCHEMA_VERSION:
        return None
    return data


def _parse_task_id(task_id: str) -> tuple[str, str]:
    """Splits run_{tag}_{YYYYMMDD}_{HHMMSS} into a readable tag and timestamp."""
    parts = task_id.split("_")
    if len(parts) < 4:
        return task_id, "Unknown"

    tag_name = "_".join(parts[1:-2]).replace("_", " ").title()
    date_str, time_str = parts[-2], parts[-1]
    try:
        moment = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
    except ValueError:
        return tag_name, f"{date_str} {time_str}"
    return tag_name, moment.strftime("%Y-%m-%d %H:%M")


def _load_run(task_id: str) -> tuple[dict | None, tuple | None]:
    """Reads a saved run together with its technical metrics.

    Args:
        task_id (str): The task id from the URL.

    Returns:
        tuple: (data, None) on success, or (None, error) where error is a
            (response, status) pair ready to be returned from a view.
    """
    safe_task_id = secure_filename(task_id)
    if not safe_task_id or safe_task_id != task_id:
        return None, (jsonify({"error": "Invalid task_id"}), 400)

    results = _read_run(safe_task_id)
    if results is None:
        return None, (jsonify({"error": "Results not found or not ready"}), 404)

    metrics_path = os.path.join(
        pipeline.history_dir, safe_task_id, "technical_metrics.json"
    )
    metrics = (_read_json(metrics_path) or {}).get("metrics", {})
    return {**results, "metrics": metrics}, None


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

    Expects a JSON payload with judge, candidates, an optional base_rationale,
    an optional judge_cloud flag (parallel grading by a cloud judge) and a list
    of test_cases (question, optional tag, specific_rationale and reference).
    Every model must be installed in Ollama.

    Returns:
        Response: A JSON response containing the generated task_id and status,
            or a 400 response describing what is wrong with the payload.
    """
    data = request.json
    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    error = _validate_payload(data)
    if error:
        return jsonify({"error": error}), 400

    installed = ollama_client.get_models()
    missing = [
        model
        for model in dict.fromkeys([data["judge"], *data["candidates"]])
        if model not in installed
    ]
    if missing:
        return jsonify(
            {"error": f"Models are not installed: {', '.join(missing)}."}
        ), 400

    first_tag = _sanitize_tag(data["test_cases"][0].get("tag", "run"))
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    task_id = f"run_{first_tag}_{timestamp}"

    # Initialize the task with an empty event list.
    TASKS[task_id] = {
        "status": "started",
        "events": [{"type": "info", "message": "Task queued for execution."}],
    }

    # Start the evaluation pipeline in a background thread.
    thread = threading.Thread(target=_run_task, args=(task_id, data))
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
        last_sent = time.monotonic()
        while True:
            # Yield new events as they become available in the memory buffer.
            if idx < len(task["events"]):
                event = task["events"][idx]
                yield f"data: {json.dumps(event)}\n\n"
                last_sent = time.monotonic()

                # Stop streaming if the task has finished or failed.
                if event.get("type") in ["completed", "error"]:
                    break
                idx += 1
            else:
                # A comment line: EventSource ignores it, but the write fails
                # when the client is gone, which ends this generator.
                if time.monotonic() - last_sent >= HEARTBEAT_SEC:
                    yield ": ping\n\n"
                    last_sent = time.monotonic()
                # Sleep briefly to avoid CPU spinning while waiting for events.
                time.sleep(0.5)

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/history", methods=["GET"])
def get_history():
    """Retrieves a list of all past evaluations stored on disk.

    Runs that are not schema v2 (old format, corrupted files) are skipped.

    Returns:
        Response: A JSON list of historical run metadata, sorted by newest first.
    """
    if not os.path.isdir(pipeline.history_dir):
        return jsonify([])

    runs = []
    for task_id in os.listdir(pipeline.history_dir):
        data = _read_run(task_id)
        if data is None:
            continue

        tag_name, timestamp = _parse_task_id(task_id)
        runs.append(
            {
                "task_id": task_id,
                "tag_name": tag_name,
                "timestamp": timestamp,
                "models_tested": len(data["summary"]["models"]),
                "questions_count": len(data["questions_results"]),
                "judge_model": data["judge_model"],
            }
        )

    # Sort by task_id descending (newest first).
    runs.sort(key=lambda x: x["task_id"], reverse=True)
    return jsonify(runs), 200


@app.route("/api/results/<task_id>", methods=["GET"])
def get_results(task_id: str):
    """Returns the saved results of a run together with its technical metrics.

    The body is the content of evaluation_results.json (questions_results with
    per-model answers and grades, plus the summary) and a `metrics` object keyed
    by model name. The client groups it per model or per question.

    Args:
        task_id (str): The unique identifier of the completed task.

    Returns:
        Response: A JSON object with the results and metrics.
    """
    data, error = _load_run(task_id)
    if error:
        return error
    return jsonify(data), 200


@app.route("/api/results/<task_id>/export", methods=["GET"])
def export_results(task_id: str):
    """Downloads a saved run as json, csv or Markdown.

    The format comes from the `format` query parameter (json, csv or md). The
    json export has the same body as /api/results/<task_id>. The aggregates are
    the ones saved in the run; nothing is recomputed.

    Args:
        task_id (str): The unique identifier of the completed task.

    Returns:
        Response: The file as an attachment, or a JSON error (400 for an
            invalid task_id or an unknown format, 404 for a missing run).
    """
    fmt = request.args.get("format", "")
    if fmt not in _EXPORTS:
        return jsonify({"error": "Unknown format. Use json, csv or md."}), 400

    data, error = _load_run(task_id)
    if error:
        return error

    render, mimetype = _EXPORTS[fmt]
    response = Response(render(data), mimetype=mimetype)
    # task_id passed the secure_filename check, so it is safe in a header.
    response.headers["Content-Disposition"] = f'attachment; filename="{task_id}.{fmt}"'
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/health")
def health_check():
    """Checks the health status of the service.

    Returns:
        A tuple containing a dictionary with the status and an HTTP 200 code.
    """
    return {"status": "ok"}, 200


if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "False").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
