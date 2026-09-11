"""Defense-in-depth PII scan shared by the plan endpoint (inbound) and the Gemini
provider (outbound).

The extension sanitizes everything BEFORE it leaves the device; this is the backend's
own mirror of those patterns so a raw value that slips through is still caught at the
remote boundary (CONTRIBUTING.md §5 Rule 2). Aliases (`USER_EMAIL_1`) are shaped so
they cannot match any pattern here.
"""

import re

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(?:(?:\+91|0091|91|0)[\s\-.]?)?(?:[6-9]\d{4}[\s\-.]?\d{5}|[6-9]\d{2}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})")
PHONE_US_RE = re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
# Indian PII mirrors of the extension detectors (SIH 2026): Aadhaar (UIDAI first
# digit 2-9, 4-4-4 groups; lookarounds keep card prefixes from misfiring), PAN
# (5 letters + 4 digits + 1 letter), UPI VPA (gated on known handles/context and
# never inside a real email address). Existing patterns above are untouched.
AADHAAR_RE = re.compile(r"(?<!\d)(?<![\d][\s-])[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}(?![\s-]?\d)")
PAN_RE = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
UPI_RE = re.compile(r"\b[\w.\-]{2,256}@[a-zA-Z]{2,64}\b")
UPI_HANDLES = frozenset(
    {
        "okicici",
        "oksbi",
        "okaxis",
        "okhdfc",
        "ybl",
        "ibl",
        "upi",
        "paytm",
        "gpay",
        "phonepe",
    }
)
UPI_CONTEXT_RE = re.compile(r"(upi|vpa|\bpay\b)", re.IGNORECASE)


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


def _upi_hits(text: str) -> list[str]:
    """UPI VPAs: known-handle or UPI-context matches, never inside an email."""
    email_spans = [(m.start(), m.end()) for m in EMAIL_RE.finditer(text)]
    hits: list[str] = []
    for match in UPI_RE.finditer(text):
        start, end = match.start(), match.end()
        if end < len(text) and text[end] == ".":
            continue
        if any(start < span_end and end > span_start for span_start, span_end in email_spans):
            continue
        domain = (match.group(0).split("@", 1)[1] if "@" in match.group(0) else "").lower()
        if domain in UPI_HANDLES or UPI_CONTEXT_RE.search(text[max(0, start - 24) : start]):
            hits.append(match.group(0))
    return hits


def _phone_hits(text: str) -> list[str]:
    """Indian primary + US fallback (existing canaries like 555-...)."""
    aadhaar_spans = [(m.start(), m.end()) for m in AADHAAR_RE.finditer(text)]
    seen_spans: list[tuple[int, int]] = []
    hits: list[str] = []
    def add(m, is_indian: bool):
        raw = m.group(0)
        start, end = m.start(), m.end()
        if any(start < ae and end > ast for ast, ae in seen_spans):
            return
        stripped = re.sub(r"\D", "", raw)
        if is_indian:
            if len(stripped) < 10 or len(stripped) > 13:
                return
            core = stripped[-10:]
            if len(core) != 10 or not re.match(r"^[6-9]\d{9}$", core):
                return
        else:
            if len(stripped) < 10 or len(stripped) > 11:
                return
            core_us = stripped[-10:]
            if re.match(r"^[01]", core_us):
                return
        if start > 0 and text[start - 1].isdigit():
            return
        if end < len(text) and text[end].isdigit():
            return
        if any(start < ae and end > ast for ast, ae in aadhaar_spans):
            return
        seen_spans.append((start, end))
        hits.append(raw)
    for m in PHONE_RE.finditer(text):
        add(m, True)
    for m in PHONE_US_RE.finditer(text):
        add(m, False)
    return hits


def scan_pii(*texts: str) -> list[str]:
    """Return the raw PII values found across `texts` (empty when none)."""
    hits: list[str] = []
    for text in texts:
        if not text:
            continue
        hits.extend(EMAIL_RE.findall(text))
        hits.extend(_phone_hits(text))
        for match in CARD_RE.findall(text):
            if _luhn_valid(match):
                hits.append(match)
        hits.extend(AADHAAR_RE.findall(text))
        hits.extend(PAN_RE.findall(text))
        hits.extend(_upi_hits(text))
    return hits