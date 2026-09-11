"""Phase 1 — Indian phone backend pre/post-scan."""

from fastapi.testclient import TestClient
from app.main import app
from app.pii_scan import scan_pii

client = TestClient(app)

def base_payload(**overrides):
    payload = {
        "taskObjective": "fill the form",
        "sanitizedPageStructure": [{"tag": "input", "selector": "#p", "filled": False, "disabled": False}],
        "sanitizedVisibleText": "hello",
        "aliases": [],
        "availableActions": ["CLICK"],
        "policy": {"privacyMode": "strict", "navigationAllowlist": []},
    }
    payload.update(overrides)
    return payload

def test_scan_pii_all_formats():
    for fmt in ["9876543210", "98765 43210", "987-6543-210", "+91 9876543210", "09876543210", "0091 9876543210"]:
        assert scan_pii(fmt), f"should detect {fmt}"
    assert not scan_pii("12345")
    assert not scan_pii("1234567890")
    # Aadhaar should not also be phone
    assert "9876543210" not in str(scan_pii("2345 6789 0123"))

def test_prescan_catches_phone_in_taskObjective():
    payload = base_payload(taskObjective="call me at 9876543210")
    resp = client.post("/v1/plan", json=payload)
    assert resp.status_code == 422
    assert "Raw PII" in resp.json()["detail"]

def test_postscan_catches_phone_in_llm_response():
    # Simulate LLM leaking phone via provider post-scan: use deterministic? Actually trigger via /v1/plan with provider that leaks?
    # Instead directly test scan_pii on LLM output path: the backend's gemini provider post-scan uses scan_pii
    from app.llm_common import PlanResult, PlannedAction, post_scan, LLMPIILeakError
    import pytest
    leaked = PlanResult(action=PlannedAction(type="TYPE", selector="#p", value="9876543210"), done=False, reason="fill")
    with pytest.raises(LLMPIILeakError):
        post_scan(leaked)
