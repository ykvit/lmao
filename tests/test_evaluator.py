"""
Unit tests for the evaluator logic, using mocks to isolate from the actual LLM.
"""

from unittest.mock import patch

from core.ollama_client import OllamaClient


@patch("core.ollama_client.requests.post")
def test_ollama_client_handles_success(mock_post):
    """
    Test that our Ollama client correctly parses a successful response
    WITHOUT actually calling the running Ollama container.
    """

    class MockResponse:
        status_code = 200

        def json(self):
            return {
                "response": "This is a mocked LLM response.",
                "total_duration": 1000000000,  # 1 sec in ns
                "eval_duration": 500000000,  # 0.5 sec in ns
                "eval_count": 100,
            }

        def raise_for_status(self):
            """Does nothing on success, just like the real one."""
            pass

    mock_post.return_value = MockResponse()

    client = OllamaClient()
    result = client.generate(model="mock-model", prompt="Hello!")

    assert result["success"] is True
    assert result["response_text"] == "This is a mocked LLM response."
    assert result["metrics"]["tokens_per_second"] == 200.0
    mock_post.assert_called_once()
