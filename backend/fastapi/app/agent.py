"""M6 — remote deterministic planner provider (blueprint §8/§13).

The backend is a REMOTE boundary (CLAUDE.md §5 Rule 2): it must never receive raw
protected values. This planner therefore works exclusively on the sanitized request —
field semantics, filled flags, and alias bindings — and mirrors the extension's
deterministic planner so the demo is reproducible without any model.

The provider seam (`AGENT_PROVIDER`) exists for the S4 Ollama/VLM adapter; selecting a
provider that is not implemented fails loudly instead of pretending (CLAUDE.md §22).
"""

from __future__ import annotations

import os
import re
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

ALIAS_PATTERN = re.compile(r"^USER_[A-Z]+_\d+$")

CATEGORY_FIELD_KEYWORDS: dict[str, tuple[str, ...]] = {
    "EMAIL": ("email",),
    "PHONE": ("phone", "tel", "mobile"),
    "NAME": ("name", "fullname", "first-name", "last-name"),
    "ADDRESS": ("address", "street", "city"),
    "PASSWORD": ("password", "passwd"),
    "OTP": ("otp", "code", "pin"),
    "PAYMENT": ("card", "cc"),
    "ID": ("id",),
    "CUSTOM": (),
}

SUBMIT_LABELS = re.compile(r"^(submit|send|continue|next|sign in|log in|login|register|book|pay|done)(\b|\s|$)", re.I)
SUBMIT_TASK_VERBS = re.compile(r"\b(submit|send|continue|next|sign in|log in|login|register|book|pay|complete|finish)\b", re.I)


class SanitizedNode(BaseModel):
    tag: Literal["input", "textarea", "select", "button"]
    selector: str = Field(min_length=1, max_length=512)
    inputType: str | None = None
    label: str | None = None
    name: str | None = None
    filled: bool
    disabled: bool


class AliasBinding(BaseModel):
    alias: str = Field(pattern=r"^USER_[A-Z]+_\d+$")
    category: str


class ActionPolicy(BaseModel):
    privacyMode: str
    navigationAllowlist: list[str] = []


class PlanRequest(BaseModel):
    """Mirrors the extension's `RemoteAgentRequest` (sanitized data only)."""

    taskObjective: str = Field(min_length=1, max_length=2000)
    sanitizedPageStructure: list[SanitizedNode] = Field(max_length=500)
    sanitizedVisibleText: str = Field(max_length=100_000)
    aliases: list[AliasBinding] = Field(max_length=100)
    availableActions: list[
        Literal["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"]
    ]
    policy: ActionPolicy


class TypeAction(BaseModel):
    action: Literal["TYPE"]
    target: str
    value: str


class ClickAction(BaseModel):
    action: Literal["CLICK"]
    target: str


class SelectAction(BaseModel):
    action: Literal["SELECT"]
    target: str
    value: str


class ScrollAction(BaseModel):
    action: Literal["SCROLL"]
    amount: float


class NavigateAction(BaseModel):
    action: Literal["NAVIGATE"]
    url: str


PlanAction = TypeAction | ClickAction | SelectAction | ScrollAction | NavigateAction


class PlanResponse(BaseModel):
    actions: list[PlanAction]


class Planner(Protocol):
    name: str

    def plan(self, request: PlanRequest) -> PlanResponse: ...


def _is_field(node: SanitizedNode) -> bool:
    return node.tag in ("input", "textarea", "select")


def _matches_category(node: SanitizedNode, keywords: tuple[str, ...]) -> bool:
    haystack = f"{node.inputType or ''} {node.name or ''} {node.label or ''}".lower()
    return any(keyword in haystack for keyword in keywords)


class DeterministicPlanner:
    """Same heuristics as the in-extension planner: one action per call, stateless."""

    name = "deterministic"

    def plan(self, request: PlanRequest) -> PlanResponse:
        nodes = request.sanitizedPageStructure

        for binding in request.aliases:
            if not ALIAS_PATTERN.match(binding.alias):
                continue
            keywords = CATEGORY_FIELD_KEYWORDS.get(binding.category.upper(), ())
            if not keywords:
                continue
            for node in nodes:
                if (
                    _is_field(node)
                    and not node.filled
                    and not node.disabled
                    and _matches_category(node, keywords)
                ):
                    return PlanResponse(
                        actions=[TypeAction(action="TYPE", target=node.selector, value=binding.alias)]
                    )

        if SUBMIT_TASK_VERBS.search(request.taskObjective):
            for node in nodes:
                if (
                    node.tag == "button"
                    and not node.disabled
                    and node.label is not None
                    and SUBMIT_LABELS.match(node.label)
                ):
                    return PlanResponse(actions=[ClickAction(action="CLICK", target=node.selector)])

        return PlanResponse(actions=[])


class RemotePlannerStub:
    """S4 seam: the Ollama/VLM adapter lands later. Loudly unimplemented, never faked."""

    name = "remote"

    def plan(self, request: PlanRequest) -> PlanResponse:
        raise NotImplementedError("remote planner provider is wired in S4")


def get_provider() -> Planner:
    name = os.environ.get("AGENT_PROVIDER", "deterministic")
    if name == "remote":
        return RemotePlannerStub()
    return DeterministicPlanner()


def plan_actions(request: PlanRequest) -> dict[str, Any]:
    return get_provider().plan(request).model_dump()
