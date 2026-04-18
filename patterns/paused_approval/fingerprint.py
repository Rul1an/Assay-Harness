"""Derive a continuation anchor from serialized paused state.

resume_state_ref is harness-derived, explicitly NOT a byte-stable
runtime identifier. Same stability contract as the JS SDK lane
confirmed in #1177.
"""

from __future__ import annotations

import hashlib


ANCHOR_PREFIX = "sha256:"


def derive_resume_state_ref(serialized_state: str) -> str:
    """Return the v1 continuation anchor.

    Input is a string produced by the runtime (e.g. RunState.toString()
    in the OpenAI Agents JS SDK). The output is an app-level fingerprint
    of that string. Do NOT treat this as a cross-version stable identifier.
    """
    if not isinstance(serialized_state, str) or not serialized_state:
        raise ValueError("serialized_state must be a non-empty string")
    digest = hashlib.sha256(serialized_state.encode("utf-8")).hexdigest()
    return f"{ANCHOR_PREFIX}{digest}"
