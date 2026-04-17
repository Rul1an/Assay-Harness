"""Deep Agents mapper contract tests.

Verifies that mapper/map_to_assay.py absorbs the Deep Agents pause-v1
artifact shape (framework=langgraph_deepagents, continuation_anchor_ref)
without structural changes to event output. See:
    docs/outreach/DEEPAGENTS_PREP.md           (seam and artifact shape)
    docs/outreach/DEEPAGENTS_MAPPER_SMOKECHECK.md  (fit findings)

Run with:
    python3 -m unittest tests.test_deepagents_contract -v
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MAPPER = REPO_ROOT / "mapper" / "map_to_assay.py"
DEEPAGENTS_VALID = REPO_ROOT / "fixtures" / "deepagents" / "valid.pause.deepagents.json"

IMPORT_TIME = "2026-04-17T12:00:00Z"


def _run_mapper(input_path: Path) -> tuple[int, str, list[dict]]:
    """Invoke the mapper, return (exit_code, stderr, parsed_events)."""
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "out.ndjson"
        result = subprocess.run(
            [
                sys.executable,
                str(MAPPER),
                str(input_path),
                "--output",
                str(out_path),
                "--import-time",
                IMPORT_TIME,
            ],
            capture_output=True,
            text=True,
        )
        events: list[dict] = []
        if out_path.exists():
            events = [
                json.loads(line) for line in out_path.read_text().splitlines() if line.strip()
            ]
        return result.returncode, result.stderr, events


class TestDeepAgentsPauseV1(unittest.TestCase):
    """Pause-v1 shape absorbs into the mapper; resume lifecycle is deferred."""

    def test_valid_pause_v1_maps_to_one_event(self):
        """A valid pause-v1 fixture produces exactly one approval-interruption event."""
        exit_code, stderr, events = _run_mapper(DEEPAGENTS_VALID)
        self.assertEqual(exit_code, 0, f"mapper failed: {stderr}")
        self.assertEqual(
            len(events),
            1,
            "pause-v1 should produce exactly one event (no resumed, no decisions, no summary)",
        )
        self.assertEqual(
            events[0]["type"],
            "example.placeholder.harness.approval-interruption",
        )

    def test_external_system_derives_from_framework(self):
        """external_system in the envelope must reflect the input framework."""
        _, _, events = _run_mapper(DEEPAGENTS_VALID)
        self.assertEqual(events[0]["data"]["external_system"], "langgraph_deepagents")

    def test_continuation_anchor_normalized_to_resume_state_ref(self):
        """Input continuation_anchor_ref normalizes to observed.resume_state_ref.

        The prep card documents this as intentional: resume_state_ref is the
        Assay-internal term, continuation_anchor_ref is the outward contract
        name on the adapter artifact. The evidence envelope is Assay-side.
        """
        _, _, events = _run_mapper(DEEPAGENTS_VALID)
        observed = events[0]["data"]["observed"]
        self.assertIn("resume_state_ref", observed)
        self.assertNotIn("continuation_anchor_ref", observed)
        self.assertTrue(observed["resume_state_ref"].startswith("sha256:"))

    def test_framework_preserved_in_observed(self):
        """The input framework value is preserved in observed, not silently rewritten."""
        _, _, events = _run_mapper(DEEPAGENTS_VALID)
        self.assertEqual(
            events[0]["data"]["observed"]["framework"],
            "langgraph_deepagents",
        )


class TestFrameworkAllowSet(unittest.TestCase):
    """Framework allow-set gating."""

    def test_unknown_framework_rejected(self):
        """Any framework outside the allow-set is rejected with a clear marker."""
        fixture = json.loads(DEEPAGENTS_VALID.read_text())
        fixture["framework"] = "some_unknown_runtime"
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "bad.json"
            in_path.write_text(json.dumps(fixture))
            exit_code, stderr, _ = _run_mapper(in_path)
            self.assertNotEqual(exit_code, 0)
            self.assertIn("REJECT_FRAMEWORK", stderr)


class TestAnchorAliasing(unittest.TestCase):
    """Anchor field aliasing: exactly one of resume_state_ref / continuation_anchor_ref."""

    def test_missing_anchor_rejected(self):
        fixture = json.loads(DEEPAGENTS_VALID.read_text())
        del fixture["continuation_anchor_ref"]
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "no_anchor.json"
            in_path.write_text(json.dumps(fixture))
            exit_code, stderr, _ = _run_mapper(in_path)
            self.assertNotEqual(exit_code, 0)
            self.assertIn("REJECT_MISSING_KEY", stderr)

    def test_both_anchors_rejected(self):
        """Ambiguous input: both anchor aliases present."""
        fixture = json.loads(DEEPAGENTS_VALID.read_text())
        fixture["resume_state_ref"] = fixture["continuation_anchor_ref"]
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "both.json"
            in_path.write_text(json.dumps(fixture))
            exit_code, stderr, _ = _run_mapper(in_path)
            self.assertNotEqual(exit_code, 0)
            self.assertIn("REJECT_AMBIGUOUS_ANCHOR", stderr)

    def test_js_side_resume_state_ref_still_accepted(self):
        """Backward compat: JS-SDK style input with resume_state_ref still works."""
        fixture = json.loads(DEEPAGENTS_VALID.read_text())
        fixture["framework"] = "openai_agents_sdk"
        fixture["resume_state_ref"] = fixture.pop("continuation_anchor_ref")
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "js_style.json"
            in_path.write_text(json.dumps(fixture))
            exit_code, stderr, events = _run_mapper(in_path)
            self.assertEqual(exit_code, 0, f"mapper failed: {stderr}")
            self.assertEqual(events[0]["data"]["external_system"], "openai_agents_sdk")


class TestPauseOnlyBoundary(unittest.TestCase):
    """Pause-v1 deliberately excludes resume lifecycle; absence is correct behavior."""

    def test_no_resumed_event_for_pause_only_fixture(self):
        _, _, events = _run_mapper(DEEPAGENTS_VALID)
        event_types = [e["type"] for e in events]
        self.assertNotIn("example.placeholder.harness.resumed-run", event_types)

    def test_no_process_summary_event_for_pause_only_fixture(self):
        _, _, events = _run_mapper(DEEPAGENTS_VALID)
        event_types = [e["type"] for e in events]
        self.assertNotIn("example.placeholder.harness.process-summary", event_types)


if __name__ == "__main__":
    unittest.main()
