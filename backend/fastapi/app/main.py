"""PrivAgent backend (blueprint §13).

M0 scaffolding only: exposes a health endpoint so the toolchain can be validated.
This service must NEVER receive raw protected values or alias->value mappings
(CLAUDE.md §5). Feature endpoints (leakage sink, benchmark) arrive in later milestones.
"""

from fastapi import FastAPI, HTTPException

from .agent import PlanRequest, plan_actions

app = FastAPI(title="PrivAgent Backend", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}


@app.post("/v1/plan")
def plan(request: PlanRequest) -> dict:
    """Plan the next structured action(s) from an ALREADY-SANITIZED request.

    PRIVACY (CLAUDE.md §5 Rule 2): this endpoint must never receive raw protected
    values. The planner works purely on field semantics, filled flags, and alias
    bindings; the extension's firewall is the gate that guarantees the payload.
    """
    try:
        return plan_actions(request)
    except NotImplementedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error
