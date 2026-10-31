"""Export of saved results as CSV and Markdown.

Pure module: no I/O. It renders the content of evaluation_results.json
(schema v2) as text. Aggregates come from `summary`, nothing is recomputed
here. Everything that comes from a model or a user is untrusted: CSV cells are
defused against spreadsheet formulas, and Markdown blocks are fenced or quoted
so they cannot break the structure of the document.
"""

import csv
import io
import re

CSV_COLUMNS = (
    "question",
    "tag",
    "model",
    "score",
    "category",
    "status",
    "tps",
    "cps",
    "time_sec",
)

# A cell that starts with one of these is run as a formula by spreadsheets.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_BACKTICK_RUN_RE = re.compile(r"`+")
_MISSING = "–"

_TABLE_HEAD = (
    "model",
    "graded",
    "mean",
    "median",
    "pass",
    "fails",
    "critical",
    "errors",
    "judge errors",
    "c/s",
    "t/s",
    "time, s",
)


# --- CSV --------------------------------------------------------------------


def _csv_cell(value):
    """Defuses a text cell that a spreadsheet would read as a formula.

    Numbers are returned as they are; None becomes an empty cell.
    """
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def to_csv(results: dict) -> str:
    """Renders one row per answer.

    Args:
        results (dict): The content of evaluation_results.json.

    Returns:
        str: CSV text with the columns of `CSV_COLUMNS`. `question` is the
            question id (q1, q2, ...).
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)

    for question in results.get("questions_results", []):
        for entry in question.get("results", []):
            row = (
                question.get("id"),
                question.get("tag"),
                entry.get("model_name"),
                entry.get("score"),
                entry.get("category"),
                entry.get("status"),
                entry.get("tps"),
                entry.get("cps"),
                entry.get("time_sec"),
            )
            writer.writerow(_csv_cell(value) for value in row)

    return buffer.getvalue()


# --- Markdown ---------------------------------------------------------------


def _fence(text: str) -> str:
    """Wraps text in a code fence longer than any backtick run inside it."""
    longest = max((len(run) for run in _BACKTICK_RUN_RE.findall(text)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}\n{text}\n{ticks}"


def _quote(text: str) -> str:
    """Turns text into a block quote. A fence left open by a model ends with it."""
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())


def _line(value) -> str:
    """One line of text: line breaks cannot start a new heading."""
    return " ".join(str(value if value is not None else "").split())


def _cell(value) -> str:
    """A table cell: one line, pipes escaped, missing values as a dash."""
    if value is None:
        return _MISSING
    return _line(value).replace("|", "\\|")


def _row(cells) -> str:
    return "| " + " | ".join(_cell(cell) for cell in cells) + " |"


def _meta(results: dict) -> str:
    parts = [
        f"judge: {_line(results.get('judge_model'))}",
        f"mode: {_line(results.get('mode'))}",
    ]
    if results.get("finished_at"):
        parts.append(f"finished: {_line(results['finished_at'])}")
    return " · ".join(parts)


def _recommendation(recommendation: dict) -> str:
    rule = _line(recommendation.get("rule"))
    confidence = _line(recommendation.get("confidence"))
    details = f"rule: {rule}, confidence: {confidence}"
    if recommendation.get("model"):
        return f"Recommended model: {_line(recommendation['model'])} ({details})."
    return f"No model was recommended ({details})."


def _models_table(models: list) -> str:
    rows = [_row(_TABLE_HEAD), _row(["---"] * len(_TABLE_HEAD))]
    for stats in models:
        pass_rate = stats.get("pass_rate")
        rows.append(
            _row(
                [
                    stats.get("model"),
                    stats.get("n"),
                    stats.get("mean"),
                    stats.get("median"),
                    None if pass_rate is None else f"{pass_rate:.0%}",
                    stats.get("fails"),
                    stats.get("critical_fails"),
                    stats.get("errors"),
                    stats.get("judge_errors"),
                    stats.get("median_cps"),
                    stats.get("median_tps"),
                    stats.get("median_time_sec"),
                ]
            )
        )
    return "\n".join(rows)


def _answer_block(entry: dict) -> str:
    status = (
        f"score: {_cell(entry.get('score'))} · "
        f"category: {_cell(entry.get('category'))} · "
        f"status: {_cell(entry.get('status'))}"
    )
    if entry.get("truncated"):
        status += " · truncated"

    blocks = [f"#### {_line(entry.get('model_name'))}", status]
    if entry.get("error"):
        blocks.append(_quote(f"Error: {entry['error']}"))
    if entry.get("comment"):
        blocks.append(_quote(entry["comment"]))
    if entry.get("answer"):
        blocks.append(_fence(entry["answer"]))
    return "\n\n".join(blocks)


def _question_block(question: dict) -> str:
    tag = _line(question.get("tag"))
    heading = f"### {_line(question.get('id'))}" + (f" · {tag}" if tag else "")

    reference = question.get("reference") or {}
    if reference.get("text"):
        source = _line(reference.get("source"))
        reference_block = (
            f"Reference answer ({source}):\n\n{_fence(reference['text'])}"
        )
    else:
        reference_block = "No reference answer."

    blocks = [heading]
    if question.get("question"):
        blocks.append(_quote(question["question"]))
    blocks.append(reference_block)
    blocks.extend(_answer_block(entry) for entry in question.get("results", []))
    return "\n\n".join(blocks)


def to_markdown(results: dict) -> str:
    """Renders the run as a Markdown report.

    Structure: summary, table of models, one block per question. The numbers
    are taken from `summary.models` as they are.

    Args:
        results (dict): The content of evaluation_results.json.

    Returns:
        str: The Markdown document.
    """
    summary = results.get("summary") or {}

    blocks = [
        f"# {_line(results.get('task_id'))}",
        _meta(results),
        "## Summary",
        _recommendation(summary.get("recommendation") or {}),
    ]
    if summary.get("text"):
        blocks.append(_quote(summary["text"]))

    blocks += ["## Models", _models_table(summary.get("models", [])), "## Questions"]
    blocks += [_question_block(q) for q in results.get("questions_results", [])]
    return "\n\n".join(blocks) + "\n"