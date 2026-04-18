"""Runtime roundtrip: invoke adapter callback with real SDK types, pipe through mapper.

Requires claude-agent-sdk to be importable. Skipped if not.

To run locally:
    cd probes/claude_agent_sdk && source .venv/bin/activate
    cd ../.. && python3 -m unittest adapters.claude_agent_sdk.tests.test_roundtrip -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
MAPPER = REPO_ROOT / "mapper" / "map_to_assay.py"


try:
    import claude_agent_sdk  # noqa: F401
    _HAVE_SDK = True
except ImportError:
    _HAVE_SDK = False


@unittest.skipUnless(_HAVE_SDK, "claude-agent-sdk not installed")
class TestAdapterRoundtrip(unittest.TestCase):
    def test_adapter_produces_decision_v1_artifact(self):
        from adapters.claude_agent_sdk.run import _simulate_one_invocation
        import asyncio

        artifact = asyncio.run(_simulate_one_invocation())

        self.assertEqual(artifact["schema"], "assay.harness.policy-decision.v1")
        self.assertEqual(artifact["framework"], "claude_agent_sdk")
        self.assertEqual(artifact["surface"], "per_call_permission")
        self.assertEqual(artifact["decision"], "allow")
        self.assertEqual(artifact["tool_name"], "Bash")
        self.assertTrue(artifact["arguments_hash"].startswith("sha256:"))
        self.assertEqual(artifact["tool_use_id"], "toolu_demo_001")
        self.assertNotIn("interruptions", artifact)
        self.assertNotIn("continuation_anchor_ref", artifact)

    def test_adapter_output_maps_through_mapper(self):
        from adapters.claude_agent_sdk.run import _simulate_one_invocation
        import asyncio

        artifact = asyncio.run(_simulate_one_invocation())
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "decision.json"
            out_path = Path(tmp) / "out.ndjson"
            in_path.write_text(json.dumps(artifact))
            result = subprocess.run(
                [sys.executable, str(MAPPER), str(in_path), "--output", str(out_path)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, f"mapper failed: {result.stderr}")
            events = [
                json.loads(line) for line in out_path.read_text().splitlines() if line.strip()
            ]
            self.assertEqual(len(events), 1)
            self.assertEqual(
                events[0]["type"], "example.placeholder.harness.policy-decision"
            )
            self.assertEqual(
                events[0]["data"]["external_system"], "claude_agent_sdk"
            )
            self.assertEqual(
                events[0]["data"]["external_schema"], "assay.harness.policy-decision.v1"
            )

    def test_deny_path_produces_deny_artifact_with_reason(self):
        """Build a callback that denies by policy, verify decision_reason surfaces."""
        import asyncio
        from adapters.claude_agent_sdk.agent import build_can_use_tool_callback
        from claude_agent_sdk import ToolPermissionContext, PermissionResultDeny

        captured: list[dict] = []

        def always_deny(name, input_):
            return "deny", "denied by test policy"

        callback = build_can_use_tool_callback(
            decide=always_deny,
            policy_snapshot_hash="sha256:" + "ab" * 32,
            emit=captured.append,
        )

        ctx = ToolPermissionContext(signal=None, suggestions=[], tool_use_id="toolu_deny_1", agent_id=None)
        result = asyncio.run(callback("Bash", {"command": "rm -rf /"}, ctx))

        self.assertIsInstance(result, PermissionResultDeny)
        self.assertEqual(result.message, "denied by test policy")
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["decision"], "deny")
        self.assertEqual(captured[0]["decision_reason"], "denied by test policy")


if __name__ == "__main__":
    unittest.main()
