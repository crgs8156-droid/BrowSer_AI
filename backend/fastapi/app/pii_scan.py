"""Defense-in-depth PII scan shared by the plan endpoint (inbound) and the Gemini
provider (outbound).

The extension sanitizes everything BEFORE it leaves the device; this is the backend's
own mirror of those patterns so a raw value that slips through is still caught at the
remote boundary (CONTRIBUTING.md §5 Rule 2). Aliases (`USER_EMAIL_1`) are shaped so
they cannot match any pattern here.
"""

import re

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _luhn_valid(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 13 or len(digits) > 19:
        return False
    total = 0
    double = False
    for char in reversed(digits):
        digit = int(char)
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0


def scan_pii(*texts: str) -> list[str]:
    """Return the raw PII values found across `texts` (empty when none)."""
    hits: list[str] = []
    for text in texts:
        if not text:
            continue
        hits.extend(EMAIL_RE.findall(text))
        hits.extend(PHONE_RE.findall(text))
        for match in CARD_RE.findall(text):
            if _luhn_valid(match):
                hits.append(match)
    return hits