"""M8 — Gemini provider tests (mocked client; NO real API calls in CI).

Covers the five required scenarios plus the SCROLL direction mapping and the
missing-key 500. The provider's `response.parsed` is a Pydantic `PlanResult` —
the mock returns real model instances so the contract is exercised, not faked.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from app.main import app

from app.gemini_provider import PlanResult, PlannedAction

client = TestClient(app)


def _request(**overrides) -> dict:
    payload = {
        "taskObjective": "fill the form with my details and submit",
        "sanitizedPageStructure": [
            {
                "tag": "input",
                "selector": "#email",
                "inputType": "email",
                "label": "Email",
                "filled": False,
                "disabled": False,
            },
        ],
        "sanitizedVisibleText": "Contact USER_EMAIL_1 · Phone USER_PHONE_1",
        "aliases": [{"alias": "USER_EMAIL_1", "category": "EMAIL"}],
        "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def gemini_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-2.0-flash")


def _mock_gemini(parsed: PlanResult | None = None, *, side_effect: BaseException | None = None) -> Mock:
    client_mock = Mock()
    if side_effect is not None:
        client_mock.models.generate_content.side_effect = side_effect
    else:
        response_mock = Mock()
        response_mock.parsed = parsed
        client_mock.models.generate_content.return_value = response_mock
    return client_mock


def test_valid_planning_response_returns_contract_actions(gemini_env):
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="TYPE", selector="#email", value="USER_EMAIL_1"),
            done=False,
            reason="email field is empty",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json() == {
        "actions": [{"action": "TYPE", "target": "#email", "value": "USER_EMAIL_1"}]
    }


def test_done_result_returns_no_actions(gemini_env):
    mock = _mock_gemini(PlanResult(action=None, done=True, reason="task complete"))
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == []


def test_scroll_direction_maps_to_amount(gemini_env):
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="SCROLL", direction="down"),
            done=False,
            reason="form is below the fold",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == [{"action": "SCROLL", "amount": 720.0}]


def test_prescan_blocks_raw_email_with_422(gemini_env):
    response = client.post(
        "/v1/plan", json=_request(sanitizedVisibleText="Reach me at user@example.test")
    )
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]


def test_prescan_blocks_raw_phone_with_422(gemini_env):
    response = client.post(
        "/v1/plan", json=_request(sanitizedVisibleText="Call me on 555-123-4567 today")
    )
    assert response.status_code == 422
    assert "Raw PII detected" in response.json()["detail"]


def test_postscan_blocks_llm_pii_leak_with_502(gemini_env):
    mock = _mock_gemini(
        PlanResult(
            action=PlannedAction(type="TYPE", selector="#email", value="user@example.test"),
            done=False,
            reason="filling with the user's email",
        )
    )
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert "PII leak detected in LLM response" == response.json()["detail"]


def test_gemini_api_failure_fails_closed_with_502(gemini_env):
    mock = _mock_gemini(side_effect=RuntimeError("rate limit"))
    with patch("google.genai.Client", return_value=mock):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_missing_api_key_returns_500(gemini_env, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY")
    # No Gemini call should be attempted — the key check runs first.
    with patch("google.genai.Client") as client_mock:
        response = client.post("/v1/plan", json=_request())
    client_mock.assert_not_called()
    assert response.status_code == 500
    assert "GEMINI_API_KEY" in response.json()["detail"]


def test_deterministic_default_ignores_missing_key():
    # Without AGENT_PROVIDER=gemini, the deterministic planner runs with no API key.
    response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == [
        {"action": "TYPE", "target": "#email", "value": "USER_EMAIL_1"}
    ]