"""Pure unit tests for the four paused-approval pattern helpers.

No SDK import. Tests capture reduction, continuation-anchor hashing,
artifact emission, and artifact validation in isolation.

    python3 -m unittest patterns.paused_approval.tests.test_helpers -v
"""

from __future__ import annotations

import unittest

from patterns.paused_approval.capture import capture_paused_approval
from patterns.paused_approval.emit import emit_pause_artifact
from patterns.paused_approval.fingerprint import derive_resume_state_ref
from patterns.paused_approval.validate import (
    PauseArtifactValidationError,
    validate_pause_artifact,
)


POLICY_HASH = "sha256:" + "ab" * 32
ANCHOR = "sha256:" + "cd" * 32


class TestCapture(unittest.TestCase):
    def test_passthrough_of_v1_named_fields(self):
        got = capture_paused_approval([
            {"tool_name": "execute", "call_id_ref": "call_1"},
        ])
        self.assertEqual(got, [{"tool_name": "execute", "call_id_ref": "call_1"}])

    def test_alias_call_id_to_ref(self):
        got = capture_paused_approval([
            {"tool_name": "execute", "call_id": "call_abc"},
        ])
        self.assertEqual(got[0]["call_id_ref"], "call_abc")

    def test_alias_tool_call_id_to_ref(self):
        """Richer lanes using tool_call_id still flow into the pattern."""
        got = capture_paused_approval([
            {"name": "write_file", "tool_call_id": "toolu_1"},
        ])
        self.assertEqual(got[0], {"tool_name": "write_file", "call_id_ref": "toolu_1"})

    def test_missing_tool_name_rejected(self):
        with self.assertRaises(ValueError) as cm:
            capture_paused_approval([{"call_id": "call_x"}])
        self.assertIn("tool_name", str(cm.exception))

    def test_missing_call_id_rejected(self):
        with self.assertRaises(ValueError) as cm:
            capture_paused_approval([{"tool_name": "execute"}])
        self.assertIn("call_id_ref", str(cm.exception))

    def test_non_dict_item_rejected(self):
        with self.assertRaises(ValueError):
            capture_paused_approval([["tool_name", "execute"]])  # list, not dict

    def test_reduction_drops_extra_fields(self):
        """Pattern v1 interruption item is strictly tool_name + call_id_ref."""
        got = capture_paused_approval([
            {
                "tool_name": "execute",
                "call_id_ref": "call_1",
                "arguments_hash": "sha256:x",
                "any_other_field": "ignored",
            },
        ])
        self.assertEqual(set(got[0].keys()), {"tool_name", "call_id_ref"})


class TestDeriveResumeStateRef(unittest.TestCase):
    def test_returns_sha256_prefix(self):
        got = derive_resume_state_ref("some-serialized-state")
        self.assertTrue(got.startswith("sha256:"))
        self.assertEqual(len(got), len("sha256:") + 64)

    def test_stable_on_identical_input(self):
        a = derive_resume_state_ref("x" * 100)
        b = derive_resume_state_ref("x" * 100)
        self.assertEqual(a, b)

    def test_changes_on_different_input(self):
        self.assertNotEqual(
            derive_resume_state_ref("state-a"),
            derive_resume_state_ref("state-b"),
        )

    def test_empty_string_rejected(self):
        with self.assertRaises(ValueError):
            derive_resume_state_ref("")

    def test_non_string_rejected(self):
        with self.assertRaises(ValueError):
            derive_resume_state_ref(None)  # type: ignore[arg-type]


class TestEmit(unittest.TestCase):
    def _call(self, **overrides):
        defaults = dict(
            framework="openai_agents_sdk",
            interruptions=[{"tool_name": "execute", "call_id_ref": "call_1"}],
            resume_state_ref=ANCHOR,
            timestamp="2026-04-18T10:00:00Z",
        )
        defaults.update(overrides)
        return emit_pause_artifact(**defaults)

    def test_shape(self):
        art = self._call()
        self.assertEqual(art["schema"], "assay.harness.approval-interruption.v1")
        self.assertEqual(art["framework"], "openai_agents_sdk")
        self.assertEqual(art["surface"], "tool_approval")
        self.assertEqual(art["pause_reason"], "tool_approval")
        self.assertEqual(art["resume_state_ref"], ANCHOR)
        self.assertEqual(art["timestamp"], "2026-04-18T10:00:00Z")

    def test_interruption_strict_reduction(self):
        """Emit strips any field beyond tool_name + call_id_ref."""
        art = self._call(interruptions=[
            {"tool_name": "t", "call_id_ref": "c", "extra": "ignored"},
        ])
        self.assertEqual(set(art["interruptions"][0].keys()), {"tool_name", "call_id_ref"})

    def test_reviewer_aids_optional(self):
        art = self._call(active_agent_ref="a1", last_agent_ref="a2", metadata_ref="m")
        self.assertEqual(art["active_agent_ref"], "a1")
        self.assertEqual(art["last_agent_ref"], "a2")
        self.assertEqual(art["metadata_ref"], "m")

    def test_rejects_empty_interruptions(self):
        with self.assertRaises(ValueError):
            self._call(interruptions=[])

    def test_rejects_bad_resume_state_ref(self):
        with self.assertRaises(ValueError):
            self._call(resume_state_ref="not-a-hash")

    def test_rejects_empty_framework(self):
        with self.assertRaises(ValueError):
            self._call(framework="")


class TestValidate(unittest.TestCase):
    def _ok(self, **overrides):
        art = emit_pause_artifact(
            framework="openai_agents_sdk",
            interruptions=[{"tool_name": "execute", "call_id_ref": "call_1"}],
            resume_state_ref=ANCHOR,
            timestamp="2026-04-18T10:00:00Z",
            **overrides,
        )
        return art

    def test_valid_minimum_passes(self):
        got = validate_pause_artifact(self._ok())
        self.assertIn("schema", got)

    def test_rejects_resumed_field(self):
        art = self._ok()
        art["resumed"] = {"resume_decision": "approved"}
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(art)
        self.assertIn("REJECT_FORBIDDEN", str(cm.exception))

    def test_rejects_resume_nonce(self):
        art = self._ok()
        art["resume_nonce"] = "a" * 32
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_rejects_raw_state(self):
        art = self._ok()
        art["raw_run_state"] = "<<huge blob>>"
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_rejects_history(self):
        art = self._ok()
        art["history"] = [{"role": "user", "content": "hi"}]
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_rejects_process_summary(self):
        art = self._ok()
        art["process_summary"] = {"approval_count": 1}
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_rejects_empty_interruptions(self):
        art = self._ok()
        art["interruptions"] = []
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(art)
        self.assertIn("REJECT_EMPTY_INTERRUPTIONS", str(cm.exception))

    def test_rejects_bad_pause_reason(self):
        art = self._ok()
        art["pause_reason"] = "lunch_break"
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(art)
        self.assertIn("REJECT_PAUSE_REASON", str(cm.exception))

    def test_rejects_url_resume_state_ref(self):
        art = self._ok()
        art["resume_state_ref"] = "sha256:https://example.com/state/raw"
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_tolerated_extension_arguments_hash_on_interruption(self):
        art = self._ok()
        art["interruptions"][0]["arguments_hash"] = "sha256:" + "ff" * 32
        validate_pause_artifact(art)  # must not raise

    def test_tolerated_extension_policy_snapshot_hash_top_level(self):
        art = self._ok()
        art["policy_snapshot_hash"] = POLICY_HASH
        validate_pause_artifact(art)  # must not raise

    def test_rejects_unknown_top_level_field(self):
        art = self._ok()
        art["unknown_field"] = "nope"
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)

    def test_rejects_unknown_interruption_field(self):
        art = self._ok()
        art["interruptions"][0]["extra_noise"] = "nope"
        with self.assertRaises(PauseArtifactValidationError):
            validate_pause_artifact(art)


class TestEndToEnd(unittest.TestCase):
    """capture -> fingerprint -> emit -> validate in one shot."""

    def test_minimal_happy_path(self):
        raw = [
            {"name": "write_file", "call_id": "call_happy_1"},
        ]
        interruptions = capture_paused_approval(raw)
        anchor = derive_resume_state_ref("fake-serialized-state")
        artifact = emit_pause_artifact(
            framework="openai_agents_sdk",
            interruptions=interruptions,
            resume_state_ref=anchor,
        )
        validate_pause_artifact(artifact)


if __name__ == "__main__":
    unittest.main()
