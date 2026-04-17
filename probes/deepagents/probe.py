"""Deep Agents runtime probe.

Answers the three questions from docs/outreach/DEEPAGENTS_PROBE.md using a
real create_deep_agent flow with a scripted fake model, so no live API key
is needed.

Questions:
  Q1. Does LangGraph interrupt expose a stable tool_call_id at the pause?
  Q2. Is serialized graph state reachable via a public surface?
  Q3. Can the full pause artifact be emitted before resume?

Run: .venv/bin/python probe.py  (writes capture.json and exits 0)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command


class ToolCallingFakeModel(FakeMessagesListChatModel):
    """FakeMessagesListChatModel with a no-op bind_tools so deepagents can bind tools."""

    def bind_tools(self, tools, **kwargs):
        # bind_tools returns a runnable; for the probe we just return self.
        return self


HERE = Path(__file__).parent
CAPTURE_PATH = HERE / "capture.json"


# --- One approval-required tool, one user-scripted AIMessage --------------------

@tool
def execute(command: str) -> str:
    """Run a shell command (simulated)."""
    return f"[simulated] ran: {command}"


# Scripted AIMessage the fake model will emit. The tool_call id here is what
# would normally come from the real model; LangChain assigns it.
SCRIPTED_TOOL_CALL_ID = "call_probe_001"

scripted_ai_message = AIMessage(
    content="",
    tool_calls=[
        {
            "name": "execute",
            "args": {"command": "ls -la"},
            "id": SCRIPTED_TOOL_CALL_ID,
            "type": "tool_call",
        }
    ],
)

fake_model = ToolCallingFakeModel(responses=[scripted_ai_message])


# --- Build agent with HITL on the execute tool ----------------------------------

checkpointer = MemorySaver()

agent = create_deep_agent(
    model=fake_model,
    tools=[execute],
    interrupt_on={"execute": True},  # approve/reject on this tool
    checkpointer=checkpointer,
)


# --- Invoke and catch the interrupt ---------------------------------------------

config: dict[str, Any] = {"configurable": {"thread_id": "probe-thread-1"}}

print("=== invoking agent ===", file=sys.stderr)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "please run ls -la"}]},
    config=config,
)

# When an interrupt fires, invoke returns a dict containing "__interrupt__".
# Let's see its shape.
print("=== result top-level keys ===", file=sys.stderr)
print(list(result.keys()), file=sys.stderr)

interrupts = result.get("__interrupt__")
print(f"=== interrupts ({type(interrupts).__name__}) ===", file=sys.stderr)


# --- Inspect state snapshot (public API) ----------------------------------------

snapshot = agent.get_state(config)
print("=== StateSnapshot shape ===", file=sys.stderr)
print("  values keys:", list(snapshot.values.keys()), file=sys.stderr)
print("  next:", snapshot.next, file=sys.stderr)
print("  tasks count:", len(snapshot.tasks), file=sys.stderr)
if snapshot.tasks:
    t = snapshot.tasks[0]
    print("  task[0] name:", t.name, file=sys.stderr)
    print("  task[0] interrupts count:", len(t.interrupts), file=sys.stderr)
    if t.interrupts:
        iv = t.interrupts[0]
        print("  task[0] interrupt[0] type:", type(iv).__name__, file=sys.stderr)
        print("  task[0] interrupt[0] attrs:", [a for a in dir(iv) if not a.startswith("_")], file=sys.stderr)


# --- Normalize interrupt objects for JSON capture -------------------------------

def _obj_to_dict(o: Any) -> Any:
    """Best-effort serialization of LangGraph objects for the capture."""
    if hasattr(o, "model_dump"):
        try:
            return o.model_dump()
        except Exception:
            pass
    if hasattr(o, "_asdict"):
        try:
            return o._asdict()
        except Exception:
            pass
    if hasattr(o, "__dict__"):
        return {k: _obj_to_dict(v) for k, v in vars(o).items() if not k.startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_obj_to_dict(x) for x in o]
    if isinstance(o, dict):
        return {k: _obj_to_dict(v) for k, v in o.items()}
    try:
        json.dumps(o)
        return o
    except (TypeError, ValueError):
        return repr(o)


def _scrub_messages(msgs: Any) -> Any:
    """Show only structurally relevant fields on messages, not full content."""
    out = []
    if not isinstance(msgs, list):
        return _obj_to_dict(msgs)
    for m in msgs:
        d = _obj_to_dict(m)
        if isinstance(d, dict):
            keep = {k: d[k] for k in ("type", "role", "tool_calls", "tool_call_id", "name", "id") if k in d}
            if "content" in d and isinstance(d["content"], str):
                keep["content_len"] = len(d["content"])
            out.append(keep)
        else:
            out.append(d)
    return out


capture = {
    "probe_version": 1,
    "versions": {
        "deepagents": __import__("deepagents").__version__ if hasattr(__import__("deepagents"), "__version__") else None,
    },
    "result_top_level_keys": list(result.keys()),
    "interrupts_raw": _obj_to_dict(interrupts),
    "state_snapshot": {
        "values_keys": list(snapshot.values.keys()),
        "messages": _scrub_messages(snapshot.values.get("messages")),
        "next": list(snapshot.next) if snapshot.next else [],
        "tasks": [
            {
                "name": t.name,
                "id": t.id if hasattr(t, "id") else None,
                "interrupts_count": len(t.interrupts) if hasattr(t, "interrupts") else 0,
                "interrupts": _obj_to_dict(t.interrupts) if hasattr(t, "interrupts") else None,
            }
            for t in snapshot.tasks
        ],
        "config_keys": list(snapshot.config.keys()) if snapshot.config else [],
        "metadata_keys": list(snapshot.metadata.keys()) if snapshot.metadata else [],
    },
    "questions": {
        "Q1_tool_call_id_in_interrupt_payload": {
            "scripted_tool_call_id": SCRIPTED_TOOL_CALL_ID,
            "found_in_interrupt": "(see interrupts_raw)",
            "found_in_state_messages": "(see state_snapshot.messages)",
        },
        "Q2_continuation_anchor": {
            "public_surface_used": "agent.get_state(config) -> StateSnapshot",
            "snapshot_is_serializable": "(checked below at runtime)",
        },
        "Q3_pre_resume_emission": {
            "artifact_built_before_resume": True,
            "any_post_resume_field_required": "(see analysis in FINDINGS.md)",
        },
    },
}


# --- Can we serialize the StateSnapshot? (Q2 follow-up) -------------------------

try:
    snap_json = json.dumps(_obj_to_dict(snapshot), default=repr)
    capture["questions"]["Q2_continuation_anchor"]["snapshot_json_len"] = len(snap_json)
    capture["questions"]["Q2_continuation_anchor"]["snapshot_is_serializable"] = True
except Exception as e:
    capture["questions"]["Q2_continuation_anchor"]["snapshot_is_serializable"] = False
    capture["questions"]["Q2_continuation_anchor"]["serialize_error"] = str(e)


# --- Try to resume (Q3 confirmation) --------------------------------------------

try:
    resumed = agent.invoke(
        Command(resume={"decisions": [{"type": "approve"}]}),
        config=config,
    )
    capture["post_resume"] = {
        "resume_succeeded": True,
        "resumed_result_keys": list(resumed.keys()),
    }
except Exception as e:
    capture["post_resume"] = {
        "resume_succeeded": False,
        "error": f"{type(e).__name__}: {e}",
    }


CAPTURE_PATH.write_text(json.dumps(capture, indent=2, default=repr))
print(f"\n=== wrote {CAPTURE_PATH} ===", file=sys.stderr)
