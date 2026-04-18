"""Fixture corpus test: every fixture must behave as declared by name.

valid.* must pass validate_pause_artifact.
failure.* must pass (it is still a well-formed artifact; the name
means it is a semantically denial-worthy pause, not a malformed one).
malformed_* must fail validate_pause_artifact with an explicit marker.

PLAN P23A section 9 Phase C acceptance:
    - valid maps
    - failure maps
    - malformed fails fast

    python3 -m unittest patterns.paused_approval.tests.test_fixtures -v
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from patterns.paused_approval.validate import (
    PauseArtifactValidationError,
    validate_pause_artifact,
)


FIX_DIR = Path(__file__).resolve().parent.parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIX_DIR / name).read_text())


class TestValidFixture(unittest.TestCase):
    def test_valid_passes_pattern_validator(self):
        validate_pause_artifact(_load("valid.paused.json"))

    def test_valid_has_pattern_minimum(self):
        art = _load("valid.paused.json")
        self.assertEqual(art["schema"], "assay.harness.approval-interruption.v1")
        self.assertEqual(art["pause_reason"], "tool_approval")
        self.assertTrue(art["resume_state_ref"].startswith("sha256:"))
        self.assertEqual(set(art["interruptions"][0].keys()), {"tool_name", "call_id_ref"})


class TestFailureFixture(unittest.TestCase):
    """failure = semantically denial-worthy but structurally valid pause."""

    def test_failure_passes_pattern_validator(self):
        validate_pause_artifact(_load("failure.paused.json"))

    def test_failure_carries_multiple_interruptions(self):
        art = _load("failure.paused.json")
        self.assertGreater(len(art["interruptions"]), 1)


class TestMalformedFixtures(unittest.TestCase):

    def test_empty_interruptions_rejected(self):
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(_load("malformed_empty_interruptions.paused.json"))
        self.assertIn("REJECT_EMPTY_INTERRUPTIONS", str(cm.exception))

    def test_resumed_field_rejected(self):
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(_load("malformed_resumed_field.paused.json"))
        self.assertIn("REJECT_FORBIDDEN", str(cm.exception))
        self.assertIn("resumed", str(cm.exception))

    def test_url_state_ref_rejected(self):
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(_load("malformed_url_state_ref.paused.json"))
        self.assertIn("REJECT_BAD_STATE_REF", str(cm.exception))

    def test_raw_state_inline_rejected(self):
        with self.assertRaises(PauseArtifactValidationError) as cm:
            validate_pause_artifact(_load("malformed_raw_state_inline.paused.json"))
        self.assertIn("REJECT_FORBIDDEN", str(cm.exception))
        self.assertIn("raw_run_state", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
