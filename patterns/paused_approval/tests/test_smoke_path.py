"""Phase D acceptance: one paused run -> one valid artifact with minimal glue.

    python3 -m unittest patterns.paused_approval.tests.test_smoke_path -v
"""

from __future__ import annotations

import unittest

from patterns.paused_approval import (
    PauseArtifactValidationError,
    capture_paused_approval,
    derive_resume_state_ref,
    emit_pause_artifact,
    validate_pause_artifact,
)


class TestSmokePath(unittest.TestCase):
    """End-to-end: raw pause payload -> validated v1 artifact."""

    def test_minimal_glue_happy_path(self):
        # A minimal raw payload a runtime might hand us at the pause.
        raw_interruptions = [
            {"name": "write_file", "call_id": "call_smoke_001"},
        ]
        fake_serialized_state = "fake-serialized-RunState-blob-from-runtime"

        interruptions = capture_paused_approval(raw_interruptions)
        anchor = derive_resume_state_ref(fake_serialized_state)
        artifact = emit_pause_artifact(
            framework="openai_agents_sdk",
            interruptions=interruptions,
            resume_state_ref=anchor,
            active_agent_ref="harness-mvp-agent",
        )
        validate_pause_artifact(artifact)

        # Shape checks confirming the pattern's v1 minimum came out correctly.
        self.assertEqual(artifact["framework"], "openai_agents_sdk")
        self.assertEqual(artifact["surface"], "tool_approval")
        self.assertEqual(artifact["pause_reason"], "tool_approval")
        self.assertEqual(len(artifact["interruptions"]), 1)
        self.assertEqual(
            set(artifact["interruptions"][0].keys()),
            {"tool_name", "call_id_ref"},
        )
        self.assertTrue(artifact["resume_state_ref"].startswith("sha256:"))

    def test_no_runtime_specific_fields_leak_through(self):
        """Extra keys in the raw payload must not survive reduction."""
        raw_interruptions = [
            {
                "name": "write_file",
                "call_id": "call_smoke_002",
                "arguments": {"path": "/tmp/thing"},   # raw args
                "rawItem": {"heavy": "metadata"},       # SDK internals
                "session_id": "sess_xxx",               # forbidden in v1
            },
        ]
        interruptions = capture_paused_approval(raw_interruptions)
        anchor = derive_resume_state_ref("state-blob")
        artifact = emit_pause_artifact(
            framework="openai_agents_sdk",
            interruptions=interruptions,
            resume_state_ref=anchor,
        )
        validate_pause_artifact(artifact)

        # Confirm nothing leaked in through interruption items.
        self.assertEqual(
            set(artifact["interruptions"][0].keys()),
            {"tool_name", "call_id_ref"},
        )


class TestBoundaryEnforcement(unittest.TestCase):
    """Phase D acceptance: no broad runtime support claim leaks in."""

    def test_validator_rejects_resumed_field(self):
        # Even if some future runtime hands us a resumed block, the
        # v1 validator must reject it. No silent pass-through.
        interruptions = capture_paused_approval([
            {"name": "write_file", "call_id": "c1"},
        ])
        artifact = emit_pause_artifact(
            framework="openai_agents_sdk",
            interruptions=interruptions,
            resume_state_ref=derive_resume_state_ref("s"),
        )
        # Simulate a non-pattern-compliant producer tacking on a resumed field.
        artifact["resumed"] = {"resume_decision": "approved"}
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(artifact)


if __name__ == "__main__":
    unittest.main()
