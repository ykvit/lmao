"""Evaluation Pipeline module.

Orchestrates a blind evaluation run. The judge writes a reference answer per
question (A), every candidate answers every question (B), the judge grades each
answer on its own against the reference without seeing the model name (C), and
Python aggregates the grades into a summary and a recommendation (D).

Local mode runs the phases strictly one after another and keeps one model in
VRAM at a time. Cloud mode (a judge running remotely) runs the judge calls in a
thread pool while the candidates still generate one by one: references are made
and every answer is graded as soon as it is ready.
"""

import json
import os
import re
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime

from .ollama_client import OllamaClient
from .prompts import (
    GRADE_SCHEMA,
    GRADER_SYSTEM,
    REFERENCE_SYSTEM,
    SUMMARY_SYSTEM,
    GradeError,
    build_answer_prompt,
    build_grading_prompt,
    build_summary_prompt,
    parse_grade,
)
from .scoring import (
    STATUS_GENERATION_ERROR,
    STATUS_JUDGE_ERROR,
    STATUS_OK,
    STATUS_TRUNCATED,
    recommend,
    summarize_model,
)

SCHEMA_VERSION = 2
MODE_LOCAL = "local"
MODE_CLOUD = "cloud"

PHASE_REFERENCE = "reference"
PHASE_ANSWER = "answer"
PHASE_GRADING = "grading"
PHASE_SUMMARY = "summary"

SOURCE_GENERATED = "generated"
SOURCE_PROVIDED = "provided"
SOURCE_NONE = "none"

# Models stay loaded between the calls of one phase and are unloaded explicitly.
KEEP_ALIVE = "10m"
# Small models can loop forever; the cap keeps one bad answer from stalling a run.
CANDIDATE_OPTIONS = {"num_predict": 1000}
JUDGE_NUM_CTX = 8192
JUDGE_SEED = 42
MAX_REFERENCE_ATTEMPTS = 2
MAX_GRADE_ATTEMPTS = 3
# Parallel judge calls in cloud mode; lower it if the cloud rate-limits requests.
CLOUD_WORKERS = 4

_SUMMED_METRICS = (
    "total_time_sec",
    "load_time_sec",
    "eval_time_sec",
    "tokens_generated",
)


def _judge_options(attempt: int = 0) -> dict:
    """Deterministic judge options. The seed changes per attempt, because an
    identical retry at temperature 0 would return the identical reply."""
    return {
        "temperature": 0,
        "seed": JUDGE_SEED + attempt,
        "num_ctx": JUDGE_NUM_CTX,
        "num_predict": 1000,
    }


def _empty_metrics() -> dict:
    return {
        "total_time_sec": 0,
        "load_time_sec": 0,
        "eval_time_sec": 0,
        "tokens_generated": 0,
        "tokens_per_second": 0,
    }


def _add_metrics(total: dict, metrics: dict) -> None:
    for key in _SUMMED_METRICS:
        total[key] = round(total[key] + metrics[key], 2)
    if total["eval_time_sec"] > 0:
        total["tokens_per_second"] = round(
            total["tokens_generated"] / total["eval_time_sec"], 2
        )


def _new_question(index: int, test_case: dict) -> dict:
    provided = (test_case.get("reference") or "").strip()
    return {
        "id": f"q{index}",
        "tag": test_case.get("tag", f"Q{index}"),
        "question": test_case.get("question", ""),
        "specific_rationale": test_case.get("specific_rationale", ""),
        "reference": {
            "text": provided or None,
            "source": SOURCE_PROVIDED if provided else SOURCE_NONE,
        },
        "no_reference": not provided,
        "results": [],
    }


def _write_json(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class _Run:
    """Progress counter and event emitter of one evaluation run.

    Cloud mode reports from several threads, so the counter and the callback
    sit behind one lock and events stay in the same order as the progress.
    """

    def __init__(self, task_id: str, callback: Callable, total: int):
        self.task_id = task_id
        self.callback = callback
        self.total = total
        self.done = 0
        self._lock = threading.Lock()

    def advance(self) -> None:
        """Marks one step as finished without an event (a skipped step)."""
        with self._lock:
            self.done += 1

    def emit(self, event_type, phase, model=None, question=None, **extra) -> None:
        """Pushes an event carrying the phase, model, question and progress."""
        with self._lock:
            self._send(event_type, phase, model, question, extra)

    def complete(self, event_type, phase, model=None, question=None, **extra) -> None:
        """Marks one step as finished and reports it as a single update."""
        with self._lock:
            self.done += 1
            self._send(event_type, phase, model, question, extra)

    def _send(self, event_type, phase, model, question, extra) -> None:
        self.callback(
            self.task_id,
            {
                "type": event_type,
                "phase": phase,
                "model": model,
                "question": question,
                "progress": {"done": self.done, "total": self.total},
                **extra,
            },
        )


class EvaluationPipeline:
    """Manages the lifecycle of an evaluation task.

    Attributes:
        ollama (OllamaClient): An instance of the Ollama API client.
        history_dir (str): Directory where evaluation artifacts are stored.
    """

    def __init__(self, ollama_client: OllamaClient):
        """Initializes the EvaluationPipeline.

        Args:
            ollama_client (OllamaClient): Client to interact with local models.
        """
        self.ollama = ollama_client
        self.history_dir = "history"
        os.makedirs(self.history_dir, exist_ok=True)

    @contextmanager
    def _loaded(self, model: str):
        """Unloads the model from VRAM when the block ends, even on errors."""
        try:
            yield
        finally:
            self.ollama.unload(model)

    def _remove_think_tags(self, text: str) -> str:
        """Removes <think>...</think> blocks from the model's response.

        Args:
            text (str): The raw output generated by the model.

        Returns:
            str: The cleaned text without reasoning blocks.
        """
        cleaned_text = re.sub(r"<think>.*?</think>\n*", "", text, flags=re.DOTALL)
        return cleaned_text.strip()

    def _read_answer(self, result: dict) -> tuple[str, bool]:
        """Cleans a model reply and tells whether it was cut off.

        A reply is truncated when it hit the token limit or its <think> block
        never closed.
        """
        text = self._remove_think_tags(result["response_text"])
        truncated = result["done_reason"] == "length" or "<think>" in text
        return text, truncated

    def _judge_generate(
        self, judge: str, prompt: str, system_prompt: str, attempt=0, format=None
    ) -> dict:
        return self.ollama.generate(
            judge,
            prompt,
            system_prompt=system_prompt,
            format=format,
            think=False,
            options=_judge_options(attempt),
            keep_alive=KEEP_ALIVE,
        )

    def run_evaluation(
        self, task_id: str, payload: dict, update_status_cb: Callable
    ) -> None:
        """Executes the full evaluation process for a given payload.

        Args:
            task_id (str): The unique identifier for the current run.
            payload (dict): Configuration data from the UI (candidates, judge,
                judge_cloud, base_rationale, test_cases with an optional
                reference each).
            update_status_cb (Callable): Pushes events to the app stream.
        """
        judge = payload.get("judge")
        cloud = bool(payload.get("judge_cloud"))
        candidates = list(dict.fromkeys(payload.get("candidates", [])))
        base_rationale = payload.get("base_rationale", "")
        questions = [
            _new_question(index, test_case)
            for index, test_case in enumerate(payload.get("test_cases", []), 1)
        ]

        run_folder = os.path.join(self.history_dir, task_id)
        os.makedirs(run_folder, exist_ok=True)

        run = _Run(
            task_id,
            update_status_cb,
            total=len(questions) * (1 + 2 * len(candidates)) + 1,
        )
        metrics = {model: _empty_metrics() for model in candidates}

        runner = self._run_cloud if cloud else self._run_local
        summary = runner(run, judge, candidates, questions, metrics, base_rationale)

        mode = MODE_CLOUD if cloud else MODE_LOCAL
        _write_json(
            os.path.join(run_folder, "technical_metrics.json"),
            {
                "task_id": task_id,
                "judge_model": judge,
                "mode": mode,
                "metrics": metrics,
            },
        )
        _write_json(
            os.path.join(run_folder, "evaluation_results.json"),
            {
                "schema_version": SCHEMA_VERSION,
                "task_id": task_id,
                "judge_model": judge,
                "mode": mode,
                "judge_is_candidate": judge in candidates,
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "questions_results": questions,
                "summary": summary,
            },
        )

        update_status_cb(
            task_id,
            {"type": "completed", "message": "All tasks completed successfully."},
        )

    # --- orchestration ------------------------------------------------------

    def _run_local(
        self, run, judge, candidates, questions, metrics, base_rationale
    ) -> dict:
        """A, B, C and D strictly one after another, one model in VRAM at a time."""
        with self._loaded(judge):
            for question in questions:
                self._make_reference(run, judge, question)

        for model in candidates:
            self._answer_all(run, model, questions, metrics[model])

        # Grading and the summary share one load of the judge. Grading goes
        # model by model, the same order as in cloud mode.
        with self._loaded(judge):
            for model in candidates:
                for question, entry in self._entries_of(model, questions):
                    self._grade_entry(run, judge, question, base_rationale, entry)
            return self._summarize(run, judge, questions, candidates)

    def _run_cloud(
        self, run, judge, candidates, questions, metrics, base_rationale
    ) -> dict:
        """Judge calls run in a pool while the candidates generate one by one."""
        with ThreadPoolExecutor(max_workers=CLOUD_WORKERS) as pool:
            references = {
                question["id"]: pool.submit(self._make_reference, run, judge, question)
                for question in questions
            }
            gradings = []

            def grade_when_answered(question, entry):
                gradings.append(
                    pool.submit(
                        self._grade_after,
                        references[question["id"]],
                        run,
                        judge,
                        question,
                        base_rationale,
                        entry,
                    )
                )

            for model in candidates:
                self._answer_all(
                    run, model, questions, metrics[model], grade_when_answered
                )

            # Surface any exception raised in a worker thread.
            for future in [*references.values(), *gradings]:
                future.result()

        return self._summarize(run, judge, questions, candidates)

    @staticmethod
    def _entries_of(model: str, questions: list):
        """Yields (question, entry) for the answers of one model, in question order."""
        for question in questions:
            for entry in question["results"]:
                if entry["model_name"] == model:
                    yield question, entry

    # --- A: references ------------------------------------------------------

    def _make_reference(self, run: _Run, judge: str, question: dict) -> None:
        run.emit("reference_start", PHASE_REFERENCE, judge, question["id"])

        if question["reference"]["source"] != SOURCE_PROVIDED:
            text = self._generate_reference(judge, question["question"])
            if text:
                question["reference"] = {"text": text, "source": SOURCE_GENERATED}
                question["no_reference"] = False

        run.complete(
            "reference_done",
            PHASE_REFERENCE,
            judge,
            question["id"],
            success=not question["no_reference"],
            source=question["reference"]["source"],
        )

    def _generate_reference(self, judge: str, question: str) -> str | None:
        """Returns a complete reference answer, or None after the last attempt."""
        for attempt in range(MAX_REFERENCE_ATTEMPTS):
            result = self._judge_generate(
                judge, build_answer_prompt(question), REFERENCE_SYSTEM, attempt
            )
            if result["success"]:
                text, truncated = self._read_answer(result)
                if text and not truncated:
                    return text
        return None

    # --- B: candidate answers -----------------------------------------------

    def _answer_all(
        self,
        run: _Run,
        model: str,
        questions: list,
        metrics: dict,
        on_answer: Callable | None = None,
    ) -> None:
        """One candidate answers every question with the model loaded once.

        Args:
            on_answer (Callable, optional): Called with the question and the
                saved entry right after each answer.
        """
        run.emit("candidate_start", PHASE_ANSWER, model)

        with self._loaded(model):
            for question in questions:
                entry = self._answer(run, model, question, metrics)
                if on_answer:
                    on_answer(question, entry)

    def _answer(self, run: _Run, model: str, question: dict, metrics: dict) -> dict:
        run.emit("answer_start", PHASE_ANSWER, model, question["id"])

        result = self.ollama.generate(
            model,
            build_answer_prompt(question["question"]),
            think=False,
            options=CANDIDATE_OPTIONS,
            keep_alive=KEEP_ALIVE,
        )
        entry = self._answer_entry(model, result)
        question["results"].append(entry)
        if result["success"]:
            _add_metrics(metrics, result["metrics"])

        run.complete(
            "answer_done",
            PHASE_ANSWER,
            model,
            question["id"],
            success=result["success"],
            error=entry["error"],
        )
        return entry

    def _answer_entry(self, model: str, result: dict) -> dict:
        entry = {
            "model_name": model,
            "answer": "",
            "status": STATUS_GENERATION_ERROR,
            "category": None,
            "score": None,
            "comment": "",
            "truncated": False,
            "done_reason": "",
            "error": result.get("error"),
            "tps": None,
            "cps": None,
            "time_sec": None,
        }
        if result["success"]:
            text, truncated = self._read_answer(result)
            metrics = result["metrics"]
            eval_time = metrics["eval_time_sec"]
            entry.update(
                answer=text,
                status=STATUS_TRUNCATED if truncated else STATUS_OK,
                truncated=truncated,
                done_reason=result["done_reason"],
                tps=metrics["tokens_per_second"],
                # Characters of the cleaned answer, not tokens: tokenizers differ
                # between models, so t/s does not compare across them.
                cps=round(len(text) / eval_time, 2) if eval_time > 0 else None,
                # Answer time without the model load.
                time_sec=round(
                    max(metrics["total_time_sec"] - metrics["load_time_sec"], 0), 2
                ),
            )
        return entry

    # --- C: grading ---------------------------------------------------------

    def _grade_after(self, reference: Future, *args) -> None:
        """Waits for the question's reference, then grades (cloud mode)."""
        reference.result()
        self._grade_entry(*args)

    def _grade_entry(
        self, run: _Run, judge: str, question: dict, base_rationale: str, entry: dict
    ) -> None:
        if entry["status"] == STATUS_GENERATION_ERROR:
            run.advance()
            return

        run.emit("grading_start", PHASE_GRADING, entry["model_name"], question["id"])
        grade, error = self._grade(judge, question, base_rationale, entry)
        if grade:
            entry.update(grade)
        else:
            entry.update(status=STATUS_JUDGE_ERROR, error=error)

        run.complete(
            "grading_done",
            PHASE_GRADING,
            entry["model_name"],
            question["id"],
            success=grade is not None,
            error=error,
        )

    def _grade(
        self, judge: str, question: dict, base_rationale: str, entry: dict
    ) -> tuple[dict | None, str | None]:
        """Grades one answer. Returns (grade, None) or (None, error)."""
        prompt = build_grading_prompt(
            question["question"],
            question["reference"]["text"],
            base_rationale,
            question["specific_rationale"],
            entry["answer"],
            entry["truncated"],
        )

        error = "Unknown error."
        for attempt in range(MAX_GRADE_ATTEMPTS):
            system_prompt = GRADER_SYSTEM
            if attempt > 0:
                system_prompt += f" Your previous reply was rejected: {error}"

            result = self._judge_generate(
                judge, prompt, system_prompt, attempt, format=GRADE_SCHEMA
            )
            if not result["success"]:
                error = result["error"]
                continue

            # Ollama silently cuts a prompt that does not fit the context window.
            if result["prompt_eval_count"] >= JUDGE_NUM_CTX:
                return None, "Judge prompt does not fit the context window."

            try:
                return parse_grade(result["response_text"]), None
            except GradeError as e:
                error = str(e)

        return None, error

    # --- D: summary ---------------------------------------------------------

    def _summarize(
        self, run: _Run, judge: str, questions: list, candidates: list
    ) -> dict:
        run.emit("summary_start", PHASE_SUMMARY, judge)

        entries = {model: [] for model in candidates}
        for question in questions:
            for entry in question["results"]:
                entries[entry["model_name"]].append(
                    {
                        "status": entry["status"],
                        "score": entry["score"],
                        "no_reference": question["no_reference"],
                        "tps": entry["tps"],
                        "cps": entry["cps"],
                        "time_sec": entry["time_sec"],
                    }
                )

        models = [summarize_model(model, entries[model]) for model in candidates]
        recommendation = recommend(models)

        result = self._judge_generate(
            judge,
            build_summary_prompt(models, recommendation),
            SUMMARY_SYSTEM,
        )
        if result["success"]:
            text = self._remove_think_tags(result["response_text"])
        else:
            text = f"Failed to generate summary: {result['error']}"

        run.complete("summary_done", PHASE_SUMMARY, judge, success=result["success"])

        return {"models": models, "recommendation": recommendation, "text": text}
