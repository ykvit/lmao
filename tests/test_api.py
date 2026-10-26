"""
Unit tests for the Flask API endpoints.

The Ollama client and the evaluation thread are mocked, and every test runs in
an empty temporary working directory (see ``conftest.py``), so nothing here
touches a real Ollama or the real ``history/`` folder.
"""

import json
import re
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


def test_evaluate_rejects_non_json_request(client):
    response = client.post("/api/evaluate", data="not json")

    assert response.status_code == 415


def test_evaluate_starts_background_task(client):
    payload = {
        "judge": "j",
        "candidates": ["m"],
        "test_cases": [{"tag": "My Tag!", "question": "Q"}],
    }

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
    assert kwargs["target"] == app_module.pipeline.run_evaluation
    assert kwargs["args"] == (task_id, payload, app_module.update_task_status)
    assert thread_cls.return_value.daemon is True
    thread_cls.return_value.start.assert_called_once_with()


@pytest.mark.parametrize("test_cases", [None, [], [{"tag": 123}], [{"tag": "  "}]])
def test_evaluate_uses_default_tag_when_none_is_usable(client, test_cases):
    payload = {"judge": "j", "candidates": ["m"]}
    if test_cases is not None:
        payload["test_cases"] = test_cases

    with patch.object(app_module.threading, "Thread"):
        response = client.post("/api/evaluate", json=payload)

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


# --- /api/history -----------------------------------------------------------


def test_history_is_empty_without_history_directory(client):
    response = client.get("/api/history")

    assert response.status_code == 200
    assert response.get_json() == []


def test_history_lists_run_metadata(client):
    _write_json(
        Path("history/run_python_test_20260101_120000/evaluation_results.json"),
        {
            "judge_model": "judge-model",
            "questions_results": [
                {"results": [{}, {}]},
                {"results": [{}, {}]},
            ],
        },
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
        _write_json(
            Path("history") / task_id / "evaluation_results.json",
            {"questions_results": []},
        )

    response = client.get("/api/history")

    assert [run["task_id"] for run in response.get_json()] == [
        "run_a_20260102_000000",
        "run_a_20260101_000000",
    ]


def test_history_uses_defaults_for_sparse_or_oddly_named_runs(client):
    _write_json(Path("history/weird/evaluation_results.json"), {})
    _write_json(
        Path("history/run_x_notadate_nottime/evaluation_results.json"),
        {"questions_results": []},
    )

    runs = {run["task_id"]: run for run in client.get("/api/history").get_json()}

    assert runs["weird"] == {
        "task_id": "weird",
        "tag_name": "weird",
        "timestamp": "Unknown",
        "models_tested": 0,
        "questions_count": 0,
        "judge_model": "Unknown Judge",
    }
    assert runs["run_x_notadate_nottime"]["tag_name"] == "X"
    assert runs["run_x_notadate_nottime"]["timestamp"] == "notadate nottime"


def test_history_skips_corrupted_and_incomplete_entries(client):
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


def test_results_groups_evaluations_by_model(client):
    task_id = "run_x_20260101_000000"
    run_dir = Path("history") / task_id
    _write_json(
        run_dir / "technical_metrics.json",
        {
            "task_id": task_id,
            "metrics": {
                "m1": {"tokens_per_second": 10.0},
                "m2": {"tokens_per_second": 20.0},
            },
        },
    )
    questions = []
    for number in (1, 2):
        questions.append(
            {
                "tag": f"t{number}",
                "question": f"Q{number}",
                "results": [
                    {
                        "model_name": "m1",
                        "clean_answer": f"A{number}",
                        "judge_evaluation": {"score": 90, "comment": "good"},
                    },
                    {
                        "model_name": "m2",
                        "clean_answer": f"B{number}",
                        "error": "judge failed",
                        "judge_evaluation": {"score": 0, "comment": "SYSTEM ERROR"},
                    },
                ],
            }
        )
    _write_json(
        run_dir / "evaluation_results.json",
        {"final_summary": "## done", "questions_results": questions},
    )

    response = client.get(f"/api/results/{task_id}")

    assert response.status_code == 200
    body = response.get_json()
    assert body["task_id"] == task_id
    assert body["final_summary"] == "## done"
    m1, m2 = body["results"]
    assert (m1["model_name"], m2["model_name"]) == ("m1", "m2")
    assert m1["metrics"] == {"tokens_per_second": 10.0}
    assert [e["question"] for e in m1["evaluations"]] == ["Q1", "Q2"]
    assert m1["evaluations"][0] == {
        "tag": "t1",
        "question": "Q1",
        "clean_answer": "A1",
        "error": None,
        "judge_evaluation": {"score": 90, "comment": "good"},
    }
    assert m2["evaluations"][0]["error"] == "judge failed"


def test_results_fills_defaults_and_skips_entries_without_model(client):
    task_id = "run_x_20260101_000000"
    run_dir = Path("history") / task_id
    _write_json(run_dir / "technical_metrics.json", {"metrics": {}})
    _write_json(
        run_dir / "evaluation_results.json",
        {"questions_results": [{"results": [{"model_name": "m"}, {"foo": "bar"}]}]},
    )

    body = client.get(f"/api/results/{task_id}").get_json()

    assert body["final_summary"] == "Summary not available."
    [model] = body["results"]
    assert model["model_name"] == "m"
    assert model["metrics"] == {}
    assert model["evaluations"] == [
        {
            "tag": "General",
            "question": None,
            "clean_answer": "Error/Empty",
            "error": None,
            "judge_evaluation": {"score": 0, "comment": "No evaluation provided."},
        }
    ]
