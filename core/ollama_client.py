import requests
import os

class OllamaClient:
    def __init__(self):
        self.base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

    def get_models(self):
        """Retrieves a list of installed models."""
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=5)
            response.raise_for_status()
            models = [model["name"] for model in response.json().get("models",[])]
            return models
        except Exception as e:
            print(f"Error fetching models: {e}")
            return[]

    def generate(self, model: str, prompt: str, system_prompt: str = "", format_json: bool = False):
        """Generates response and collects technical metrics with forced VRAM clear."""
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": model,
            "prompt": prompt,
            "system": system_prompt,
            "stream": False,
            "keep_alive": 0  # CRITICAL FOR CLEARING VRAM
        }
        
        if format_json:
            payload["format"] = "json"

        try:
            response = requests.post(url, json=payload)
            response.raise_for_status()
            data = response.json()

            ns_to_sec = 1e9
            total_duration_sec = data.get("total_duration", 0) / ns_to_sec
            eval_duration_sec = data.get("eval_duration", 0) / ns_to_sec
            eval_count = data.get("eval_count", 0)

            tokens_per_second = (eval_count / eval_duration_sec) if eval_duration_sec > 0 else 0

            return {
                "success": True,
                "response_text": data.get("response", ""),
                "metrics": {
                    "total_time_sec": round(total_duration_sec, 2),
                    "eval_time_sec": round(eval_duration_sec, 2),
                    "tokens_generated": eval_count,
                    "tokens_per_second": round(tokens_per_second, 2)
                }
            }
        except Exception as e:
            return {"success": False, "error": str(e)}