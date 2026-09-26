"""Turns a typed request into route settings, with Claude (default) or Meta's Muse Spark.

"take me to tech tower, I use a wheelchair" → {"destination": "Lettie Pate Whithead Evans Administration", "mode": "safe", "accessible": true}

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

- destination: the building they want to go to, copied exactly from the list below, or null if they don't name one on the list. If more than one building could match, pick the most likely one. Use campus nicknames you know: "Tech Tower" is Lettie Pate Whithead Evans Administration, "the CULC" is Clough Building.
- mode: "bus" if they want the bus or to walk as little as possible, "fastest" if they're in a hurry or want the quickest way, otherwise "safe".
- accessible: true if they mention a wheelchair, crutches, another mobility aid, avoiding stairs or steps, or needing an accessible route.

Buildings:
"""


def key_name():
    """The environment variable the chosen AI needs."""
    return "META_API_KEY" if os.environ.get("AI_PROVIDER", "claude") == "muse" else "ANTHROPIC_API_KEY"


def route_settings(text, buildings):
    """{"destination": name or None, "mode": "safe" | "fastest" | "bus", "accessible": bool}; raises if the AI fails.

    buildings maps each building's name to the other names it goes by.
    """
    ask = _muse if os.environ.get("AI_PROVIDER", "claude") == "muse" else _claude
    listing = "\n".join(f"{name} (also {', '.join(aka)})" if aka else name for name, aka in buildings.items())
    exact = {n.lower(): name for name, aka in buildings.items() for n in (name, *aka)}
    for _ in range(2):   # it now and then answers "no building" for a request it gets right the next time: ask once more
        out = ask(PROMPT + listing, text[:MAX_CHARS])
        out["destination"] = exact.get((out["destination"] or "").strip().lower())   # only names we can route to
        if out["destination"]:
            break
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
# 1.3 sometimes answers "model not found" (1 in 4 requests on 2026-09-26) while 1.2 doesn't: try 1.3 twice, then 1.2
MUSE_MODELS = ("muse-spark-1.3", "muse-spark-1.3", "muse-spark-1.2")
RETRY_STATUS = {404, 429, 500, 502, 503, 504}   # these fail fast, so trying again costs well under a second


def _muse(system, text):
    for attempt, model in enumerate(MUSE_MODELS, 1):
        res = requests.post(MUSE_API, timeout=TIMEOUT_S, headers={"Authorization": f"Bearer {os.environ['META_API_KEY']}"}, json={
            "model": model,
            "reasoning_effort": "low",   # same answers in tests, about twice as fast and half the tokens
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "route_settings", "strict": True, "schema": SCHEMA}},
        })
        if res.status_code not in RETRY_STATUS or attempt == len(MUSE_MODELS):
            break
        print(f"Muse {model} answered {res.status_code}, trying again", flush=True)
    res.raise_for_status()
    return json.loads(res.json()["choices"][0]["message"]["content"])
