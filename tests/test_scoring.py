"""
Unit tests for the aggregation and recommendation rules.
"""

import pytest

from core.prompts import CATEGORIES
from core.scoring import (
    CONFIDENCE_HIGH,
    CONFIDENCE_LOW,
    CRITICAL_BELOW,
    MIN_QUESTIONS,
    PASS_MIN_SCORE,
    RULE_FASTEST_ABOVE_THRESHOLD,
    RULE_HIGHEST_MEDIAN,
    RULE_NONE_GRADED,
    STATUS_GENERATION_ERROR,
    STATUS_JUDGE_ERROR,
    STATUS_OK,
    STATUS_TRUNCATED,
    recommend,
    summarize_model,
)


def _entry(status=STATUS_OK, score=80, no_reference=False, tps=50.0, time_sec=2.0):
    return {
        "status": status,
        "score": score,
        "no_reference": no_reference,
        "tps": tps,
        "time_sec": time_sec,
    }


def _scored(*scores):
    return [_entry(score=score) for score in scores]


def _stats(model, n=MIN_QUESTIONS, median=80, pass_rate=1.0, time_sec=2.0):
    return {
        "model": model,
        "n": n,
        "median": median,
        "pass_rate": pass_rate,
        "median_time_sec": time_sec,
    }


# --- thresholds -------------------------------------------------------------


def test_thresholds_match_the_rubric():
    low = {category.id: category.low for category in CATEGORIES}

    assert PASS_MIN_SCORE == low["acceptable"]
    assert CRITICAL_BELOW == low["instruction_violation"]


# --- summarize_model --------------------------------------------------------


def test_summarize_counts_buckets_median_and_pass_rate():
    result = summarize_model("m", _scored(95, 75, 55, 30))

    assert result["n"] == 4
    assert result["median"] == 65
    assert result["pass_rate"] == 0.5
    assert result["fails"] == 1
    assert result["critical_fails"] == 1


@pytest.mark.parametrize(
    "score, pass_rate, fails, critical",
    [(70, 1.0, 0, 0), (69, 0.0, 1, 0), (40, 0.0, 1, 0), (39, 0.0, 0, 1)],
)
def test_summarize_bucket_boundaries(score, pass_rate, fails, critical):
    result = summarize_model("m", _scored(score))

    assert result["pass_rate"] == pass_rate
    assert result["fails"] == fails
    assert result["critical_fails"] == critical


def test_generation_error_counts_as_zero_and_is_not_timed():
    entries = [
        _entry(score=90, tps=40.0, time_sec=4.0),
        _entry(status=STATUS_GENERATION_ERROR, score=None, tps=None, time_sec=None),
    ]

    result = summarize_model("m", entries)

    assert result["n"] == 2
    assert result["median"] == 45
    assert result["pass_rate"] == 0.5
    assert result["critical_fails"] == 1
    assert result["errors"] == 1
    assert result["median_tps"] == 40.0
    assert result["median_time_sec"] == 4.0


def test_generation_error_counts_even_without_reference():
    entry = _entry(status=STATUS_GENERATION_ERROR, score=None, no_reference=True)

    result = summarize_model("m", [entry])

    assert result["n"] == 1
    assert result["errors"] == 1
    assert result["n_no_reference"] == 0


def test_judge_error_is_excluded_from_score_but_not_from_speed():
    entries = [
        _entry(score=90, tps=10.0, time_sec=1.0),
        _entry(status=STATUS_JUDGE_ERROR, score=None, tps=30.0, time_sec=3.0),
    ]

    result = summarize_model("m", entries)

    assert result["n"] == 1
    assert result["median"] == 90
    assert result["judge_errors"] == 1
    assert result["median_tps"] == 20.0
    assert result["median_time_sec"] == 2.0


def test_answers_without_reference_are_excluded_from_the_score():
    entries = [_entry(score=90), _entry(score=10, no_reference=True)]

    result = summarize_model("m", entries)

    assert result["n"] == 1
    assert result["median"] == 90
    assert result["n_no_reference"] == 1


def test_truncated_answer_can_never_pass():
    entries = [
        _entry(status=STATUS_TRUNCATED, score=95),
        _entry(status=STATUS_TRUNCATED, score=30),
    ]

    result = summarize_model("m", entries)

    assert result["pass_rate"] == 0.0
    assert result["fails"] == 1
    assert result["critical_fails"] == 1
    assert result["median"] == 49.5


def test_speed_medians_are_rounded():
    entries = [
        _entry(tps=10.0, time_sec=1.0),
        _entry(tps=30.0, time_sec=3.0),
        _entry(tps=20.123, time_sec=2.456),
    ]

    result = summarize_model("m", entries)

    assert result["median_tps"] == 20.12
    assert result["median_time_sec"] == 2.46


def test_summarize_without_entries_has_no_numbers():
    result = summarize_model("m", [])

    assert result["n"] == 0
    assert result["median"] is None
    assert result["pass_rate"] is None
    assert result["median_tps"] is None
    assert result["median_time_sec"] is None


# --- recommend --------------------------------------------------------------


def test_recommend_picks_fastest_model_above_the_pass_rate_threshold():
    models = [
        _stats("slow-best", pass_rate=1.0, time_sec=5.0),
        _stats("fast-good", pass_rate=0.8, time_sec=2.0),
        _stats("fastest-weak", pass_rate=0.5, time_sec=1.0),
    ]

    assert recommend(models) == {
        "model": "fast-good",
        "rule": RULE_FASTEST_ABOVE_THRESHOLD,
        "confidence": CONFIDENCE_HIGH,
    }


def test_recommend_breaks_speed_ties_by_median_then_name():
    models = [
        _stats("b", median=80, time_sec=2.0),
        _stats("a", median=80, time_sec=2.0),
        _stats("c", median=70, time_sec=2.0),
    ]

    assert recommend(models)["model"] == "a"
    assert recommend([_stats("b", median=90), _stats("a", median=80)])["model"] == "b"


def test_recommend_falls_back_to_highest_median_when_nobody_qualifies():
    models = [
        _stats("a", median=60, pass_rate=0.4),
        _stats("b", median=70, pass_rate=0.6),
        _stats("c", median=70, pass_rate=0.7),
    ]

    result = recommend(models)

    assert result["model"] == "c"
    assert result["rule"] == RULE_HIGHEST_MEDIAN


def test_recommend_marks_few_questions_as_low_confidence():
    result = recommend([_stats("a", n=MIN_QUESTIONS - 1)])

    assert result["model"] == "a"
    assert result["confidence"] == CONFIDENCE_LOW


@pytest.mark.parametrize("models", [[], [_stats("a", n=0)]])
def test_recommend_without_graded_models_recommends_nothing(models):
    assert recommend(models) == {
        "model": None,
        "rule": RULE_NONE_GRADED,
        "confidence": CONFIDENCE_LOW,
    }
