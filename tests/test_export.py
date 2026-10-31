"""
Unit tests for the CSV and Markdown export of saved results.
"""

import csv
import io

import pytest

from core.export import CSV_COLUMNS, _csv_cell, _fence, to_csv, to_markdown

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _entry(model, **overrides):
    entry = {
        "model_name": model,
        "answer": "4",
        "status": "ok",
        "category": "perfect",
        "score": 95,
        "comment": "fine",
        "truncated": False,
        "done_reason": "stop",
        "error": None,
        "tps": 50.0,
        "cps": 250.0,
        "time_sec": 1.5,
    }
    entry.update(overrides)
    return entry


def _failed(model):
    return _entry(
        model,
        answer="",
        status="generation_error",
        category=None,
        score=None,
        comment="",
        error="oom",
        tps=None,
        cps=None,
        time_sec=None,
    )


def _results():
    return {
        "schema_version": 2,
        "task_id": "run_x_20260101_000000",
        "judge_model": "judge",
        "mode": "local",
        "finished_at": "2026-01-01T12:00:30",
        "questions_results": [
            {
                "id": "q1",
                "tag": "logic",
                "question": "What is 2+2?",
                "reference": {"text": "Four.", "source": "generated"},
                "no_reference": False,
                "results": [_entry("a"), _failed("b")],
            },
            {
                "id": "q2",
                "tag": "=SUM(1+1)",
                "question": "Q2",
                "reference": {"text": None, "source": "none"},
                "no_reference": True,
                "results": [
                    _entry("a", score=72, category="acceptable"),
                    _entry("b", score=30, category="broken_logic"),
                ],
            },
        ],
        "summary": {
            "models": [
                {
                    "model": "a",
                    "n": 1,
                    "mean": 83.5,
                    "median": 83.5,
                    "pass_rate": 1.0,
                    "fails": 0,
                    "critical_fails": 0,
                    "errors": 0,
                    "judge_errors": 0,
                    "median_tps": 50.0,
                    "median_cps": 250.0,
                    "median_time_sec": 1.5,
                },
                {
                    "model": "b",
                    "n": 1,
                    "mean": 15.0,
                    "median": 15.0,
                    "pass_rate": 0.0,
                    "fails": 0,
                    "critical_fails": 1,
                    "errors": 1,
                    "judge_errors": 0,
                    "median_tps": None,
                    "median_cps": None,
                    "median_time_sec": None,
                },
            ],
            "recommendation": {
                "model": "a",
                "rule": "fastest_above_threshold",
                "confidence": "low",
            },
            "text": "## Verdict\n\nA wins.",
        },
    }


def _rows(text):
    return list(csv.reader(io.StringIO(text)))


# --- CSV --------------------------------------------------------------------


def test_csv_has_the_documented_columns_including_cps():
    header = _rows(to_csv(_results()))[0]

    assert header == [
        "question",
        "tag",
        "model",
        "score",
        "category",
        "status",
        "tps",
        "cps",
        "time_sec",
    ]
    assert tuple(header) == CSV_COLUMNS


def test_csv_has_one_row_per_answer():
    rows = _rows(to_csv(_results()))[1:]

    assert len(rows) == 4
    assert rows[0] == ["q1", "logic", "a", "95", "perfect", "ok", "50.0", "250.0", "1.5"]
    assert rows[1] == ["q1", "logic", "b", "", "", "generation_error", "", "", ""]


def test_csv_defuses_a_formula_in_the_tag():
    rows = _rows(to_csv(_results()))

    assert rows[3][1] == "'=SUM(1+1)"


def test_csv_defuses_every_text_field():
    data = _results()
    data["questions_results"] = [
        {
            "id": "\tq1",
            "tag": "=1+1",
            "results": [
                _entry("+cmd", category="-x", status="@y"),
                _entry("\rz", score=0),
            ],
        }
    ]

    rows = _rows(to_csv(data))[1:]

    assert len(rows) == 2
    for row in rows:
        for cell in row:
            assert not cell.startswith(FORMULA_PREFIXES)
    assert rows[0][:6] == ["'\tq1", "'=1+1", "'+cmd", "95", "'-x", "'@y"]


@pytest.mark.parametrize("value", ["=SUM(1+1)", "+1", "-1", "@a", "\tx", "\rx"])
def test_csv_cell_prefixes_formula_starters(value):
    assert _csv_cell(value) == "'" + value


def test_csv_cell_keeps_ordinary_values():
    assert _csv_cell("logic") == "logic"
    assert _csv_cell(95) == 95
    assert _csv_cell(-1.5) == -1.5
    assert _csv_cell(None) == ""


# --- Markdown ---------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("plain", "```\nplain\n```"),
        ("a ``` b", "````\na ``` b\n````"),
        ("`````", "``````\n`````\n``````"),
    ],
)
def test_fence_is_longer_than_any_backtick_run_inside(text, expected):
    assert _fence(text) == expected


def test_markdown_keeps_an_answer_with_code_fences_inside_its_block():
    answer = "Use:\n```python\nprint(4)\n```\nDone."
    data = _results()
    data["questions_results"][0]["results"][0]["answer"] = answer

    markdown = to_markdown(data)

    assert f"````\n{answer}\n````" in markdown


def test_markdown_has_summary_models_and_a_block_per_question():
    markdown = to_markdown(_results())
    positions = [
        markdown.index(part)
        for part in (
            "# run_x_20260101_000000",
            "judge: judge · mode: local · finished: 2026-01-01T12:00:30",
            "## Summary",
            "Recommended model: a (rule: fastest_above_threshold, confidence: low).",
            "## Models",
            "## Questions",
            "### q1 · logic",
            "#### a",
            "#### b",
            "### q2 · =SUM(1+1)",
        )
    ]

    assert positions == sorted(positions)
    assert markdown.endswith("\n")


def test_markdown_table_uses_the_summary_numbers_and_dashes_for_missing():
    markdown = to_markdown(_results())

    assert (
        "| model | graded | mean | median | pass | fails | critical | errors "
        "| judge errors | c/s | t/s | time, s |"
    ) in markdown
    assert "| a | 1 | 83.5 | 83.5 | 100% | 0 | 0 | 0 | 0 | 250.0 | 50.0 | 1.5 |" in markdown
    assert "| b | 1 | 15.0 | 15.0 | 0% | 0 | 1 | 1 | 0 | – | – | – |" in markdown


def test_markdown_escapes_pipes_in_table_cells():
    data = _results()
    data["summary"]["models"][0]["model"] = "m|x"

    assert "| m\\|x | 1 |" in to_markdown(data)


def test_markdown_quotes_the_judge_text_so_an_open_fence_cannot_leak():
    data = _results()
    data["summary"]["text"] = "## Verdict\n\nA wins.\n```\nnever closed"

    markdown = to_markdown(data)

    assert "> ## Verdict\n>\n> A wins.\n> ```\n> never closed" in markdown


def test_markdown_headings_stay_on_one_line():
    data = _results()
    data["questions_results"][0]["tag"] = "a\n# injected"
    data["questions_results"][0]["results"][0]["model_name"] = "m\n# evil"

    markdown = to_markdown(data)

    assert "### q1 · a # injected" in markdown
    assert "#### m # evil" in markdown
    assert "\n# injected" not in markdown
    assert "\n# evil" not in markdown


def test_markdown_shows_errors_flags_and_missing_references():
    data = _results()
    data["questions_results"][0]["results"][0]["truncated"] = True

    markdown = to_markdown(data)

    assert "status: ok · truncated" in markdown
    assert "> Error: oom" in markdown
    assert "No reference answer." in markdown
    assert "Reference answer (generated):\n\n```\nFour.\n```" in markdown
    assert "> What is 2+2?" in markdown


def test_markdown_without_a_recommendation():
    data = _results()
    data["summary"]["recommendation"] = {
        "model": None,
        "rule": "none_graded",
        "confidence": "low",
    }
    data["summary"]["text"] = ""

    markdown = to_markdown(data)

    assert "No model was recommended (rule: none_graded, confidence: low)." in markdown
    assert "Recommended model" not in markdown