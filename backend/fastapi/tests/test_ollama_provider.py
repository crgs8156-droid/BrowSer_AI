"""M9 — Ollama provider tests (mocked httpx; NO real calls in CI).

Covers the contract mapping, done/SCROLL handling, the shared POST-SCAN, fail-closed
behaviour on provider errors, and per-request `provider` routing. Ollama is mocked
entirely; the live model runs only on a host with Ollama installed.
"""

import httpx
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch

from app.main import app
from app.llm_common import PlanResult, PlannedAction

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
def ollama_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_URL", "http://localhost:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "gemma3:12b")


def _mock_ollama(result: PlanResult | None, *, content: str | None = None, status: int = 200,
                 raise_exc: BaseException | None = None) -> Mock:
    post_mock = Mock()
    if raise_exc is not None:
        post_mock.side_effect = raise_exc
        return post_mock
    if status != 200:
        req = httpx.Request("POST", "http://localhost:11434/v1/chat/completions")
        resp = httpx.Response(status, request=req)
        response = Mock()
        response.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"status {status}", request=req, response=resp
        )
        post_mock.return_value = response
        return post_mock
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "choices": [{"message": {"content": content if content is not None else result.model_dump_json()}}]
    }
    post_mock.return_value = response
    return post_mock


def test_valid_planning_response_returns_contract_actions(ollama_env):
    result = PlanResult(
        action=PlannedAction(type="TYPE", selector="#email", value="USER_EMAIL_1"),
        done=False,
        reason="email field is empty",
    )
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json() == {
        "actions": [{"action": "TYPE", "target": "#email", "value": "USER_EMAIL_1"}]
    }


def test_done_result_returns_no_actions(ollama_env):
    with patch("app.ollama_provider.httpx.post", _mock_ollama(PlanResult(action=None, done=True, reason="complete"))):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == []


def test_scroll_direction_maps_to_amount(ollama_env):
    result = PlanResult(action=PlannedAction(type="SCROLL", direction="down"), done=False, reason="below the fold")
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == [{"action": "SCROLL", "amount": 720.0}]


def test_postscan_blocks_llm_pii_leak_with_502(ollama_env):
    result = PlanResult(
        action=PlannedAction(type="TYPE", selector="#email", value="user@example.test"),
        done=False,
        reason="filling with the user's email",
    )
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "PII leak detected in LLM response"


def test_ollama_down_fails_closed_with_502(ollama_env):
    with patch(
        "app.ollama_provider.httpx.post",
        _mock_ollama(None, raise_exc=httpx.ConnectError("connection refused")),
    ):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_http_error_fails_closed_with_502(ollama_env):
    with patch("app.ollama_provider.httpx.post", _mock_ollama(None, status=500)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_unavailable"


def test_malformed_json_fails_closed_with_502(ollama_env):
    with patch("app.ollama_provider.httpx.post", _mock_ollama(None, content="this is not json")):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 502
    assert response.json()["detail"] == "llm_parse"


def test_prose_wrapped_json_is_salvaged(ollama_env):
    content = (
        'Here is my plan:\n'
        '{"action": {"type": "CLICK", "selector": "#submit"}, "done": false, "reason": "go"}\n'
        'Hope this helps!'
    )
    with patch("app.ollama_provider.httpx.post", _mock_ollama(None, content=content)):
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    assert response.json()["actions"] == [{"action": "CLICK", "target": "#submit"}]


def test_system_prompt_demands_json_only(ollama_env):
    result = PlanResult(action=PlannedAction(type="CLICK", selector="#submit"), done=False, reason="go")
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)) as post_mock:
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    body = post_mock.call_args.kwargs["json"]
    system = body["messages"][0]["content"]
    assert "valid JSON only" in system
    assert system.startswith("You are a privacy-preserving browser agent.")
    assert body["response_format"] == {"type": "json_object"}


def test_request_provider_routes_to_ollama_over_env(monkeypatch):
    # Env says deterministic; the request explicitly asks for ollama.
    monkeypatch.delenv("AGENT_PROVIDER", raising=False)
    result = PlanResult(action=PlannedAction(type="CLICK", selector="#submit"), done=False, reason="go")
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)) as post_mock:
        response = client.post("/v1/plan", json=_request(provider="ollama"))
    assert response.status_code == 200
    assert response.json()["actions"] == [{"action": "CLICK", "target": "#submit"}]
    post_mock.assert_called_once()


def test_request_provider_deterministic_overrides_env(ollama_env):
    # Env says ollama; the request explicitly asks for deterministic -> no HTTP call.
    with patch("app.ollama_provider.httpx.post") as post_mock:
        response = client.post("/v1/plan", json=_request(provider="deterministic"))
    assert response.status_code == 200
    assert response.json()["actions"] == [
        {"action": "TYPE", "target": "#email", "value": "USER_EMAIL_1"}
    ]
    post_mock.assert_not_called()


def test_no_provider_uses_env_default(ollama_env):
    # No provider field + AGENT_PROVIDER=ollama -> ollama is used.
    result = PlanResult(action=None, done=True, reason="noop")
    with patch("app.ollama_provider.httpx.post", _mock_ollama(result)) as post_mock:
        response = client.post("/v1/plan", json=_request())
    assert response.status_code == 200
    post_mock.assert_called_once()