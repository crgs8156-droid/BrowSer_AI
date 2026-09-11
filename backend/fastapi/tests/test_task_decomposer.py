"""Part A — task decomposer tests (additive; `/v1/plan` contract unchanged)."""

from app.agent import (
    ClickAction,
    NavigateAction,
    PlanResponse,
    TypeAction,
    to_task_plan,
)


def test_empty_plan_decomposes_to_complete():
    plan = to_task_plan(PlanResponse(actions=[]))
    assert plan.type == "complete"
    assert plan.done is True
    assert plan.actions == []
    assert plan.summary is not None
    assert "CANARY" not in plan.model_dump_json()


def test_action_plan_decomposes_to_action():
    plan = to_task_plan(
        PlanResponse(actions=[TypeAction(action="TYPE", target="#email", value="USER_EMAIL_1")])
    )
    assert plan.type == "action"
    assert plan.done is False
    assert plan.actions[0].action == "TYPE"


def test_navigate_plan_decomposes_to_navigate_with_origin_only_url():
    plan = to_task_plan(
        PlanResponse(actions=[NavigateAction(action="NAVIGATE", url="https://site.test/form")])
    )
    assert plan.type == "navigate"
    assert plan.done is False
    assert plan.url == "https://site.test/form"
    assert plan.actions[0].action == "NAVIGATE"


def test_click_submit_is_action_not_complete():
    plan = to_task_plan(
        PlanResponse(actions=[ClickAction(action="CLICK", target="#submit")])
    )
    assert (plan.type, plan.done) == ("action", False)
