"""PrivAgent backend (blueprint §13).

M0 scaffolding only: exposes a health endpoint so the toolchain can be validated.
This service must NEVER receive raw protected values or alias->value mappings
(CLAUDE.md §5). Feature endpoints (leakage sink, benchmark) arrive in later milestones.
"""

from fastapi import FastAPI

app = FastAPI(title="PrivAgent Backend", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}
