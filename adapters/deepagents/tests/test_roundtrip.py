"""Runtime roundtrip test: run real Deep Agents, emit artifact, pipe through mapper.

Requires deepagents + langgraph to be importable. If not, the test is
skipped so the standard `python3 -m unittest discover -s tests` flow on
the repo root (which does NOT install deepagents) stays green.

To run locally:
    cd probes/deepagents && source .venv/bin/activate
    cd ../.. && python3 -m unittest adapters.deepagents.tests.test_roundtrip -v
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
    import deepagents  # noqa: F401
    import langgraph  # noqa: F401
    _HAVE_RUNTIME = True
except ImportError:
    _HAVE_RUNTIME = False


@unittest.skipUnless(_HAVE_RUNTIME, "deepagents/langgraph not installed")
class TestAdapterRoundtrip(unittest.TestCase):
    """Adapter end-to-end: produce artifact, feed mapper, verify NDJSON."""

    def test_adapter_produces_pause_v1_artifact(self):
        from adapters.deepagents.run import run_to_pause_and_build_artifact

        artifact = run_to_pause_and_build_artifact()

        # Native Deep Agents contract markers
        self.assertEqual(artifact["framework"], "langgraph_deepagents")
        self.assertEqual(artifact["surface"], "tool_approval")
        self.assertEqual(artifact["pause_reason"], "tool_approval")

        # Correlation worked: tool_call_id present and looks like an id
        self.assertEqual(len(artifact["interruptions"]), 1)
        ix = artifact["interruptions"][0]
        self.assertTrue(ix["tool_call_id"])
        self.assertTrue(ix["arguments_hash"].startswith("sha256:"))
        self.assertEqual(ix["tool_name"], "execute")

        # Continuation anchor is present and public-named
        self.assertTrue(artifact["continuation_anchor_ref"].startswith("sha256:"))
        self.assertNotIn("resume_state_ref", artifact)

        # No resume lifecycle leaked
        for field in ("resume_nonce", "resumed", "resume_decision"):
            self.assertNotIn(field, artifact)

    def test_adapter_output_maps_through_mapper(self):
        """Artifact from the adapter must pass the existing mapper unchanged."""
        from adapters.deepagents.run import run_to_pause_and_build_artifact

        artifact = run_to_pause_and_build_artifact()
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "pause.json"
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
            self.assertEqual(len(events), 1, "pause-v1 must produce exactly one event")
            self.assertEqual(
                events[0]["data"]["external_system"], "langgraph_deepagents",
                "framework must be preserved through the mapper",
            )


if __name__ == "__main__":
    unittest.main()
