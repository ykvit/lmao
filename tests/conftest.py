"""
Global pytest fixtures for the Local Model Assessment Operator.
"""

import pytest

from app import app as flask_app


@pytest.fixture
def app():
    """Yields a Flask application instance configured for testing."""
    # Set Flask to testing mode to disable error catching during request handling
    # so that you get better error reports when performing test requests.
    flask_app.config.update(
        {
            "TESTING": True,
        }
    )
    yield flask_app


@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()


@pytest.fixture
def runner(app):
    """A test runner for the app's Click commands."""
    return app.test_cli_runner()
