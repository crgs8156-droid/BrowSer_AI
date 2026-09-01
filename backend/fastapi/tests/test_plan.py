"""M6 — /v1/plan endpoint and deterministic planner tests (offline, no model)."""

import pytest
from fastapi.testclient import TestClient

from app.agent import PlanRequest, SanitizedNode, plan_actions
from app.main import app

client = TestClient(app)


def make_request(**overrides) -> PlanRequest:
    base = dict(
        taskObjective="fill the form with my details and submit",
        sanitizedPageStructure=[
            SanitizedNode(tag="input", selector="#email", inputType="email", label="Email", filled=False, disabled=False),
            SanitizedNode(tag="input", selector="#phone", inputType="tel", name="phone", label="Phone", filled=False, disabled=False),
            SanitizedNode(tag="button", selector="#submit", label="Submit", filled=False, disabled=False),
        ],
        sanitizedVisibleText="Email USER_EMAIL_1 · Phone USER_PHONE_1",
        aliases=[
            {"alias": "USER_EMAIL_1", "category": "EMAIL"},
            {"alias": "USER_PHONE_1", "category": "PHONE"},
        ],
        availableActions=["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
        policy={"privacyMode": "strict", "navigationAllowlist": []},
    )
    base.update(overrides)
    return PlanRequest(**base)


def test_health_unchanged():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_plan_types_email_alias_into_empty_field():
    response = client.post("/v1/plan", json=make_request().model_dump())
    assert response.status_code == 200
    actions = response.json()["actions"]
    assert actions == [{"action": "TYPE", "target": "#email", "value": "USER_EMAIL_1"}]


def test_act_alias_route_matches_plan_contract():
    payload = make_request().model_dump()
    assert client.post("/v1/act", json=payload).json() == client.post("/v1/plan", json=payload).json()


def test_plan_advances_to_phone_then_submit():
    filled_email = make_request(
        sanitizedPageStructure=[
            SanitizedNode(tag="input", selector="#email", inputType="email", label="Email", filled=True, disabled=False),
            SanitizedNode(tag="input", selector="#phone", inputType="tel", name="phone", label="Phone", filled=False, disabled=False),
            SanitizedNode(tag="button", selector="#submit", label="Submit", filled=False, disabled=False),
        ]
    )
    second = client.post("/v1/plan", json=filled_email.model_dump()).json()["actions"]
    assert second == [{"action": "TYPE", "target": "#phone", "value": "USER_PHONE_1"}]

    filled_both = make_request(
        sanitizedPageStructure=[
            SanitizedNode(tag="input", selector="#email", inputType="email", label="Email", filled=True, disabled=False),
            SanitizedNode(tag="input", selector="#phone", inputType="tel", name="phone", label="Phone", filled=True, disabled=False),
            SanitizedNode(tag="button", selector="#submit", label="Submit", filled=False, disabled=False),
        ]
    )
    third = client.post("/v1/plan", json=filled_both.model_dump()).json()["actions"]
    assert third == [{"action": "CLICK", "target": "#submit"}]


def test_plan_returns_empty_when_nothing_to_do():
    done = make_request(
        taskObjective="fill the form",
        sanitizedPageStructure=[
            SanitizedNode(tag="input", selector="#email", inputType="email", label="Email", filled=True, disabled=False)
        ],
    )
    assert client.post("/v1/plan", json=done.model_dump()).json()["actions"] == []


def test_plan_rejects_raw_alias_grammar_and_oversized_payloads():
    payload = make_request().model_dump()
    payload["aliases"] = [{"alias": "secret@example.test", "category": "EMAIL"}]
    assert client.post("/v1/plan", json=payload).status_code == 422

    payload = make_request().model_dump()
    payload["availableActions"] = ["EVAL"]
    assert client.post("/v1/plan", json=payload).status_code == 422

    payload = make_request().model_dump()
    payload["sanitizedVisibleText"] = "x" * 100_001
    assert client.post("/v1/plan", json=payload).status_code == 422


def test_plan_action_values_are_aliases_only():
    response = client.post("/v1/plan", json=make_request().model_dump())
    body = response.json()
    assert "CANARY" not in str(body)
    for action in body["actions"]:
        if action["action"] == "TYPE":
            assert action["value"].startswith("USER_")


def test_deterministic_planner_is_stateless_pure():
    request = make_request()
    first = plan_actions(request)
    second = plan_actions(request)
    assert first == second


def test_remote_provider_is_loudly_unimplemented(monkeypatch):
    monkeypatch.setenv("AGENT_PROVIDER", "remote")
    with pytest.raises(NotImplementedError):
        plan_actions(make_request())
