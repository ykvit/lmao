"""Ollama API Client module.

Provides a wrapper class to interact with a local Ollama service,
handling model discovery, generation requests and explicit VRAM unloading.
"""

import os

import requests

NS_PER_SEC = 1e9
GENERATE_TIMEOUT_SEC = 600
UNLOAD_TIMEOUT_SEC = 30


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
            models = [model["name"] for model in response.json().get("models", [])]
            return models
        except Exception as e:
            print(f"Error fetching models: {e}")
            return []

    def generate(
        self,
        model: str,
        prompt: str,
        system_prompt: str = "",
        format: str | dict | None = None,
        think: bool | None = None,
        options: dict | None = None,
        keep_alive: int | str = 0,
        timeout: int = GENERATE_TIMEOUT_SEC,
    ) -> dict:
        """Generates a text response from a specific model.

        By default `keep_alive` is 0, so Ollama unloads the model from VRAM right
        after the call. This prevents memory exhaustion when sequentially testing
        multiple large models. Pass a duration such as "10m" to keep the model
        loaded between calls and unload it explicitly with `unload()`.

        Args:
            model (str): The name of the model to use.
            prompt (str): The user input prompt.
            system_prompt (str, optional): Instructions for the model's behavior.
            format (str | dict, optional): "json" or a JSON schema for structured
                output. Defaults to free text.
            think (bool, optional): Enables or disables the model's thinking mode.
                None leaves the model default.
            options (dict, optional): Ollama model options, for example
                temperature, seed, num_ctx, num_predict.
            keep_alive (int | str, optional): How long the model stays loaded after
                the call. Defaults to 0 (unload immediately).
            timeout (int, optional): Seconds to wait for the full response.

        Returns:
            dict: A dictionary containing success status, response text, stop
                reason, prompt token count and performance metrics.
        """
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": model,
            "prompt": prompt,
            "system": system_prompt,
            "stream": False,
            "keep_alive": keep_alive,
        }

        if format is not None:
            payload["format"] = format
        if think is not None:
            payload["think"] = think
        if options:
            payload["options"] = options

        try:
            response = requests.post(url, json=payload, timeout=timeout)
            response.raise_for_status()
            data = response.json()

            total_duration_sec = data.get("total_duration", 0) / NS_PER_SEC
            load_duration_sec = data.get("load_duration", 0) / NS_PER_SEC
            eval_duration_sec = data.get("eval_duration", 0) / NS_PER_SEC
            eval_count = data.get("eval_count", 0)

            tokens_per_second = (
                (eval_count / eval_duration_sec) if eval_duration_sec > 0 else 0
            )

            return {
                "success": True,
                "response_text": data.get("response", ""),
                "done_reason": data.get("done_reason", ""),
                "prompt_eval_count": data.get("prompt_eval_count", 0),
                "metrics": {
                    "total_time_sec": round(total_duration_sec, 2),
                    "load_time_sec": round(load_duration_sec, 2),
                    "eval_time_sec": round(eval_duration_sec, 2),
                    "tokens_generated": eval_count,
                    "tokens_per_second": round(tokens_per_second, 2),
                },
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def unload(self, model: str) -> bool:
        """Unloads a model from VRAM right away.

        Args:
            model (str): The name of the model to unload.

        Returns:
            bool: True if Ollama accepted the request, False otherwise.
        """
        try:
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={"model": model, "keep_alive": 0},
                timeout=UNLOAD_TIMEOUT_SEC,
            )
            response.raise_for_status()
            return True
        except requests.RequestException as e:
            print(f"Error unloading {model}: {e}")
            return False
