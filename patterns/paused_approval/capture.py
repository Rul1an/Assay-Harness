"""Capture helper: reduce a raw paused-approval payload to bounded interruptions.

The pattern's v1 interruption item carries only `tool_name` and
`call_id_ref`. Richer lane variants (arguments_hash, etc.) are
extensions, not part of the pattern's canonical minimum.

Scope guards:
  - NO SDK import. The helper works on plain dicts, so the pattern
    stays runtime-agnostic.
  - NO argument capture in v1. Lanes that want arguments_hash add it
    on top after calling this helper.
"""

from __future__ import annotations

from typing import Any


def capture_paused_approval(
    raw_interruptions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reduce a list of raw interruption items to bounded v1 shape.

    Each raw item must expose at minimum a tool name and a call id
    (by any of the accepted keys). The helper does not invent values;
    if a field is missing it raises ValueError.

    Accepted raw keys (per runtime normalization):
      tool_name   | name
      call_id_ref | call_id | tool_call_id | tool_use_id | id
    """
    reduced: list[dict[str, Any]] = []
    for idx, raw in enumerate(raw_interruptions):
        if not isinstance(raw, dict):
            raise ValueError(f"interruption[{idx}] must be a dict, got {type(raw).__name__}")

        tool_name = _first_non_empty(raw, ("tool_name", "name"))
        if tool_name is None:
            raise ValueError(f"interruption[{idx}] missing tool_name / name")

        call_id = _first_non_empty(
            raw, ("call_id_ref", "call_id", "tool_call_id", "tool_use_id", "id")
        )
        if call_id is None:
            raise ValueError(f"interruption[{idx}] missing call_id_ref / call_id / tool_call_id")

        reduced.append({
            "tool_name": tool_name,
            "call_id_ref": call_id,
        })
    return reduced


def _first_non_empty(d: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = d.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None
