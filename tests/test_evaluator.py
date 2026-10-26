"""
Unit tests for the evaluation pipeline.

The Ollama client is replaced by a scripted fake, so these tests exercise the
real orchestration, retry and parsing logic without any model. Every test runs
in a temporary working directory (see ``conftest.py``), so the pipeline's
relative ``history/`` folder is isolated.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.evaluator import EvaluationPipeline

TASK_ID = "run_test_20260101_000000"


def ok(text, tokens=100, eval_time=0.5, total=1.0):
    """A successful OllamaClient.generate() result."""
    return {
        "success": True,
        "response_text": text,
        "metrics": {
            "total_time_sec": total,
            "eval_time_sec": eval_time,
            "tokens_generated": tokens,
            "tokens_per_second": tokens / eval_time,
        },
    }


def fail(error):
    """A failed OllamaClient.generate() result."""
    return {"success": False, "error": error}


def judge_json(scores):
    """A valid judge reply for {model_name: score}."""
    return json.dumps(
        {
            "evaluations": [
                {"model_name": name, "score": score, "comment": f"about {name}"}
                for name, score in scores.items()
            ],
            "best_model": max(scores, key=scores.get),
        }
    )


class FakeOllama:
    """Scripted stand-in for OllamaClient.

    Calls with format_json=True are judge calls and consume judge_responses in
    order. Other calls to the judge model are the final summary. Everything else
    is a candidate call.
    """

    def __init__(self, candidate_results=None, judge_responses=None, summary=None):
        self.candidate_results = candidate_results or {}
        self.judge_responses = list(judge_responses or [])
        self.summary = summary or ok("## Summary")
        self.judge_calls = []
        self.summary_calls = []

    def generate(self, model, prompt, system_prompt="", format_json=False):
        if format_json:
            self.judge_calls.append(
                {"model": model, "prompt": prompt, "system_prompt": system_prompt}
            )
            return self.judge_responses.pop(0)
        if model == "judge":
            self.summary_calls.append({"prompt": prompt})
            return self.summary
        return self.candidate_results.get(model, ok("answer"))


def make_payload(**overrides):
    payload = {
        "candidates": ["cand-a", "cand-b"],
        "judge": "judge",
        "base_rationale": "Be strict.",
        "test_cases": [
            {
                "tag": "logic",
                "question": "What is 2+2?",
                "specific_rationale": "Must say 4.",
            }
        ],
    }
    payload.update(overrides)
    return payload


def run(pipeline, payload=None):
    """Runs the pipeline and returns the emitted events."""
    events = []
    pipeline.run_evaluation(
        TASK_ID,
        payload if payload is not None else make_payload(),
        lambda task_id, event: events.append(event),
    )
    return events


def load(pipeline, name):
    path = Path(pipeline.history_dir) / TASK_ID / name
    return json.loads(path.read_text(encoding="utf-8"))


# --- _remove_think_tags -----------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("<think>hmm</think>\nAnswer", "Answer"),
        ("<think>line1\nline2</think>\n\nAnswer", "Answer"),
        ("<think>a</think>x<think>b</think>y", "xy"),
        ("  plain  ", "plain"),
        ("<think>never closed", "<think>never closed"),
    ],
)
def test_remove_think_tags(raw, expected):
    pipeline = EvaluationPipeline(MagicMock())

    assert pipeline._remove_think_tags(raw) == expected


# --- _extract_json ----------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('{"a": 1}', '{"a": 1}'),
        ('  {"a": 1}\n', '{"a": 1}'),
        ('```json\n{"a": 1}\n```', '{"a": 1}'),
        ('```\n{"a": 1}\n```', '{"a": 1}'),
        ('Here you go: {"a": {"b": 2}} Hope it helps!', '{"a": {"b": 2}}'),
        ("no json at all", "no json at all"),
        ("} backwards {", "} backwards {"),
    ],
)
def test_extract_json(raw, expected):
    pipeline = EvaluationPipeline(MagicMock())

    assert pipeline._extract_json(raw) == expected


# --- _build_judge_prompt ----------------------------------------------------


def test_judge_prompt_contains_question_rationales_and_answers():
    pipeline = EvaluationPipeline(MagicMock())

    prompt = pipeline._build_judge_prompt(
        "What is 2+2?",
        "Be strict.",
        "Must say 4.",
        [{"model_name": "cand-a", "answer": "Four"}],
    )

    assert "What is 2+2?" in prompt
    assert "Be strict." in prompt
    assert "Must say 4." in prompt
    assert "--- MODEL: cand-a ---\nFour" in prompt


def test_judge_prompt_marks_missing_specific_rationale_as_none():
    pipeline = EvaluationPipeline(MagicMock())

    prompt = pipeline._build_judge_prompt("Q", "Base", "", [])

    assert "Applies to this specific question):\nNone" in prompt


# --- run_evaluation: happy path ---------------------------------------------


def test_full_run_scores_models_and_saves_results():
    ollama = FakeOllama(
        judge_responses=[ok(judge_json({"cand-a": 90, "cand-b": 40}))],
    )
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert [event["type"] for event in events] == [
        "info",
        "case_start",
        "model_start",
        "model_done",
        "model_start",
        "model_done",
        "judge_start",
        "judge_done",
        "summary_start",
        "summary_done",
        "completed",
    ]

    results = load(pipeline, "evaluation_results.json")
    assert results["task_id"] == TASK_ID
    assert results["judge_model"] == "judge"
    assert results["final_summary"] == "## Summary"
    [question] = results["questions_results"]
    assert question["tag"] == "logic"
    assert question["specific_rationale"] == "Must say 4."
    scores = {
        item["model_name"]: item["judge_evaluation"]["score"]
        for item in question["results"]
    }
    assert scores == {"cand-a": 90, "cand-b": 40}


def test_metrics_accumulate_across_test_cases():
    ollama = FakeOllama(
        judge_responses=[
            ok(judge_json({"cand-a": 90, "cand-b": 40})),
            ok(judge_json({"cand-a": 80, "cand-b": 50})),
        ],
    )
    pipeline = EvaluationPipeline(ollama)
    test_cases = [{"question": "Q1"}, {"question": "Q2", "tag": "custom"}]

    events = run(pipeline, make_payload(test_cases=test_cases))

    case_starts = [event for event in events if event["type"] == "case_start"]
    assert [(e["case"], e["total"], e["tag"]) for e in case_starts] == [
        (1, 2, "Q1"),
        (2, 2, "custom"),
    ]
    metrics = load(pipeline, "technical_metrics.json")["metrics"]
    assert metrics["cand-a"] == {
        "total_time_sec": 2.0,
        "eval_time_sec": 1.0,
        "tokens_generated": 200,
        "tokens_per_second": 200.0,
    }


def test_summary_prompt_contains_metrics():
    ollama = FakeOllama(judge_responses=[ok(judge_json({"cand-a": 90, "cand-b": 40}))])
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    [summary_call] = ollama.summary_calls
    assert "Model cand-a: generated 100 tokens at 200.0 t/s." in summary_call["prompt"]


def test_failed_summary_is_stored_as_message():
    ollama = FakeOllama(
        judge_responses=[ok(judge_json({"cand-a": 90, "cand-b": 40}))],
        summary=fail("boom"),
    )
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert events[-1]["type"] == "completed"
    results = load(pipeline, "evaluation_results.json")
    assert results["final_summary"] == "Failed to generate summary: boom"


def test_run_without_test_cases_only_writes_summary():
    pipeline = EvaluationPipeline(FakeOllama())

    events = run(pipeline, make_payload(test_cases=[]))

    assert [event["type"] for event in events] == [
        "info",
        "summary_start",
        "summary_done",
        "completed",
    ]
    assert load(pipeline, "evaluation_results.json")["questions_results"] == []


# --- run_evaluation: candidates ---------------------------------------------


def test_think_blocks_are_hidden_from_judge_but_kept_raw():
    ollama = FakeOllama(
        candidate_results={"cand-a": ok("<think>hmm</think>\nfinal answer")},
        judge_responses=[ok(judge_json({"cand-a": 90, "cand-b": 40}))],
    )
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    judge_prompt = ollama.judge_calls[0]["prompt"]
    assert "final answer" in judge_prompt
    assert "hmm" not in judge_prompt
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    cand_a = next(r for r in question["results"] if r["model_name"] == "cand-a")
    assert cand_a["clean_answer"] == "final answer"
    assert "<think>hmm</think>" in cand_a["raw_answer"]


def test_candidate_error_is_reported_and_judge_still_runs():
    ollama = FakeOllama(
        candidate_results={"cand-b": fail("oom")},
        judge_responses=[ok(judge_json({"cand-a": 90, "cand-b": 0}))],
    )
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    failed = [e for e in events if e["type"] == "model_done" and not e["success"]]
    assert failed == [
        {
            "type": "model_done",
            "case": 1,
            "model": "cand-b",
            "success": False,
            "error": "oom",
        }
    ]
    assert "Error: oom" in ollama.judge_calls[0]["prompt"]
    metrics = load(pipeline, "technical_metrics.json")["metrics"]
    assert metrics["cand-a"]["tokens_generated"] == 100
    assert metrics["cand-b"]["tokens_generated"] == 0


# --- run_evaluation: judge parsing and retries -------------------------------


def test_judge_reply_wrapped_in_markdown_is_accepted():
    reply = "Sure!\n```json\n" + judge_json({"cand-a": 90, "cand-b": 40}) + "\n```"
    ollama = FakeOllama(judge_responses=[ok(reply)])
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert len(ollama.judge_calls) == 1
    judge_done = next(e for e in events if e["type"] == "judge_done")
    assert judge_done["success"] is True


def test_judge_is_retried_with_stricter_prompt_until_json_is_valid():
    ollama = FakeOllama(
        judge_responses=[
            ok("not json"),
            ok('{"foo": 1}'),
            ok(judge_json({"cand-a": 90, "cand-b": 40})),
        ],
    )
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert len(ollama.judge_calls) == 3
    assert "WARNING" not in ollama.judge_calls[0]["system_prompt"]
    assert "WARNING" in ollama.judge_calls[1]["system_prompt"]
    assert "WARNING" in ollama.judge_calls[2]["system_prompt"]
    judge_done = next(e for e in events if e["type"] == "judge_done")
    assert judge_done["success"] is True
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    assert [r["judge_evaluation"]["score"] for r in question["results"]] == [90, 40]


def test_judge_gives_up_after_three_invalid_replies():
    ollama = FakeOllama(judge_responses=[ok("not json")] * 3)
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert len(ollama.judge_calls) == 3
    judge_done = next(e for e in events if e["type"] == "judge_done")
    assert judge_done["success"] is False
    assert judge_done["error"].startswith("Invalid JSON format")
    assert events[-1]["type"] == "completed"
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    for item in question["results"]:
        assert item["judge_evaluation"] == {"score": 0, "comment": "SYSTEM ERROR"}
        assert item["error"].startswith("Invalid JSON format")
        assert item["clean_answer"] == "answer"


def test_judge_reply_without_evaluations_is_an_error():
    ollama = FakeOllama(judge_responses=[ok('{"foo": 1}')] * 3)
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    assert question["results"][0]["error"] == "JSON missing 'evaluations' array."


def test_judge_call_failure_is_reported_as_error():
    ollama = FakeOllama(judge_responses=[fail("timeout")] * 3)
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    judge_done = next(e for e in events if e["type"] == "judge_done")
    assert judge_done == {
        "type": "judge_done",
        "case": 1,
        "model": "judge",
        "success": False,
        "error": "timeout",
    }


def test_model_missing_from_judge_reply_gets_zero_score():
    ollama = FakeOllama(judge_responses=[ok(judge_json({"cand-a": 80}))])
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    cand_b = next(r for r in question["results"] if r["model_name"] == "cand-b")
    assert cand_b["judge_evaluation"] == {
        "score": 0,
        "comment": "Judge omitted this model.",
    }
