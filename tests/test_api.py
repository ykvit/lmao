"""
Unit tests for the Flask API endpoints.

The Ollama client and the evaluation thread are mocked, and every test runs in
an empty temporary working directory (see ``conftest.py``), so nothing here
touches a real Ollama or the real ``history/`` folder.
"""

import json
import re
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import app as app_module


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _parse_sse(response):
    body = response.get_data(as_text=True)
    return [
        json.loads(line[len("data: ") :])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


def _run(judge="judge-model", models=("m1", "m2"), questions=2):
    """The parts of a schema v2 evaluation_results.json the API reads."""
    return {
        "schema_version": 2,
        "judge_model": judge,
        "questions_results": [
            {"id": f"q{number}", "results": []} for number in range(1, questions + 1)
        ],
        "summary": {
            "models": [{"model": model} for model in models],
            "recommendation": {},
            "text": "",
        },
    }


def _payload(**overrides):
    payload = {
        "judge": "j",
        "candidates": ["m"],
        "test_cases": [{"tag": "My Tag!", "question": "Q"}],
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def installed_models():
    with patch.object(app_module.ollama_client, "get_models", return_value=["j", "m"]):
        yield


# --- health and index -------------------------------------------------------


def test_health_check_returns_200(client):
    """
    Test that the /health endpoint returns a 200 OK status
    and the correct JSON response.
    """
    response = client.get("/health")

    assert response.status_code == 200
    assert response.is_json
    assert response.get_json() == {"status": "ok"}


def test_index_page_loads(client):
    """
    Test that the root URL (/) serves the index.html page.
    """
    response = client.get("/")

    assert response.status_code == 200
    # The response should contain some standard HTML tags
    assert b"<!DOCTYPE html>" in response.data or b"<html" in response.data


# --- helpers ----------------------------------------------------------------


@pytest.mark.parametrize(
    "tag, expected",
    [
        ("", "run"),
        ("   ", "run"),
        (None, "run"),
        (42, "run"),
        ("python_test", "python_test"),
        ("My Tag!", "My_Tag_"),
        ("../etc/passwd", "___etc_passwd"),
        ("x" * 60, "x" * 40),
    ],
)
def test_sanitize_tag(tag, expected):
    assert app_module._sanitize_tag(tag) == expected


def test_update_task_status_appends_event_with_timestamp():
    app_module.TASKS["t"] = {"status": "started", "events": []}

    app_module.update_task_status("t", {"type": "info", "message": "hi"})

    [event] = app_module.TASKS["t"]["events"]
    assert event["message"] == "hi"
    assert "timestamp" in event
    assert app_module.TASKS["t"]["status"] == "started"


@pytest.mark.parametrize("final_type", ["completed", "error"])
def test_update_task_status_marks_task_finished(final_type):
    app_module.TASKS["t"] = {"status": "started", "events": []}

    app_module.update_task_status("t", {"type": final_type, "message": "x"})

    assert app_module.TASKS["t"]["status"] == final_type


def test_update_task_status_ignores_unknown_task():
    app_module.update_task_status("missing", {"type": "info"})

    assert app_module.TASKS == {}


def test_run_task_runs_the_pipeline():
    with patch.object(app_module.pipeline, "run_evaluation") as run_evaluation:
        app_module._run_task("t", {"judge": "j"})

    run_evaluation.assert_called_once_with(
        "t", {"judge": "j"}, app_module.update_task_status
    )


def test_run_task_reports_a_crash_to_the_stream():
    app_module.TASKS["t"] = {"status": "started", "events": []}

    with patch.object(
        app_module.pipeline, "run_evaluation", side_effect=RuntimeError("boom")
    ):
        app_module._run_task("t", {})

    [event] = app_module.TASKS["t"]["events"]
    assert event["type"] == "error"
    assert "boom" in event["message"]
    assert app_module.TASKS["t"]["status"] == "error"


# --- /api/models ------------------------------------------------------------


def test_models_endpoint_returns_installed_models(client):
    with patch.object(
        app_module.ollama_client, "get_models", return_value=["a:1b", "b:2b"]
    ):
        response = client.get("/api/models")

    assert response.status_code == 200
    assert response.get_json() == {"models": ["a:1b", "b:2b"]}


def test_models_endpoint_returns_empty_list_when_ollama_is_down(client):
    with patch.object(app_module.ollama_client, "get_models", return_value=[]):
        response = client.get("/api/models")

    assert response.status_code == 200
    assert response.get_json() == {"models": []}


# --- /api/evaluate ----------------------------------------------------------


def test_evaluate_rejects_empty_payload(client):
    response = client.post("/api/evaluate", json={})

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid JSON payload"}


def test_evaluate_rejects_non_object_payload(client):
    response = client.post("/api/evaluate", json=[1, 2])

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid JSON payload"}


def test_evaluate_rejects_non_json_request(client):
    response = client.post("/api/evaluate", data="not json")

    assert response.status_code == 415


@pytest.mark.parametrize(
    "overrides",
    [
        {"judge": None},
        {"judge": ""},
        {"judge": 5},
        {"candidates": []},
        {"candidates": "m"},
        {"candidates": [1]},
        {"test_cases": []},
        {"test_cases": ["Q"]},
        {"test_cases": [{"question": "  "}]},
        {"test_cases": [{"question": 5}]},
        {"test_cases": [{"question": "Q", "tag": 5}]},
        {"test_cases": [{"question": "Q", "reference": None}]},
        {"base_rationale": 5},
        {"judge_cloud": "yes"},
    ],
)
def test_evaluate_rejects_invalid_payload(client, overrides):
    response = client.post("/api/evaluate", json=_payload(**overrides))

    assert response.status_code == 400
    assert response.get_json()["error"]
    assert app_module.TASKS == {}


def test_evaluate_rejects_models_that_are_not_installed(client):
    with patch.object(app_module.ollama_client, "get_models", return_value=["j"]):
        response = client.post("/api/evaluate", json=_payload())

    assert response.status_code == 400
    assert response.get_json() == {"error": "Models are not installed: m."}
    assert app_module.TASKS == {}


def test_evaluate_starts_background_task(client, installed_models):
    payload = _payload()

    with patch.object(app_module.threading, "Thread") as thread_cls:
        response = client.post("/api/evaluate", json=payload)

    assert response.status_code == 202
    body = response.get_json()
    assert body["status"] == "started"
    task_id = body["task_id"]
    assert re.fullmatch(r"run_My_Tag__\d{8}_\d{6}", task_id)
    assert app_module.TASKS[task_id]["status"] == "started"
    assert app_module.TASKS[task_id]["events"][0]["type"] == "info"

    thread_cls.assert_called_once()
    kwargs = thread_cls.call_args.kwargs
    assert kwargs["target"] == app_module._run_task
    assert kwargs["args"] == (task_id, payload)
    assert thread_cls.return_value.daemon is True
    thread_cls.return_value.start.assert_called_once_with()


def test_evaluate_accepts_the_cloud_judge_flag(client, installed_models):
    with patch.object(app_module.threading, "Thread"):
        response = client.post("/api/evaluate", json=_payload(judge_cloud=True))

    assert response.status_code == 202


@pytest.mark.parametrize(
    "test_cases",
    [[{"question": "Q"}], [{"question": "Q", "tag": "  "}]],
)
def test_evaluate_uses_default_tag_when_none_is_usable(
    client, installed_models, test_cases
):
    with patch.object(app_module.threading, "Thread"):
        response = client.post("/api/evaluate", json=_payload(test_cases=test_cases))

    assert response.status_code == 202
    assert re.fullmatch(r"run_run_\d{8}_\d{6}", response.get_json()["task_id"])


# --- /api/stream ------------------------------------------------------------


def test_stream_reports_unknown_task(client):
    response = client.get("/api/stream/nope")

    assert response.mimetype == "text/event-stream"
    assert _parse_sse(response) == [{"type": "error", "message": "Task not found"}]


def test_stream_replays_events_until_completion(client):
    app_module.TASKS["t1"] = {
        "status": "completed",
        "events": [
            {"type": "info", "message": "start"},
            {"type": "completed", "message": "done"},
            {"type": "info", "message": "never sent"},
        ],
    }

    response = client.get("/api/stream/t1")

    assert response.mimetype == "text/event-stream"
    assert [event["type"] for event in _parse_sse(response)] == ["info", "completed"]


def test_stream_stops_on_error_event(client):
    app_module.TASKS["t2"] = {
        "status": "error",
        "events": [{"type": "error", "message": "boom"}],
    }

    response = client.get("/api/stream/t2")

    assert _parse_sse(response) == [{"type": "error", "message": "boom"}]


def test_stream_sends_heartbeats_while_waiting(client, monkeypatch):
    monkeypatch.setattr(app_module, "HEARTBEAT_SEC", 0)
    app_module.TASKS["t"] = {"status": "started", "events": []}

    def finish():
        time.sleep(0.2)
        app_module.update_task_status("t", {"type": "completed", "message": "done"})

    worker = threading.Thread(target=finish)
    worker.start()
    body = client.get("/api/stream/t").get_data(as_text=True)
    worker.join()

    assert ": ping" in body
    assert '"type": "completed"' in body


# --- /api/history -----------------------------------------------------------


def test_history_is_empty_without_history_directory(client):
    response = client.get("/api/history")

    assert response.status_code == 200
    assert response.get_json() == []


def test_history_lists_run_metadata(client):
    _write_json(
        Path("history/run_python_test_20260101_120000/evaluation_results.json"),
        _run(),
    )

    response = client.get("/api/history")

    assert response.get_json() == [
        {
            "task_id": "run_python_test_20260101_120000",
            "tag_name": "Python Test",
            "timestamp": "2026-01-01 12:00",
            "models_tested": 2,
            "questions_count": 2,
            "judge_model": "judge-model",
        }
    ]


def test_history_is_sorted_newest_first(client):
    for task_id in ("run_a_20260101_000000", "run_a_20260102_000000"):
        _write_json(Path("history") / task_id / "evaluation_results.json", _run())

    response = client.get("/api/history")

    assert [run["task_id"] for run in response.get_json()] == [
        "run_a_20260102_000000",
        "run_a_20260101_000000",
    ]


def test_history_copes_with_oddly_named_runs(client):
    _write_json(Path("history/weird/evaluation_results.json"), _run())
    _write_json(Path("history/run_x_notadate_nottime/evaluation_results.json"), _run())

    runs = {run["task_id"]: run for run in client.get("/api/history").get_json()}

    assert runs["weird"]["tag_name"] == "weird"
    assert runs["weird"]["timestamp"] == "Unknown"
    assert runs["run_x_notadate_nottime"]["tag_name"] == "X"
    assert runs["run_x_notadate_nottime"]["timestamp"] == "notadate nottime"


def test_history_skips_legacy_corrupted_and_incomplete_entries(client):
    _write_json(
        Path("history/run_old_20260101_000000/evaluation_results.json"),
        {"questions_results": []},
    )
    _write_json(
        Path("history/run_v1_20260101_000000/evaluation_results.json"),
        {**_run(), "schema_version": 1},
    )
    broken = Path("history/run_broken_20260101_000000/evaluation_results.json")
    broken.parent.mkdir(parents=True)
    broken.write_text("{not json", encoding="utf-8")
    Path("history/run_empty_20260101_000000").mkdir()
    Path("history/readme.txt").write_text("not a run", encoding="utf-8")

    response = client.get("/api/history")

    assert response.status_code == 200
    assert response.get_json() == []


# --- /api/results -----------------------------------------------------------


def test_results_rejects_unsafe_task_id(client):
    response = client.get("/api/results/.hidden")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid task_id"}


def test_results_returns_404_when_run_is_missing(client):
    response = client.get("/api/results/run_x_20260101_000000")

    assert response.status_code == 404
    assert response.get_json() == {"error": "Results not found or not ready"}


def test_results_returns_the_run_with_metrics(client):
    task_id = "run_x_20260101_000000"
    run_dir = Path("history") / task_id
    data = _run()
    _write_json(run_dir / "evaluation_results.json", data)
    _write_json(
        run_dir / "technical_metrics.json",
        {"task_id": task_id, "metrics": {"m1": {"tokens_per_second": 10.0}}},
    )

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 200
    assert response.get_json() == {
        **data,
        "metrics": {"m1": {"tokens_per_second": 10.0}},
    }


def test_results_work_without_technical_metrics(client):
    task_id = "run_x_20260101_000000"
    _write_json(Path("history") / task_id / "evaluation_results.json", _run())

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 200
    assert response.get_json()["metrics"] == {}


def test_results_hide_legacy_runs(client):
    task_id = "run_x_20260101_000000"
    _write_json(
        Path("history") / task_id / "evaluation_results.json",
        {"questions_results": []},
    )

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 404


# --- /api/results/<id>/export -----------------------------------------------


def _save_run(task_id="run_x_20260101_000000"):
    run = _run()
    # The pipeline always writes these two next to the fields _run() has.
    run["task_id"] = task_id
    run["mode"] = "local"
    run["questions_results"][0]["tag"] = "=SUM(1+1)"
    run["questions_results"][0]["results"] = [
        {
            "model_name": "m1",
            "answer": "4",
            "status": "ok",
            "category": "perfect",
            "score": 95,
            "tps": 10.0,
            "cps": 50.0,
            "time_sec": 1.0,
        }
    ]
    run_dir = Path("history") / task_id
    _write_json(run_dir / "evaluation_results.json", run)
    _write_json(
        run_dir / "technical_metrics.json",
        {"task_id": task_id, "metrics": {"m1": {"tokens_per_second": 10.0}}},
    )
    return task_id


@pytest.mark.parametrize(
    "fmt, mimetype",
    [
        ("json", "application/json"),
        ("csv", "text/csv"),
        ("md", "text/markdown"),
    ],
)
def test_export_sends_an_attachment(client, fmt, mimetype):
    task_id = _save_run()

    response = client.get(f"/api/results/{task_id}/export?format={fmt}")

    assert response.status_code == 200
    assert response.mimetype == mimetype
    assert response.headers["Content-Disposition"] == (
        f'attachment; filename="{task_id}.{fmt}"'
    )
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_export_json_matches_the_results_endpoint(client):
    task_id = _save_run()

    exported = client.get(f"/api/results/{task_id}/export?format=json")
    results = client.get(f"/api/results/{task_id}")

    assert exported.get_json() == results.get_json()


def test_export_csv_has_one_row_per_answer_and_defuses_formulas(client):
    task_id = _save_run()

    body = client.get(f"/api/results/{task_id}/export?format=csv").get_data(
        as_text=True
    )

    lines = body.splitlines()
    assert lines[0] == "question,tag,model,score,category,status,tps,cps,time_sec"
    assert lines[1] == "q1,'=SUM(1+1),m1,95,perfect,ok,10.0,50.0,1.0"
    assert len(lines) == 2


def test_export_markdown_contains_the_report(client):
    task_id = _save_run()

    body = client.get(f"/api/results/{task_id}/export?format=md").get_data(as_text=True)

    assert body.startswith(f"# {task_id}\n")
    assert "#### m1" in body


@pytest.mark.parametrize("query", ["", "?format=", "?format=xml", "?format=CSV"])
def test_export_rejects_a_missing_or_unknown_format(client, query):
    task_id = _save_run()

    response = client.get(f"/api/results/{task_id}/export{query}")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Unknown format. Use json, csv or md."}


def test_export_rejects_unsafe_task_id(client):
    response = client.get("/api/results/.hidden/export?format=csv")

    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid task_id"}


def test_export_returns_404_for_missing_and_legacy_runs(client):
    task_id = "run_old_20260101_000000"
    _write_json(
        Path("history") / task_id / "evaluation_results.json",
        {"questions_results": []},
    )

    missing = client.get("/api/results/run_x_20260101_000000/export?format=csv")
    legacy = client.get(f"/api/results/{task_id}/export?format=csv")

    assert missing.status_code == 404
    assert legacy.status_code == 404
    assert legacy.get_json() == {"error": "Results not found or not ready"}
