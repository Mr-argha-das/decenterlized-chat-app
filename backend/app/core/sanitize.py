"""Input sanitization helpers for untrusted metadata fields (profiles, groups, contacts, domains).

Plaintext chat payloads are end-to-end encrypted and opaque to the server,
so sanitization applies strictly to unencrypted directory/display metadata.
"""
import re
import unicodedata

# Strip ASCII control chars except \n and \t where multiline is allowed
_CTRL_SINGLE_LINE_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_CTRL_MULTILINE_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_HTML_TAG_RE = re.compile(r"<\s*/?\s*(script|iframe|object|embed|svg|style|link|meta)\b[^>]*>", re.IGNORECASE)
_JS_URI_RE = re.compile(r"(javascript|vbscript|data\s*:\s*text/html)\s*:", re.IGNORECASE)
_ANGLE_BRACKET_RE = re.compile(r"[<>]")


def sanitize_single_line_text(
    raw: str | None,
    *,
    max_length: int = 120,
    strip_angle_brackets: bool = True,
) -> str:
    if not raw:
        return ""
    text = unicodedata.normalize("NFC", str(raw))
    text = _CTRL_SINGLE_LINE_RE.sub("", text)
    text = _HTML_TAG_RE.sub("", text)
    text = _JS_URI_RE.sub("", text)
    if strip_angle_brackets:
        text = _ANGLE_BRACKET_RE.sub("", text)
    # Collapse excessive whitespace runs
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_length]


def sanitize_multiline_text(
    raw: str | None,
    *,
    max_length: int = 500,
    strip_angle_brackets: bool = True,
) -> str:
    if not raw:
        return ""
    text = unicodedata.normalize("NFC", str(raw))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _CTRL_MULTILINE_RE.sub("", text)
    text = _HTML_TAG_RE.sub("", text)
    text = _JS_URI_RE.sub("", text)
    if strip_angle_brackets:
        text = _ANGLE_BRACKET_RE.sub("", text)
    return text.strip()[:max_length]
