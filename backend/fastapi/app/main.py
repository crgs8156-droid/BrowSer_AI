"""PrivAgent backend (blueprint §13).

Exposes the planning service (`/v1/plan`, alias `/v1/act`) and a health check. This
service must NEVER receive raw protected values or alias->value mappings
(CONTRIBUTING.md §5 Rule 2). The endpoint enforces that with a PRE-SCAN on the
inbound payload, and the provider layer (Gemini) enforces a POST-SCAN on model output.
"""

from fastapi import FastAPI, HTTPException

from .agent import PlanRequest, plan_actions
from .gemini_provider import GeminiPIILeakError, GeminiUnavailableError
from .pii_scan import scan_pii

app = FastAPI(title="PrivAgent Backend", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}


@app.post("/v1/plan")
def plan(request: PlanRequest) -> dict:
    """Plan the next structured action(s) from an ALREADY-SANITIZED request.

    PRIVACY (CONTRIBUTING.md §5 Rule 2): the extension sanitizes the payload before it
    leaves the device; this endpoint mirrors the detection patterns as defense in depth
    and rejects any raw email/phone/card that still shows up.
    """
    # PRE-SCAN (inbound): raw PII must never reach ANY provider.
    if scan_pii(request.taskObjective, request.sanitizedVisibleText):
        raise HTTPException(status_code=422, detail="Raw PII detected in outbound request")

    try:
        return plan_actions(request)
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=502, detail="llm_unavailable") from error
    except GeminiPIILeakError as error:
        raise HTTPException(status_code=502, detail="PII leak detected in LLM response") from error
    except NotImplementedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error


@app.post("/v1/act")
def act(request: PlanRequest) -> dict:
    """Alias of `/v1/plan` (same contract, same planner, same guarantees)."""
    return plan(request)