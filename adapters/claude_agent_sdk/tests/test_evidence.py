"""Pure unit tests for the policy-decision-v1 artifact builder.

No claude-agent-sdk installation needed. Tests the hashing,
Optional[tool_use_id] handling, and artifact shape in isolation.

    python3 -m unittest adapters.claude_agent_sdk.tests.test_evidence -v
"""

from __future__ import annotations

import unittest

from adapters.claude_agent_sdk.evidence import (
    ARTIFACT_SCHEMA,
    FRAMEWORK_NAME,
    SURFACE,
    UNRESOLVED_TOOL_USE_ID_PREFIX,
    build_policy_decision_artifact,
    hash_tool_input,
    resolve_tool_use_id,
)


POLICY_HASH = "sha256:" + "ab" * 32


class TestHashToolInput(unittest.TestCase):
    def test_returns_sha256_prefixed_hex(self):
        h = hash_tool_input({"command": "ls -la"})
        self.assertTrue(h.startswith("sha256:"))
        self.assertEqual(len(h), len("sha256:") + 64)

    def test_stable_across_key_order(self):
        self.assertEqual(
            hash_tool_input({"a": 1, "b": 2}),
            hash_tool_input({"b": 2, "a": 1}),
        )

    def test_distinguishes_raw_values(self):
        self.assertNotEqual(
            hash_tool_input({"command": "ls"}),
            hash_tool_input({"command": "rm -rf /"}),
        )


class TestResolveToolUseId(unittest.TestCase):
    def test_present_string_passed_through(self):
        got, synth = resolve_tool_use_id("toolu_01ABC")
        self.assertEqual(got, "toolu_01ABC")
        self.assertFalse(synth)

    def test_none_produces_flagged_fallback(self):
        got, synth = resolve_tool_use_id(None)
        self.assertTrue(got.startswith(UNRESOLVED_TOOL_USE_ID_PREFIX))
        self.assertTrue(synth)

    def test_empty_string_produces_fallback(self):
        got, synth = resolve_tool_use_id("")
        self.assertTrue(got.startswith(UNRESOLVED_TOOL_USE_ID_PREFIX))
        self.assertTrue(synth)

    def test_whitespace_string_produces_fallback(self):
        got, synth = resolve_tool_use_id("   ")
        self.assertTrue(got.startswith(UNRESOLVED_TOOL_USE_ID_PREFIX))
        self.assertTrue(synth)

    def test_fallback_never_looks_like_sdk_id(self):
        got, _ = resolve_tool_use_id(None)
        self.assertFalse(got.startswith("toolu_"))


class TestBuildArtifact(unittest.TestCase):
    def _call(self, **overrides):
        defaults = dict(
            tool_name="Bash",
            tool_input={"command": "ls -la"},
            tool_use_id="toolu_01ABC",
            decision="allow",
            policy_snapshot_hash=POLICY_HASH,
            timestamp="2026-04-18T10:00:00Z",
        )
        defaults.update(overrides)
        return build_policy_decision_artifact(**defaults)

    def test_produces_decision_v1_shape(self):
        art = self._call()
        self.assertEqual(art["schema"], ARTIFACT_SCHEMA)
        self.assertEqual(art["framework"], FRAMEWORK_NAME)
        self.assertEqual(art["surface"], SURFACE)

    def test_arguments_hash_is_sha256_not_raw(self):
        art = self._call()
        import json as _j
        self.assertTrue(art["arguments_hash"].startswith("sha256:"))
        self.assertNotIn("ls -la", _j.dumps(art))

    def test_no_pause_fields(self):
        """decision-v1 must not carry pause/resume fields."""
        art = self._call()
        for field in (
            "interruptions", "continuation_anchor_ref", "resume_state_ref",
            "resume_nonce", "resumed", "pause_reason",
        ):
            self.assertNotIn(field, art)

    def test_deny_with_reason(self):
        art = self._call(decision="deny", decision_reason="destructive shell blocked")
        self.assertEqual(art["decision"], "deny")
        self.assertEqual(art["decision_reason"], "destructive shell blocked")

    def test_allow_without_reason_omits_field(self):
        art = self._call(decision="allow")
        self.assertNotIn("decision_reason", art)

    def test_tool_use_id_none_produces_flagged_fallback(self):
        art = self._call(tool_use_id=None)
        self.assertTrue(art["tool_use_id"].startswith(UNRESOLVED_TOOL_USE_ID_PREFIX))

    def test_active_agent_ref_from_agent_id(self):
        art = self._call(active_agent_ref="subagent_xyz")
        self.assertEqual(art["active_agent_ref"], "subagent_xyz")

    def test_rejects_invalid_decision(self):
        with self.assertRaises(ValueError):
            self._call(decision="maybe")

    def test_rejects_bad_policy_snapshot_hash(self):
        with self.assertRaises(ValueError):
            self._call(policy_snapshot_hash="not-a-hash")

    def test_rejects_empty_decision_reason(self):
        with self.assertRaises(ValueError):
            self._call(decision="deny", decision_reason="")


if __name__ == "__main__":
    unittest.main()
