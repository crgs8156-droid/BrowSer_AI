"""Phase 2 — Devanagari numeral normalization (backend mirror)."""

from app.llm_common import LLMPIILeakError, normalize_numerals, post_scan, PlanResult, PlannedAction
import pytest


def test_normalize_numerals_maps_devanagari_to_ascii():
    assert normalize_numerals('४५६७ ८९०१') == '4567 8901'
    assert normalize_numerals('ABCDE१२३४F') == 'ABCDE1234F'
    assert normalize_numerals('plain ascii 123') == 'plain ascii 123'
    assert normalize_numerals(None) is None


def test_postscan_catches_devanagari_aadhaar_in_model_output():
    result = PlanResult(
        action=PlannedAction(type="TYPE", selector="#f", value="४५६७ ८९०१ २३४५"),
        done=False,
        reason="filling the form",
    )
    with pytest.raises(LLMPIILeakError):
        post_scan(result)
