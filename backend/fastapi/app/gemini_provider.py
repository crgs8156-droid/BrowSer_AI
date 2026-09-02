"""M8 — Gemini Flash provider for the `AGENT_PROVIDER` seam.

Plans the next structured action via Gemini's native structured-JSON output
(`response_schema`), so the model returns valid JSON without markdown wrapping.

PRIVACY (CONTRIBUTING.md §5): the request is ALREADY sanitized by the extension —
this provider never sees raw values by contract. It adds a POST-SCAN on the model's
own output (`action.value`, `reason`) and FAILS CLOSED:
  - Gemini API failure (rate limit / network / auth) -> `GeminiUnavailableError`
    (surfaced as HTTP 502 "llm_unavailable");
  - detectable raw PII in the model output -> `GeminiPIILeakError`
    (HTTP 502 "PII leak detected in LLM response").
Imported LAZILY by `agent.py` so the offline deterministic planner never depends on
the Google SDK being present.
"""

from __future__ import annotations

import json
import os
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel

from .agent import (
    ClickAction,
    NavigateAction,
    PlanAction,
    PlanRequest,
    PlanResponse,
    ScrollAction,
    SelectAction,
    TypeAction,
)
from .pii_scan import scan_pii

DEFAULT_MODEL = "gemini-2.0-flash"
SCROLL_AMOUNT = 720.0


class PlannedAction(BaseModel):
    type: Literal["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"]
    selector: str | None = None  # required for CLICK, TYPE, SELECT
    value: str | None = None  # required for TYPE, SELECT (alias or benign text only)
    direction: Literal["up", "down"] | None = None  # required for SCROLL
    url: str | None = None  # required for NAVIGATE


class PlanResult(BaseModel):
    action: PlannedAction | None = None
    done: bool
    reason: str


SYSTEM_INSTRUCTION = (
    "You are a privacy-preserving browser agent. You receive only sanitized DOM "
    "structure, visible text, and semantic aliases (e.g. USER_EMAIL_1, USER_PHONE_1, "
    "USER_PAYMENT_1, USER_NAME_1).\n"
    "Rules:\n"
    "- NEVER invent or output real personal information.\n"
    "- Use ONLY the provided aliases when filling sensitive fields.\n"
    "- Action types MUST BE EXACTLY ONE OF: CLICK, TYPE, SELECT, SCROLL, NAVIGATE.\n"
    "- If the task is completed, return action: null and done: true.\n"
    "- If no safe action can be determined, return action: null and done: true."
)


class GeminiUnavailableError(Exception):
    """Gemini call failed (rate limit, network, auth) — fail closed upstream."""


class GeminiPIILeakError(Exception):
    """The model returned detectable raw PII — fail closed upstream."""


def _to_plan_action(action: PlannedAction) -> PlanAction:
    kind = action.type
    if kind == "CLICK":
        return ClickAction(action="CLICK", target=action.selector or "")
    if kind == "TYPE":
        return TypeAction(action="TYPE", target=action.selector or "", value=action.value or "")
    if kind == "SELECT":
        return SelectAction(action="SELECT", target=action.selector or "", value=action.value or "")
    if kind == "SCROLL":
        amount = SCROLL_AMOUNT if action.direction == "down" else -SCROLL_AMOUNT
        return ScrollAction(action="SCROLL", amount=amount)
    return NavigateAction(action="NAVIGATE", url=action.url or "")


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str | None, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        # Missing key is surfaced on the planning path only (never on /health).
        if not self.api_key:
            raise HTTPException(
                status_code=500, detail="GEMINI_API_KEY environment variable is missing"
            )

        # Imported here so the module is importable (and the deterministic default
        # keeps working) even when the Google SDK is absent.
        from google import genai  # type: ignore[import-not-found]
        from google.genai import types  # type: ignore[import-not-found]

        client = genai.Client(api_key=self.api_key)

        payload = {
            "taskObjective": request.taskObjective,
            "sanitizedVisibleText": request.sanitizedVisibleText,
            "sanitizedPageStructure": [node.model_dump() for node in request.sanitizedPageStructure],
            "aliases": [binding.model_dump() for binding in request.aliases],
            "availableActions": request.availableActions,
        }

        try:
            response = client.models.generate_content(
                model=self.model,
                contents=json.dumps(payload),
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=PlanResult,
                    system_instruction=SYSTEM_INSTRUCTION,
                ),
            )
        except Exception:
            raise GeminiUnavailableError() from None

        parsed = response.parsed if response is not None else None
        if not isinstance(parsed, PlanResult):
            raise GeminiUnavailableError()

        # POST-SCAN: the model's own output must never carry raw PII.
        leaked = scan_pii(parsed.reason, parsed.action.value if parsed.action else None)
        if leaked:
            raise GeminiPIILeakError()

        if parsed.done or parsed.action is None:
            return PlanResponse(actions=[])
        return PlanResponse(actions=[_to_plan_action(parsed.action)])


def create_gemini_provider() -> GeminiProvider:
    return GeminiProvider(
        api_key=os.environ.get("GEMINI_API_KEY"),
        model=os.environ.get("GEMINI_MODEL", DEFAULT_MODEL),
    )