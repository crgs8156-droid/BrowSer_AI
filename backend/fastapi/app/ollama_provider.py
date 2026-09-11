"""M9 — Local model provider (Ollama) for the `AGENT_PROVIDER` seam.

Runs an open-weights model ON-DEVICE via Ollama (Qwen2.5-VL 3B by default — set `OLLAMA_MODEL`
to your exact tag; the Qwen2.5-VL family is vision-capable, which is the future vision
path). The request is ALREADY sanitized by the extension; this provider enforces the
SAME fail-closed guarantees as the Gemini provider via the shared `llm_common`:
  - JSON-mode output parsed into `PlanResult` (a malformed answer fails closed);
  - POST-SCAN on the model's output (`value`, `reason`) -> HTTP 502 on a leak;
  - Ollama down / 5xx / timeout / malformed JSON -> `LLMUnavailableError` -> HTTP 502
    `llm_unavailable`.

Privacy: nothing leaves the machine — the strongest tier (CONTRIBUTING.md §5).
"""

from __future__ import annotations

import ipaddress
import json
import os
from urllib.parse import urlparse

import httpx

from .agent import PlanRequest, PlanResponse
from .llm_common import (
    LLMUnavailableError,
    PlanResult,
    SYSTEM_INSTRUCTION,
    post_scan,
    to_plan_response,
)

DEFAULT_OLLAMA_URL = "http://localhost:11434"
# qwen2.5vl:3b — 2.3GB quantized, vision-capable, lightest model that reliably produces
# valid structured JSON for the action planning contract.
DEFAULT_MODEL = "qwen2.5vl:3b"
TIMEOUT_SECONDS = 90.0

#: Hostnames that always count as loopback without consulting DNS.
_LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def _validate_base_url(base_url: str) -> str:
    """Fail closed at construction: `OLLAMA_URL` must be loopback `http(s)`.

    Blocks non-http schemes (`file://`, `ftp://`), RFC-1918 private ranges,
    link-local (`169.254.x.x`, e.g. cloud metadata endpoints), and any other
    non-loopback literal. DNS names other than `localhost` — whose privateness
    cannot be established without a network lookup — require the explicit
    `OLLAMA_ALLOW_REMOTE=true` escape hatch for intentional remote use.
    """
    normalized = (base_url or "").strip().rstrip("/")
    parsed = urlparse(normalized)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        raise ValueError(
            "OLLAMA_URL must point to loopback (localhost/127.0.0.1). "
            "Set OLLAMA_ALLOW_REMOTE=true to permit remote hosts."
        )
    if host in _LOOPBACK_NAMES:
        return normalized
    allow_remote = os.environ.get("OLLAMA_ALLOW_REMOTE", "").lower() == "true"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # DNS name: accept only under the explicit remote-use flag.
        if allow_remote:
            return normalized
        raise ValueError(
            "OLLAMA_URL must point to loopback (localhost/127.0.0.1). "
            "Set OLLAMA_ALLOW_REMOTE=true to permit remote hosts."
        ) from None
    if ip.is_loopback:
        return normalized
    # Global-unicast literals only, and only under the explicit flag.
    if allow_remote and ip.is_global:
        return normalized
    raise ValueError(
        "OLLAMA_URL must point to loopback (localhost/127.0.0.1). "
        "Set OLLAMA_ALLOW_REMOTE=true to permit remote hosts."
    )


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = _validate_base_url(base_url)
        self.model = model

    def plan(self, request: PlanRequest) -> PlanResponse:
        payload = {
            "taskObjective": request.taskObjective,
            "sanitizedVisibleText": request.sanitizedVisibleText,
            "sanitizedPageStructure": [node.model_dump() for node in request.sanitizedPageStructure],
            "aliases": [binding.model_dump() for binding in request.aliases],
            "availableActions": request.availableActions,
        }

        try:
            response = httpx.post(
                f"{self.base_url}/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_INSTRUCTION},
                        {"role": "user", "content": json.dumps(payload)},
                    ],
                    "response_format": {"type": "json_object"},
                },
                timeout=TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError:
            raise LLMUnavailableError() from None

        try:
            content = response.json()["choices"][0]["message"]["content"]
            parsed = PlanResult.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValueError):
            raise LLMUnavailableError() from None

        # POST-SCAN: the local model's output must never carry raw PII either.
        post_scan(parsed)
        return to_plan_response(parsed, request.availableActions)


def create_ollama_provider() -> OllamaProvider:
    return OllamaProvider(
        base_url=os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL),
        model=os.environ.get("OLLAMA_MODEL", DEFAULT_MODEL),
    )