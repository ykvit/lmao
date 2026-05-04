"""
Basic tests to ensure the application environment is sane.
"""


def test_environment_imports():
    """
    Test that core dependencies and internal modules can be imported.
    This acts as a basic sanity check for the Docker container.
    """

    import flask
    import requests

    assert flask is not None
    assert requests is not None

    # (Assuming you have core/evaluator.py and core/ollama_client.py)
    from core import evaluator, ollama_client

    assert evaluator is not None
    assert ollama_client is not None


def test_math_sanity():
    """A simple placeholder test to ensure pytest is running correctly."""
    assert 2 + 2 == 4
