"""Ollama API Client module.

Provides a wrapper class to interact with a local Ollama service,
handling model discovery and generation requests while ensuring
memory management practices (like forcing VRAM unload).
"""

import requests
import os


class OllamaClient:
    """Client for communicating with the Ollama REST API.

    Attributes:
        base_url (str): The base URL of the Ollama service.
    """

    def __init__(self):
        """Initializes the OllamaClient using environment variables if present."""
        self.base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

    def get_models(self) -> list:
        """Retrieves a list of available models installed in Ollama.

        Returns:
            list: A list of model name strings.
        """
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=5)
            response.raise_for_status()
            models = [model["name"] for model in response.json().get("models",[])]
            return models
        except Exception as e:
            print(f"Error fetching models: {e}")
            return[]

    def generate(self, model: str, prompt: str, system_prompt: str = "", format_json: bool = False) -> dict:
        """Generates a text response from a specific model.

        Critically, this function uses `keep_alive: 0` to force Ollama to unload 
        the model from VRAM immediately after generation. This prevents memory 
        exhaustion when sequentially testing multiple large models.

        Args:
            model (str): The name of the model to use.
            prompt (str): The user input prompt.
            system_prompt (str, optional): Instructions for the model's behavior. Defaults to "".
            format_json (bool, optional): If True, forces the output to be JSON. Defaults to False.

        Returns:
            dict: A dictionary containing success status, response text, and performance metrics.
        """
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": model,
            "prompt": prompt,
            "system": system_prompt,
            "stream": False,
            "keep_alive": 0  # CRITICAL FOR CLEARING VRAM BETWEEN MODELS
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