"""Pure unit tests for the pause-v1 artifact builder.

No deepagents / langgraph import needed. Tests the correlation logic,
hashing, and artifact shape in isolation. Runs in any Python env.

    python3 -m unittest adapters.deepagents.tests.test_evidence -v
"""

from __future__ import annotations

import unittest

from adapters.deepagents.evidence import (
    ARTIFACT_SCHEMA,
    FRAMEWORK_NAME,
    build_pause_artifact,
    compute_continuation_anchor_ref,
    correlate_action_requests_to_tool_calls,
    hash_arguments,
)


PLACEHOLDER_POLICY_HASH = "sha256:" + "ab" * 32


class _MsgLike:
    """Stand-in for a LangChain AIMessage for anchor hashing tests."""

    def __init__(self, data: dict) -> None:
        self._data = data

    def model_dump(self) -> dict:
        return dict(self._data)


class TestHashArguments(unittest.TestCase):
    def test_returns_sha256_prefixed_hex(self):
        h = hash_arguments({"command": "ls -la"})
        self.assertTrue(h.startswith("sha256:"))
        self.assertEqual(len(h), len("sha256:") + 64)

    def test_stable_across_key_order(self):
        self.assertEqual(
            hash_arguments({"a": 1, "b": 2}),
            hash_arguments({"b": 2, "a": 1}),
        )

    def test_distinguishes_different_values(self):
        self.assertNotEqual(
            hash_arguments({"command": "ls"}),
            hash_arguments({"command": "rm -rf /"}),
        )


class TestCorrelation(unittest.TestCase):
    def test_one_action_request_one_tool_call_matches(self):
        ar = [{"name": "execute", "args": {"x": 1}}]
        tc = [{"name": "execute", "args": {"x": 1}, "id": "call_abc"}]
        pairs = correlate_action_requests_to_tool_calls(ar, tc)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0][1]["id"], "call_abc")

    def test_multiple_same_name_matches_by_args(self):
        ar = [
            {"name": "execute", "args": {"cmd": "ls"}},
            {"name": "execute", "args": {"cmd": "pwd"}},
        ]
        tc = [
            {"name": "execute", "args": {"cmd": "pwd"}, "id": "call_B"},
            {"name": "execute", "args": {"cmd": "ls"}, "id": "call_A"},
        ]
        pairs = correlate_action_requests_to_tool_calls(ar, tc)
        ids = [p[1]["id"] for p in pairs]
        self.assertEqual(ids, ["call_A", "call_B"])

    def test_missing_tool_call_raises(self):
        ar = [{"name": "execute", "args": {}}]
        tc = [{"name": "other", "args": {}, "id": "call_x"}]
        with self.assertRaises(ValueError) as cm:
            correlate_action_requests_to_tool_calls(ar, tc)
        self.assertIn("correlation failed", str(cm.exception))

    def test_tool_call_without_id_raises(self):
        ar = [{"name": "execute", "args": {"x": 1}}]
        tc = [{"name": "execute", "args": {"x": 1}, "id": ""}]
        with self.assertRaises(ValueError) as cm:
            correlate_action_requests_to_tool_calls(ar, tc)
        self.assertIn("without an id", str(cm.exception))


class TestContinuationAnchor(unittest.TestCase):
    def test_returns_sha256(self):
        anchor = compute_continuation_anchor_ref(
            {"messages": [_MsgLike({"type": "human", "content": "hi"})]}
        )
        self.assertTrue(anchor.startswith("sha256:"))
        self.assertEqual(len(anchor), len("sha256:") + 64)

    def test_stable_on_identical_input(self):
        values = {"messages": [_MsgLike({"type": "human", "content": "hi"})]}
        a = compute_continuation_anchor_ref(values)
        b = compute_continuation_anchor_ref(values)
        self.assertEqual(a, b)

    def test_differs_on_different_content(self):
        a = compute_continuation_anchor_ref({"messages": [_MsgLike({"type": "human", "content": "a"})]})
        b = compute_continuation_anchor_ref({"messages": [_MsgLike({"type": "human", "content": "b"})]})
        self.assertNotEqual(a, b)


class TestBuildPauseArtifact(unittest.TestCase):
    def _call(self, **overrides):
        defaults = dict(
            action_requests=[{"name": "execute", "args": {"cmd": "ls"}, "description": "desc"}],
            tool_calls_on_last_ai_message=[{"name": "execute", "args": {"cmd": "ls"}, "id": "call_1"}],
            state_values={"messages": [_MsgLike({"type": "ai"})]},
            policy_snapshot_hash=PLACEHOLDER_POLICY_HASH,
            active_agent_ref="tiny-adapter",
            timestamp="2026-04-17T10:00:00Z",
        )
        defaults.update(overrides)
        return build_pause_artifact(**defaults)

    def test_produces_pause_v1_shape(self):
        art = self._call()
        self.assertEqual(art["schema"], ARTIFACT_SCHEMA)
        self.assertEqual(art["framework"], FRAMEWORK_NAME)
        self.assertEqual(art["surface"], "tool_approval")
        self.assertEqual(art["pause_reason"], "tool_approval")

    def test_tool_call_id_comes_from_state_not_action_request(self):
        art = self._call()
        self.assertEqual(art["interruptions"][0]["tool_call_id"], "call_1")

    def test_arguments_hash_is_sha256_not_raw(self):
        art = self._call()
        h = art["interruptions"][0]["arguments_hash"]
        self.assertTrue(h.startswith("sha256:"))
        # Verify raw args are nowhere in the artifact
        import json as _j
        self.assertNotIn("ls", _j.dumps(art["interruptions"]))

    def test_continuation_anchor_field_name_is_public(self):
        art = self._call()
        self.assertIn("continuation_anchor_ref", art)
        self.assertNotIn("resume_state_ref", art, "public artifact must not leak internal name")

    def test_no_resume_lifecycle_fields_present(self):
        """pause-v1 deliberately excludes resume_nonce / resumed / resumed_from."""
        art = self._call()
        for field in ("resume_nonce", "resumed", "resumed_from_artifact_hash", "resume_decision"):
            self.assertNotIn(field, art, f"pause-v1 must not carry {field}")

    def test_empty_interruptions_raises(self):
        with self.assertRaises(ValueError) as cm:
            self._call(action_requests=[], tool_calls_on_last_ai_message=[])
        self.assertIn("at least one interruption", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
