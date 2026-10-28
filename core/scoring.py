"""Aggregation of graded answers and the model recommendation rule.

Pure module: no I/O and no model calls. The numbers and the recommendation are
computed here in Python; the judge only retells them.
"""

import statistics

STATUS_OK = "ok"
STATUS_TRUNCATED = "truncated"
STATUS_GENERATION_ERROR = "generation_error"
STATUS_JUDGE_ERROR = "judge_error"

# Score buckets: pass >= PASS_MIN_SCORE, fail in [CRITICAL_BELOW, PASS_MIN_SCORE),
# critical fail < CRITICAL_BELOW.
PASS_MIN_SCORE = 70
CRITICAL_BELOW = 40

# A model is recommended on speed only if it passes at least this share.
PASS_RATE_THRESHOLD = 0.8
# Fewer graded questions than this means a low-confidence recommendation.
MIN_QUESTIONS = 5

RULE_FASTEST_ABOVE_THRESHOLD = "fastest_above_threshold"
RULE_HIGHEST_MEDIAN = "highest_median"
RULE_NONE_GRADED = "none_graded"

CONFIDENCE_HIGH = "high"
CONFIDENCE_LOW = "low"


def _median(values: list, digits: int):
    return round(statistics.median(values), digits) if values else None


def summarize_model(model: str, entries: list[dict]) -> dict:
    """Aggregates the answers of one model.

    Args:
        model (str): The model name.
        entries (list[dict]): One entry per question with the keys status,
            score (int or None), no_reference (bool), tps (tokens per second or
            None) and time_sec (answer time without model loading, or None).

    Returns:
        dict: model, n (answers counted in the score), median, pass_rate
            (fraction), fails, critical_fails, errors, judge_errors,
            n_no_reference, median_tps and median_time_sec.
    """
    scores = []
    errors = judge_errors = n_no_reference = 0

    for entry in entries:
        status = entry["status"]
        if status == STATUS_GENERATION_ERROR:
            errors += 1
            scores.append(0)
        elif status == STATUS_JUDGE_ERROR:
            judge_errors += 1
        elif entry["no_reference"]:
            n_no_reference += 1
        elif status == STATUS_TRUNCATED:
            scores.append(min(entry["score"], PASS_MIN_SCORE - 1))
        else:
            scores.append(entry["score"])

    answered = [e for e in entries if e["status"] != STATUS_GENERATION_ERROR]
    n = len(scores)
    passed = sum(1 for score in scores if score >= PASS_MIN_SCORE)

    return {
        "model": model,
        "n": n,
        "median": _median(scores, 1),
        "pass_rate": round(passed / n, 2) if n else None,
        "fails": sum(1 for s in scores if CRITICAL_BELOW <= s < PASS_MIN_SCORE),
        "critical_fails": sum(1 for s in scores if s < CRITICAL_BELOW),
        "errors": errors,
        "judge_errors": judge_errors,
        "n_no_reference": n_no_reference,
        "median_tps": _median([e["tps"] for e in answered], 2),
        "median_time_sec": _median([e["time_sec"] for e in answered], 2),
    }


def recommend(models: list[dict]) -> dict:
    """Picks the model to recommend.

    Args:
        models (list[dict]): Results of `summarize_model` for every model.

    Returns:
        dict: model (or None), rule and confidence.
    """
    graded = [m for m in models if m["n"] > 0]
    if not graded:
        return {
            "model": None,
            "rule": RULE_NONE_GRADED,
            "confidence": CONFIDENCE_LOW,
        }

    qualified = [m for m in graded if m["pass_rate"] >= PASS_RATE_THRESHOLD]
    if qualified:
        rule = RULE_FASTEST_ABOVE_THRESHOLD
        best = min(
            qualified,
            key=lambda m: (
                m["median_time_sec"]
                if m["median_time_sec"] is not None
                else float("inf"),
                -m["median"],
                m["model"],
            ),
        )
    else:
        rule = RULE_HIGHEST_MEDIAN
        best = min(
            graded,
            key=lambda m: (-m["median"], -m["pass_rate"], m["model"]),
        )

    confidence = CONFIDENCE_LOW if best["n"] < MIN_QUESTIONS else CONFIDENCE_HIGH
    return {"model": best["model"], "rule": rule, "confidence": confidence}
