"""PrivAgent backend (blueprint §13).

Exposes the planning service (`/v1/plan`, alias `/v1/act`) and a health check. This
service must NEVER receive raw protected values or alias->value mappings
(CONTRIBUTING.md §5 Rule 2). The endpoint enforces that with a PRE-SCAN on the
inbound payload, and the provider layer (Gemini) enforces a POST-SCAN on model output.
"""

import hmac
import logging
import os
import sys

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .agent import PlanRequest, plan_actions
from .llm_common import LLMPIILeakError, LLMParseError, LLMUnavailableError
from .pii_scan import scan_pii

logger = logging.getLogger("privagent-backend")


def _required_api_key() -> str | None:
    """Bearer token for /v1/*, or None when unset (dev mode: auth disabled)."""
    key = os.environ.get("PRIVAGENT_API_KEY", "")
    return key if key else None


if _required_api_key() is None:
    logger.warning("PRIVAGENT_API_KEY not set — /v1/* auth disabled (dev mode)")

security = HTTPBearer(auto_error=False)


async def verify_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> None:
    """Enforce bearer auth on /v1/* when `PRIVAGENT_API_KEY` is configured."""
    required = _required_api_key()
    if required is None:
        return
    presented = credentials.credentials if credentials is not None else ""
    if not presented or not hmac.compare_digest(presented, required):
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})


limiter = Limiter(key_func=get_remote_address)
# The test suite shares one in-process client IP; enforcing the quota there
# would 429 the suite itself. Disable under pytest (or explicitly via
# PRIVAGENT_RATE_LIMIT=off) — production always enforces.
if (
    os.environ.get("PRIVAGENT_RATE_LIMIT", "on").lower() in ("off", "0", "false")
    or "pytest" in sys.modules
):
    limiter.enabled = False

app = FastAPI(title="PrivAgent Backend", version="0.0.0")
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(status_code=429, content={"error": "rate_limited"})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "privagent-backend", "milestone": "M0"}


def _plan_impl(payload: PlanRequest) -> dict:
    """Plan the next structured action(s) from an ALREADY-SANITIZED request.

    PRIVACY (CONTRIBUTING.md §5 Rule 2): the extension sanitizes the payload before it
    leaves the device; this endpoint mirrors the detection patterns as defense in depth
    and rejects any raw email/phone/card that still shows up.
    """
    # PRE-SCAN (inbound): raw PII must never reach ANY provider.
    # Covers the top-level text plus every free-text struct field that can carry
    # a raw value past the sanitizer: alias bindings and all node strings
    # (selector/label/name). NOTE: PlanRequest has no `pageContext`/`reason`
    # fields — the LLM result `reason` is covered by the provider POST-SCAN.
    struct_texts: list[str] = []
    for binding in payload.aliases:
        struct_texts.append(binding.alias)
        struct_texts.append(binding.category)
    for node in payload.sanitizedPageStructure:
        struct_texts.append(node.selector)
        if node.label is not None:
            struct_texts.append(node.label)
        if node.name is not None:
            struct_texts.append(node.name)
    # pageOrigin is a URL: query strings can smuggle raw PII (?email=user@x.com).
    if payload.pageOrigin is not None:
        struct_texts.append(payload.pageOrigin)
    if scan_pii(payload.taskObjective, payload.sanitizedVisibleText, *struct_texts):
        raise HTTPException(status_code=422, detail="Raw PII detected in outbound request")

    # PRIVACY-MODE gate (fail closed): only "strict" is implemented anywhere
    # (backend, extension loop, firewall, all tests). Anything else cannot be
    # honoured, so the request is rejected rather than served half-privately.
    if payload.policy.privacyMode != "strict":
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_privacy_mode", "allowed": ["strict"]},
        )

    try:
        return plan_actions(payload)
    except LLMUnavailableError as error:
        raise HTTPException(status_code=502, detail="llm_unavailable") from error
    except LLMPIILeakError as error:
        raise HTTPException(status_code=502, detail="PII leak detected in LLM response") from error
    except LLMParseError as error:
        raise HTTPException(status_code=502, detail="llm_parse") from error
    except ValueError as error:
        # Misconfigured provider (e.g. rejected OLLAMA_URL): SSRF stays blocked,
        # surfaced as a 502 — never a 500, never with the offending URL echoed.
        raise HTTPException(
            status_code=502,
            detail={"error": "llm_unavailable", "message": "invalid OLLAMA_URL config"},
        ) from error
    except NotImplementedError as error:
        raise HTTPException(status_code=501, detail=str(error)) from error


# NOTE: the `request: Request` parameter is required by slowapi (it resolves the
# client IP from it); the Pydantic body lives in `payload`. Auth runs first via
# the route dependency; /health stays unauthenticated by design.
@app.post("/v1/plan", dependencies=[Depends(verify_token)])
@limiter.limit("30/minute")
def plan(payload: PlanRequest, request: Request) -> dict:
    return _plan_impl(payload)


@app.post("/v1/act", dependencies=[Depends(verify_token)])
@limiter.limit("30/minute")
def act(payload: PlanRequest, request: Request) -> dict:
    """Alias of `/v1/plan` (same contract, same planner, same guarantees)."""
    return _plan_impl(payload)