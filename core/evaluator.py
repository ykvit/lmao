import os
import json
import re
from datetime import datetime
from .ollama_client import OllamaClient

class EvaluationPipeline:
    def __init__(self, ollama_client: OllamaClient):
        self.ollama = ollama_client
        self.history_dir = "history"
        os.makedirs(self.history_dir, exist_ok=True)

    def _remove_think_tags(self, text: str) -> str:
        """Removes <think>...</think> blocks from the model's response."""
        cleaned_text = re.sub(r'<think>.*?</think>\n*', '', text, flags=re.DOTALL)
        return cleaned_text.strip()

    def run_evaluation(self, task_id: str, payload: dict, update_status_cb):
        candidates = payload.get("candidates",[])
        judge_model = payload.get("judge")
        tag = payload.get("tag", "general")
        
        questions = payload.get("questions",[])
        if "question" in payload and not questions:
            questions = [payload["question"]]

        base_rationale = payload.get("base_rationale", "")
        specific_rationale = payload.get("specific_rationale", "")

        run_folder = os.path.join(self.history_dir, f"{task_id}")
        os.makedirs(run_folder, exist_ok=True)

        technical_metrics = {"task_id": task_id, "tag": tag, "metrics": {}}
        for model in candidates:
            technical_metrics["metrics"][model] = {
                "total_time_sec": 0, "eval_time_sec": 0, "tokens_generated": 0, "tokens_per_second": 0
            }

        evaluation_data = {
            "task_id": task_id, "tag": tag, "judge_model": judge_model, "questions_results":[]
        }

        for q_idx, question in enumerate(questions):
            q_num = q_idx + 1
            total_q = len(questions)
            
            update_status_cb(task_id, "running", f"Question {q_num}/{total_q}: Polling candidates...")
            candidates_answers =[]

            for c_idx, model in enumerate(candidates, 1):
                update_status_cb(task_id, "running", f"Question {q_num}/{total_q}: Model {model} is generating...")
                result = self.ollama.generate(model, prompt=question)
                
                if result["success"]:
                    clean_response = self._remove_think_tags(result["response_text"])
                    candidates_answers.append({
                        "model_name": model, 
                        "answer": clean_response, 
                        "raw_answer": result["response_text"]
                    })
                    
                    m = technical_metrics["metrics"][model]
                    rm = result["metrics"]
                    m["total_time_sec"] = round(m["total_time_sec"] + rm["total_time_sec"], 2)
                    m["eval_time_sec"] = round(m["eval_time_sec"] + rm["eval_time_sec"], 2)
                    m["tokens_generated"] += rm["tokens_generated"]
                    if m["eval_time_sec"] > 0:
                        m["tokens_per_second"] = round(m["tokens_generated"] / m["eval_time_sec"], 2)
                else:
                    candidates_answers.append({"model_name": model, "answer": f"Error: {result.get('error')}", "raw_answer": ""})

            with open(os.path.join(run_folder, "technical_metrics.json"), "w", encoding="utf-8") as f:
                json.dump(technical_metrics, f, ensure_ascii=False, indent=2)

            # Judge operation
            update_status_cb(task_id, "running", f"Question {q_num}/{total_q}: Judge {judge_model} is analyzing...")
            judge_prompt = self._build_judge_prompt(question, base_rationale, specific_rationale, candidates_answers)
            
            judge_result = self.ollama.generate(
                model=judge_model, prompt=judge_prompt, 
                system_prompt="You are an objective AI judge. You MUST return ONLY a valid JSON object.",
                format_json=True
            )

            q_result = {"question": question, "results":[]}

            if judge_result["success"]:
                try:
                    parsed_judge = json.loads(judge_result["response_text"])
                    for candidate in candidates_answers:
                        model_name = candidate["model_name"]
                        judge_eval = next((item for item in parsed_judge.get("evaluations",[]) if item.get("model_name") == model_name), None)
                        q_result["results"].append({
                            "model_name": model_name,
                            "clean_answer": candidate["answer"],
                            "raw_answer": candidate["raw_answer"],
                            "judge_evaluation": judge_eval if judge_eval else {"score": 0, "comment": "Judge did not provide an evaluation."}
                        })
                except json.JSONDecodeError:
                    q_result["results"] =[{"error": "Judge returned invalid JSON format."}]
            else:
                q_result["results"] =[{"error": "Failed to call the judge model."}]

            evaluation_data["questions_results"].append(q_result)

            with open(os.path.join(run_folder, "evaluation_results.json"), "w", encoding="utf-8") as f:
                json.dump(evaluation_data, f, ensure_ascii=False, indent=2)

        # judge summary
        update_status_cb(task_id, "running", "Generating final summary...")
        
        summary_prompt = f"Provide a brief summary of the testing (2-3 paragraphs).\nTag: {tag}\n\nMetrics:\n"
        for m in candidates:
            m_metrics = technical_metrics["metrics"].get(m, {})
            summary_prompt += f"Model {m}: generated {m_metrics.get('tokens_generated', 0)} tokens at {m_metrics.get('tokens_per_second', 0)} t/s.\n"
        
        summary_prompt += "\nAnalyze the overall quality of the answers based on the previous evaluations, discuss the performance metrics, and declare a final winner."

        summary_result = self.ollama.generate(
            model=judge_model, 
            prompt=summary_prompt, 
            system_prompt="You are the Head AI Judge. Write a short, concise summary (in Markdown format) based on the models' test results and metrics.",
            format_json=False
        )

        if summary_result["success"]:
            evaluation_data["final_summary"] = summary_result["response_text"]
        else:
            evaluation_data["final_summary"] = "Failed to generate summary."

        with open(os.path.join(run_folder, "evaluation_results.json"), "w", encoding="utf-8") as f:
            json.dump(evaluation_data, f, ensure_ascii=False, indent=2)

        # --- COMPLETION ---
        update_status_cb(task_id, "completed", "Done. Data successfully saved and analyzed.")

    def _build_judge_prompt(self, question, base_rationale, specific_rationale, candidates_answers) -> str:
        """Generates the prompt for the Judge model."""
        answers_text = ""
        for item in candidates_answers:
            answers_text += f"\n--- MODEL: {item['model_name']} ---\n{item['answer']}\n-------------------\n"

        prompt = f"""Evaluate the models' answers to the technical question.

USER QUESTION:
{question}

BASE RATIONALE:
{base_rationale}

SPECIFIC RATIONALE:
{specific_rationale}

MODELS' RESPONSES:
{answers_text}

Your task is to return a JSON object with the following structure (and absolutely nothing else):
{{
  "evaluations":[
    {{
      "model_name": "name_of_the_model",
      "score": 85,
      "comment": "Brief explanation of why this score was given."
    }}
  ],
  "best_model": "name of the best performing model"
}}
"""
        return prompt