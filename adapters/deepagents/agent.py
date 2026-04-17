"""Minimal Deep Agents setup for the tiny Pause Adapter.

One approval-required tool, one interrupt_on config, one scripted fake
model so the adapter can run without a live API key. This is enough to
produce a real pause artifact through the real Deep Agents + LangGraph
middleware stack.

Scope guards (hard):
  - NO subagents
  - NO persistent memory lane
  - NO sandbox / shell policy
  - NO checkpointer beyond what is needed to obtain a StateSnapshot
"""

from __future__ import annotations

from typing import Any

from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver


AGENT_NAME = "assay-deepagents-pause-adapter"
TRIGGER_TOOL_CALL_ID = "call_pause_adapter_001"


@tool
def execute(command: str) -> str:
    """Run a shell command (simulated). Approval-required in this adapter."""
    return f"[simulated] ran: {command}"


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    """FakeMessagesListChatModel with a no-op bind_tools.

    Needed because deepagents middleware calls model.bind_tools during
    setup; the upstream fake model classes do not implement it.
    """

    def bind_tools(self, tools: Any, **kwargs: Any) -> "_ToolCallingFakeModel":
        return self


def build_agent() -> tuple[Any, dict[str, Any]]:
    """Build the compiled agent and the invocation config.

    Returns (agent, config). The config carries the thread_id that
    agent.get_state reads from.
    """
    scripted = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "execute",
                "args": {"command": "ls -la"},
                "id": TRIGGER_TOOL_CALL_ID,
                "type": "tool_call",
            }
        ],
    )
    fake_model = _ToolCallingFakeModel(responses=[scripted])
    checkpointer = MemorySaver()
    agent = create_deep_agent(
        model=fake_model,
        tools=[execute],
        interrupt_on={"execute": True},
        checkpointer=checkpointer,
        name=AGENT_NAME,
    )
    config: dict[str, Any] = {"configurable": {"thread_id": "pause-adapter-thread"}}
    return agent, config
