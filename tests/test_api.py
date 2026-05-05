"""
Unit tests for the Flask API endpoints.
"""


def test_health_check_returns_200(client):
    """
    Test that the /health endpoint returns a 200 OK status
    and the correct JSON response.
    """
    response = client.get("/health")

    assert response.status_code == 200
    assert response.is_json
    assert response.get_json() == {"status": "ok"}


def test_index_page_loads(client):
    """
    Test that the root URL (/) serves the index.html page.
    """
    response = client.get("/")

    assert response.status_code == 200
    # The response should contain some standard HTML tags
    assert b"<!DOCTYPE html>" in response.data or b"<html" in response.data
