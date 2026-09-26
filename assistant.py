"""Turns a typed request into route settings, with Claude (default) or Meta's Muse Spark.

"take me to tech tower, I use a wheelchair" → {"destination": "Evans Administration", "mode": "safe", "accessible": true}

Only used when plain building search finds nothing, so the search box still works without it.
AI_PROVIDER picks the model: "claude" (default) or "muse". Keys come from ANTHROPIC_API_KEY / META_API_KEY
(.env locally, the dashboard on Render).
"""
import functools
import json
import os

import anthropic
import requests

TIMEOUT_S = 20
MAX_CHARS = 300          # longer requests are cut, so a pasted essay can't burn the credits

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["destination", "mode", "accessible"],
    "properties": {
        "destination": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "mode": {"type": "string", "enum": ["safe", "fastest", "bus"]},
        "accessible": {"type": "boolean"},
    },
}

PROMPT = """You turn a Georgia Tech walking request into route settings for a campus safety app.

- destination: the building they want to go to, copied exactly from the list below, or null if they don't name one on the list. If more than one building could match, pick the most likely one. Use campus nicknames you know: "Tech Tower" is Evans Administration, "the CULC" is Clough Undergraduate Learning Commons.
- mode: "bus" if they want the bus or to walk as little as possible, "fastest" if they're in a hurry or want the quickest way, otherwise "safe".
- accessible: true if they mention a wheelchair, crutches, another mobility aid, avoiding stairs or steps, or needing an accessible route.

Buildings:
"""


def key_name():
    """The environment variable the chosen AI needs."""
    return "META_API_KEY" if os.environ.get("AI_PROVIDER", "claude") == "muse" else "ANTHROPIC_API_KEY"


def route_settings(text, buildings):
    """{"destination": name or None, "mode": "safe" | "fastest" | "bus", "accessible": bool}; raises if the AI fails."""
    ask = _muse if os.environ.get("AI_PROVIDER", "claude") == "muse" else _claude
    out = ask(PROMPT + "\n".join(buildings), text[:MAX_CHARS])
    exact = {name.lower(): name for name in buildings}
    out["destination"] = exact.get((out["destination"] or "").strip().lower())   # only names we can route to
    return out


# ---- Claude ----
CLAUDE_MODEL = "claude-opus-5"


@functools.cache
def _client():
    return anthropic.Anthropic(timeout=TIMEOUT_S, max_retries=1)   # made on first use, after .env is loaded


def _claude(system, text):
    res = _client().beta.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",     # if Claude declines, the API retries on Anthropic's recommended fallback model
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},   # low effort: it's a quick lookup
        system=system,
        messages=[{"role": "user", "content": text}],
    )
    if res.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"Claude stopped early: {res.stop_reason}")
    return json.loads(next(block.text for block in res.content if block.type == "text"))


# ---- Muse Spark (Meta Model API, OpenAI-style) ----
MUSE_API = "https://api.meta.ai/v1/chat/completions"
MUSE_MODEL = "muse-spark-1.3"


def _muse(system, text):
    res = requests.post(MUSE_API, timeout=TIMEOUT_S, headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}"}, json={
        "model": MUSE_MODEL,
        "reasoning_effort": "low",   # same answers in tests, about twice as fast and half the tokens
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "route_settings", "strict": True, "schema": SCHEMA}},
    })
    res.raise_for_status()
    return json.loads(res.json()["choices"][0]["message"]["content"])
