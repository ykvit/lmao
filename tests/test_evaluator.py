"""
Unit tests for the evaluation pipeline.

The Ollama client is replaced by a scripted fake that also tracks which models
are loaded, so these tests exercise the real orchestration, retry and parsing
logic without any model. Every test runs in a temporary working directory (see
``conftest.py``), so the pipeline's relative ``history/`` folder is isolated.
"""

import json
import threading
from collections import Counter
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.evaluator import JUDGE_NUM_CTX, JUDGE_SEED, EvaluationPipeline
from core.prompts import (
    CATEGORIES,
    GRADE_SCHEMA,
    GRADER_SYSTEM,
    REFERENCE_SYSTEM,
    SUMMARY_SYSTEM,
    build_answer_prompt,
)

TASK_ID = "run_test_20260101_000000"


def ok(
    text,
    tokens=100,
    eval_time=0.5,
    total=1.0,
    load=0.2,
    done="stop",
    prompt_tokens=100,
):
    """A successful OllamaClient.generate() result."""
    return {
        "success": True,
        "response_text": text,
        "done_reason": done,
        "prompt_eval_count": prompt_tokens,
        "metrics": {
            "total_time_sec": total,
            "load_time_sec": load,
            "eval_time_sec": eval_time,
            "tokens_generated": tokens,
            "tokens_per_second": tokens / eval_time,
        },
    }


def fail(error):
    """A failed OllamaClient.generate() result."""
    return {"success": False, "error": error}


def grade_json(score, comment="fine"):
    """A valid judge reply for a score; the category is derived from it."""
    category = next(c.id for c in CATEGORIES if c.low <= score <= c.high)
    return json.dumps({"comment": comment, "category": category, "score": score})


class FakeOllama:
    """Scripted, thread-safe stand-in for OllamaClient that tracks loaded models.

    Calls are routed by their system prompt and format: reference calls consume
    ``references``, calls with the grade schema consume ``grades`` in order, the
    summary call returns ``summary`` and everything else is a candidate call.
    A scripted value may be an exception, which is raised. Candidates listed in
    ``wait_for_grading`` block until some grading call has happened, which
    proves that grading runs while candidates are still generating.
    """

    def __init__(
        self,
        answers=None,
        grades=None,
        references=None,
        summary=None,
        wait_for_grading=(),
    ):
        self.answers = answers or {}
        self.grades = list(grades or [])
        self.references = list(references or [])
        self.summary = summary or ok("## Summary")
        self.wait_for_grading = set(wait_for_grading)
        self.reference_calls = []
        self.grading_calls = []
        self.summary_calls = []
        self.candidate_calls = []
        self.loaded = set()
        self.loads = {}
        self.unloaded = []
        self.max_loaded = 0
        self.graded = threading.Event()
        self._lock = threading.Lock()

    def generate(
        self,
        model,
        prompt,
        system_prompt="",
        format=None,
        think=None,
        options=None,
        keep_alive=0,
        timeout=None,
    ):
        call = {
            "model": model,
            "prompt": prompt,
            "system_prompt": system_prompt,
            "think": think,
            "options": options,
        }
        with self._lock:
            if model not in self.loaded:
                self.loads[model] = self.loads.get(model, 0) + 1
                self.loaded.add(model)
            self.max_loaded = max(self.max_loaded, len(self.loaded))

            if system_prompt == REFERENCE_SYSTEM:
                self.reference_calls.append(call)
                return self._next(self.references, ok("reference answer"))
            if system_prompt == SUMMARY_SYSTEM:
                self.summary_calls.append(call)
                return self.summary
            if format == GRADE_SCHEMA:
                self.grading_calls.append(call)
                self.graded.set()
                return self._next(self.grades, ok(grade_json(80)))

            self.candidate_calls.append(call)
            scripted = self.answers.get(model, ok("answer"))

        if model in self.wait_for_grading:
            assert self.graded.wait(timeout=5), "grading did not run in parallel"
        if isinstance(scripted, Exception):
            raise scripted
        return scripted

    def unload(self, model):
        with self._lock:
            self.loaded.discard(model)
            self.unloaded.append(model)
        return True

    @staticmethod
    def _next(queue, default):
        item = queue.pop(0) if queue else default
        if isinstance(item, Exception):
            raise item
        return item


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


def results_by_model(pipeline, question=0):
    questions = load(pipeline, "evaluation_results.json")["questions_results"]
    return {r["model_name"]: r for r in questions[question]["results"]}


def summary_by_model(pipeline):
    summary = load(pipeline, "evaluation_results.json")["summary"]
    return {m["model"]: m for m in summary["models"]}


def two_questions(**overrides):
    test_cases = [{"question": "Q1"}, {"question": "Q2"}]
    return make_payload(test_cases=test_cases, **overrides)


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


# --- happy path -------------------------------------------------------------


def test_full_run_emits_events_and_saves_results():
    ollama = FakeOllama(grades=[ok(grade_json(90)), ok(grade_json(40))])
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    assert [event["type"] for event in events] == [
        "reference_start",
        "reference_done",
        "candidate_start",
        "answer_start",
        "answer_done",
        "candidate_start",
        "answer_start",
        "answer_done",
        "grading_start",
        "grading_done",
        "grading_start",
        "grading_done",
        "summary_start",
        "summary_done",
        "completed",
    ]
    assert events[4] == {
        "type": "answer_done",
        "phase": "answer",
        "model": "cand-a",
        "question": "q1",
        "progress": {"done": 2, "total": 6},
        "success": True,
        "error": None,
    }
    assert events[-2]["progress"] == {"done": 6, "total": 6}

    results = load(pipeline, "evaluation_results.json")
    assert results["schema_version"] == 2
    assert results["task_id"] == TASK_ID
    assert results["judge_model"] == "judge"
    assert results["mode"] == "local"
    assert results["judge_is_candidate"] is False
    assert "finished_at" in results

    [question] = results["questions_results"]
    assert question["id"] == "q1"
    assert question["tag"] == "logic"
    assert question["specific_rationale"] == "Must say 4."
    assert question["reference"] == {"text": "reference answer", "source": "generated"}
    assert question["no_reference"] is False
    assert question["results"][0] == {
        "model_name": "cand-a",
        "answer": "answer",
        "status": "ok",
        "category": "perfect",
        "score": 90,
        "comment": "fine",
        "truncated": False,
        "done_reason": "stop",
        "error": None,
        "tps": 200.0,
        "cps": 12.0,
        "time_sec": 0.8,
    }
    assert question["results"][1]["category"] == "instruction_violation"

    summary = results["summary"]
    assert summary["text"] == "## Summary"
    assert summary["recommendation"] == {
        "model": "cand-a",
        "rule": "fastest_above_threshold",
        "confidence": "low",
    }
    stats = summary_by_model(pipeline)
    assert (stats["cand-a"]["median"], stats["cand-a"]["pass_rate"]) == (90, 1.0)
    assert (stats["cand-b"]["median"], stats["cand-b"]["fails"]) == (40, 1)
    assert (stats["cand-a"]["mean"], stats["cand-b"]["mean"]) == (90, 40)


def test_questions_get_ids_and_default_tags_and_metrics_accumulate():
    pipeline = EvaluationPipeline(FakeOllama())
    test_cases = [{"question": "Q1"}, {"question": "Q2", "tag": "custom"}]

    run(pipeline, make_payload(test_cases=test_cases))

    questions = load(pipeline, "evaluation_results.json")["questions_results"]
    assert [(q["id"], q["tag"]) for q in questions] == [("q1", "Q1"), ("q2", "custom")]

    technical = load(pipeline, "technical_metrics.json")
    assert technical["judge_model"] == "judge"
    assert technical["mode"] == "local"
    assert technical["metrics"]["cand-a"] == {
        "total_time_sec": 2.0,
        "load_time_sec": 0.4,
        "eval_time_sec": 1.0,
        "tokens_generated": 200,
        "tokens_per_second": 200.0,
    }


def test_candidates_get_a_length_limited_prompt_without_thinking():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama))

    for call in ollama.candidate_calls:
        assert call["prompt"] == build_answer_prompt("What is 2+2?")
        assert call["think"] is False
        assert call["options"] == {"num_predict": 1000}


def test_chars_per_second_counts_the_cleaned_answer():
    ollama = FakeOllama(
        answers={"cand-a": ok("<think>hmm</think>\nfinal answer", eval_time=0.5)}
    )
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    assert results_by_model(pipeline)["cand-a"]["cps"] == 24.0
    assert summary_by_model(pipeline)["cand-a"]["median_cps"] == 24.0


# --- model loading ----------------------------------------------------------


def test_models_are_loaded_once_and_never_together():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama), two_questions())

    # The judge is loaded twice: for the references, then for grading and summary.
    assert ollama.loads == {"judge": 2, "cand-a": 1, "cand-b": 1}
    assert ollama.max_loaded == 1
    assert ollama.loaded == set()


def test_local_mode_grades_model_by_model():
    ollama = FakeOllama()

    events = run(EvaluationPipeline(ollama), two_questions())

    graded = [
        (e["model"], e["question"]) for e in events if e["type"] == "grading_start"
    ]
    assert graded == [
        ("cand-a", "q1"),
        ("cand-a", "q2"),
        ("cand-b", "q1"),
        ("cand-b", "q2"),
    ]


def test_models_are_unloaded_when_a_call_raises():
    ollama = FakeOllama(answers={"cand-a": RuntimeError("boom")})

    with pytest.raises(RuntimeError):
        run(EvaluationPipeline(ollama))

    assert ollama.loaded == set()


def test_duplicate_candidates_are_run_once():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama), make_payload(candidates=["cand-a", "cand-a"]))

    assert ollama.loads["cand-a"] == 1
    assert len(ollama.candidate_calls) == 1


def test_judge_is_candidate_flag():
    pipeline = EvaluationPipeline(FakeOllama())

    run(pipeline, make_payload(candidates=["judge", "cand-a"]))

    results = load(pipeline, "evaluation_results.json")
    assert results["judge_is_candidate"] is True


# --- blind grading ----------------------------------------------------------


def test_judge_prompts_never_contain_model_names():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama))

    assert len(ollama.grading_calls) == 2
    for call in ollama.grading_calls:
        assert "cand-a" not in call["prompt"] + call["system_prompt"]
        assert "cand-b" not in call["prompt"] + call["system_prompt"]


def test_think_blocks_are_hidden_from_judge():
    ollama = FakeOllama(answers={"cand-a": ok("<think>hmm</think>\nfinal answer")})
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    prompt = ollama.grading_calls[0]["prompt"]
    assert "final answer" in prompt
    assert "hmm" not in prompt
    assert results_by_model(pipeline)["cand-a"]["answer"] == "final answer"


def test_truncated_answers_are_flagged_and_cannot_pass():
    ollama = FakeOllama(
        answers={
            "cand-a": ok("partial", done="length"),
            "cand-b": ok("<think>never closed"),
        },
        grades=[ok(grade_json(95)), ok(grade_json(95))],
    )
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    results = results_by_model(pipeline)
    assert results["cand-a"]["status"] == "truncated"
    assert results["cand-a"]["done_reason"] == "length"
    assert results["cand-b"]["status"] == "truncated"
    assert results["cand-b"]["truncated"] is True
    assert results["cand-a"]["score"] == 95
    assert all("cut off" in call["prompt"] for call in ollama.grading_calls)
    stats = summary_by_model(pipeline)
    assert stats["cand-a"]["pass_rate"] == 0.0
    assert stats["cand-b"]["pass_rate"] == 0.0


# --- failures ---------------------------------------------------------------


def test_generation_error_is_recorded_and_not_graded():
    ollama = FakeOllama(answers={"cand-b": fail("oom")})
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    failed = [e for e in events if e["type"] == "answer_done" and not e["success"]]
    assert [(e["model"], e["error"]) for e in failed] == [("cand-b", "oom")]
    cand_b = results_by_model(pipeline)["cand-b"]
    assert cand_b["status"] == "generation_error"
    assert cand_b["answer"] == ""
    assert cand_b["error"] == "oom"
    assert cand_b["score"] is None
    assert len(ollama.grading_calls) == 1
    stats = summary_by_model(pipeline)["cand-b"]
    assert (stats["n"], stats["median"], stats["errors"]) == (1, 0, 1)
    assert events[-2]["progress"] == {"done": 6, "total": 6}
    assert events[-1]["type"] == "completed"


def test_judge_is_retried_with_new_seed_and_error_hint():
    ollama = FakeOllama(
        grades=[ok("not json"), ok(grade_json(90)), ok(grade_json(40))],
    )
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    calls = ollama.grading_calls
    assert [c["options"]["seed"] for c in calls] == [
        JUDGE_SEED,
        JUDGE_SEED + 1,
        JUDGE_SEED,
    ]
    assert calls[0]["system_prompt"] == GRADER_SYSTEM
    assert "rejected" in calls[1]["system_prompt"]
    assert "rejected" not in calls[2]["system_prompt"]
    assert all(c["options"]["temperature"] == 0 for c in calls)
    assert results_by_model(pipeline)["cand-a"]["score"] == 90


def test_judge_gives_up_after_three_invalid_replies():
    ollama = FakeOllama(grades=[ok("not json")] * 3 + [ok(grade_json(40))])
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    graded = [e for e in events if e["type"] == "grading_done"]
    assert graded[0]["success"] is False
    assert graded[0]["error"].startswith("Invalid JSON")
    assert graded[1]["success"] is True
    cand_a = results_by_model(pipeline)["cand-a"]
    assert cand_a["status"] == "judge_error"
    assert cand_a["score"] is None
    assert cand_a["answer"] == "answer"
    stats = summary_by_model(pipeline)["cand-a"]
    assert (stats["n"], stats["median"], stats["judge_errors"]) == (0, None, 1)
    assert events[-1]["type"] == "completed"


def test_score_outside_the_category_is_rejected():
    bad = ok('{"comment": "c", "category": "perfect", "score": 10}')
    pipeline = EvaluationPipeline(FakeOllama(grades=[bad] * 3))

    run(pipeline)

    assert "outside 'perfect'" in results_by_model(pipeline)["cand-a"]["error"]


def test_judge_call_failure_is_reported():
    ollama = FakeOllama(grades=[fail("timeout")] * 3)
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    graded = next(e for e in events if e["type"] == "grading_done")
    assert (graded["success"], graded["error"]) == (False, "timeout")
    assert len(ollama.grading_calls) == 4


def test_prompt_that_overflows_the_context_is_not_retried():
    ollama = FakeOllama(
        grades=[ok(grade_json(90), prompt_tokens=JUDGE_NUM_CTX), ok(grade_json(40))]
    )
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    assert len(ollama.grading_calls) == 2
    cand_a = results_by_model(pipeline)["cand-a"]
    assert cand_a["status"] == "judge_error"
    assert "context window" in cand_a["error"]


# --- references -------------------------------------------------------------


def test_generated_reference_is_made_once_and_given_to_the_judge():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama))

    [call] = ollama.reference_calls
    assert call["model"] == "judge"
    assert call["think"] is False
    assert call["options"]["temperature"] == 0
    for grading in ollama.grading_calls:
        assert (
            "<reference_answer>\nreference answer\n</reference_answer>"
            in (grading["prompt"])
        )


def test_provided_reference_overrides_generation():
    ollama = FakeOllama()
    pipeline = EvaluationPipeline(ollama)
    test_cases = [{"question": "What is 2+2?", "reference": " Four. "}]

    events = run(pipeline, make_payload(test_cases=test_cases))

    assert ollama.reference_calls == []
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    assert question["reference"] == {"text": "Four.", "source": "provided"}
    assert question["no_reference"] is False
    done = next(e for e in events if e["type"] == "reference_done")
    assert (done["success"], done["source"]) == (True, "provided")
    assert (
        "<reference_answer>\nFour.\n</reference_answer>"
        in (ollama.grading_calls[0]["prompt"])
    )


def test_reference_generation_is_retried_once():
    ollama = FakeOllama(references=[fail("x"), ok("second try")])
    pipeline = EvaluationPipeline(ollama)

    run(pipeline)

    assert [c["options"]["seed"] for c in ollama.reference_calls] == [
        JUDGE_SEED,
        JUDGE_SEED + 1,
    ]
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    assert question["reference"] == {"text": "second try", "source": "generated"}


def test_unusable_reference_is_flagged_and_excluded_from_the_score():
    ollama = FakeOllama(references=[ok("cut", done="length"), ok("   ")])
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    done = next(e for e in events if e["type"] == "reference_done")
    assert (done["success"], done["source"]) == (False, "none")
    [question] = load(pipeline, "evaluation_results.json")["questions_results"]
    assert question["reference"] == {"text": None, "source": "none"}
    assert question["no_reference"] is True
    assert all(
        "No reference answer is available" in call["prompt"]
        for call in ollama.grading_calls
    )
    stats = summary_by_model(pipeline)["cand-a"]
    assert (stats["n"], stats["n_no_reference"]) == (0, 1)
    recommendation = load(pipeline, "evaluation_results.json")["summary"][
        "recommendation"
    ]
    assert recommendation["model"] is None


# --- summary ----------------------------------------------------------------


def test_summary_prompt_receives_python_aggregates():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama))

    [call] = ollama.summary_calls
    assert '"cand-a": graded=1, mean=80.0, median=80' in call["prompt"]
    assert 'Recommended model: "cand-a"' in call["prompt"]


def test_failed_summary_is_stored_as_message():
    ollama = FakeOllama(summary=fail("boom"))
    pipeline = EvaluationPipeline(ollama)

    events = run(pipeline)

    summary_done = next(e for e in events if e["type"] == "summary_done")
    assert summary_done["success"] is False
    assert events[-1]["type"] == "completed"
    summary = load(pipeline, "evaluation_results.json")["summary"]
    assert summary["text"] == "Failed to generate summary: boom"


# --- cloud mode -------------------------------------------------------------


def test_cloud_mode_gives_the_same_results_as_local_mode():
    local = EvaluationPipeline(FakeOllama())
    run(local, two_questions())
    local_results = load(local, "evaluation_results.json")
    local_metrics = load(local, "technical_metrics.json")

    cloud = EvaluationPipeline(FakeOllama())
    run(cloud, two_questions(judge_cloud=True))
    cloud_results = load(cloud, "evaluation_results.json")
    cloud_metrics = load(cloud, "technical_metrics.json")

    assert (local_results["mode"], cloud_results["mode"]) == ("local", "cloud")
    assert cloud_metrics["mode"] == "cloud"
    assert cloud_results["questions_results"] == local_results["questions_results"]
    assert cloud_results["summary"] == local_results["summary"]
    assert cloud_metrics["metrics"] == local_metrics["metrics"]


def test_cloud_mode_grades_while_candidates_are_still_generating():
    ollama = FakeOllama(wait_for_grading={"cand-b"})

    events = run(EvaluationPipeline(ollama), make_payload(judge_cloud=True))

    assert events[-1]["type"] == "completed"


def test_cloud_mode_only_unloads_local_candidates():
    ollama = FakeOllama()

    run(EvaluationPipeline(ollama), make_payload(judge_cloud=True))

    assert ollama.unloaded == ["cand-a", "cand-b"]
    assert ollama.loads["cand-a"] == 1
    assert ollama.loads["cand-b"] == 1


def test_cloud_mode_reports_the_same_events_with_ordered_progress():
    local_events = run(EvaluationPipeline(FakeOllama()), two_questions())

    events = run(EvaluationPipeline(FakeOllama()), two_questions(judge_cloud=True))

    assert Counter(e["type"] for e in events) == Counter(
        e["type"] for e in local_events
    )
    progress = [e["progress"]["done"] for e in events if "progress" in e]
    assert progress == sorted(progress)
    assert events[-2]["progress"] == {"done": 11, "total": 11}
    for question in ("q1", "q2"):
        reference_done = next(
            i
            for i, e in enumerate(events)
            if e["type"] == "reference_done" and e["question"] == question
        )
        first_grading = next(
            i
            for i, e in enumerate(events)
            if e["type"] == "grading_start" and e["question"] == question
        )
        assert reference_done < first_grading


def test_cloud_mode_reraises_worker_errors():
    ollama = FakeOllama(references=[RuntimeError("boom")])

    with pytest.raises(RuntimeError, match="boom"):
        run(EvaluationPipeline(ollama), make_payload(judge_cloud=True))

    assert "cand-a" not in ollama.loaded


def test_cloud_mode_reports_grading_failures():
    ollama = FakeOllama(grades=[fail("timeout")] * 3)
    pipeline = EvaluationPipeline(ollama)

    run(pipeline, make_payload(candidates=["cand-a"], judge_cloud=True))

    cand_a = results_by_model(pipeline)["cand-a"]
    assert (cand_a["status"], cand_a["error"]) == ("judge_error", "timeout")
