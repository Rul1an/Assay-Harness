"""Golden contract tests for the Assay-Harness mapper.

Validates envelope structure, hashing stability, NDJSON format,
mapper rejection behaviour, and event-type contracts against
checked-in golden fixtures.

Run with:
    python3 -m pytest tests/test_contracts.py -v
    python3 -m unittest tests.test_contracts -v
"""

from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths -- all relative to repo root so the suite works from the repo root.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
MAPPER = REPO_ROOT / "mapper" / "map_to_assay.py"

VALID_HARNESS = REPO_ROOT / "fixtures" / "valid.harness.json"
FAILURE_HARNESS = REPO_ROOT / "fixtures" / "failure.harness.json"
MALFORMED_HARNESS = REPO_ROOT / "fixtures" / "malformed.harness.json"

VALID_GOLDEN = REPO_ROOT / "fixtures" / "valid.assay.ndjson"
FAILURE_GOLDEN = REPO_ROOT / "fixtures" / "failure.assay.ndjson"

IMPORT_TIME = "2026-04-16T12:00:00Z"

# The 15 required CloudEvents + Assay envelope fields.
REQUIRED_ENVELOPE_FIELDS = {
    "specversion",
    "type",
    "source",
    "id",
    "time",
    "datacontenttype",
    "assayrunid",
    "assayseq",
    "assayproducer",
    "assayproducerversion",
    "assaygit",
    "assaypii",
    "assaysecrets",
    "assaycontenthash",
    "data",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_ndjson(path: Path) -> list[dict]:
    """Load an NDJSON file and return a list of parsed event dicts."""
    text = path.read_text(encoding="utf-8")
    lines = text.rstrip("\n").split("\n")
    return [json.loads(line) for line in lines]


def _run_mapper(
    input_path: Path,
    output_path: Path,
    import_time: str = IMPORT_TIME,
    extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess:
    """Run the mapper as a subprocess, returning the CompletedProcess."""
    cmd = [
        sys.executable,
        str(MAPPER),
        str(input_path),
        "--output", str(output_path),
        "--import-time", import_time,
        "--overwrite",
    ]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.run(cmd, capture_output=True, text=True)


def _write_fixture(tmpdir: str, name: str, data: dict) -> Path:
    """Write a temporary JSON fixture and return its path."""
    path = Path(tmpdir) / name
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _load_valid_harness() -> dict:
    """Load the valid harness fixture as a dict."""
    return json.loads(VALID_HARNESS.read_text(encoding="utf-8"))


# ===================================================================
# Envelope contract tests
# ===================================================================

class TestEnvelopeContract(unittest.TestCase):
    """Verify structural invariants of the Assay envelope."""

    @classmethod
    def setUpClass(cls):
        cls.valid_events = _load_ndjson(VALID_GOLDEN)
        cls.failure_events = _load_ndjson(FAILURE_GOLDEN)
        cls.all_events = cls.valid_events + cls.failure_events

    # 1
    def test_valid_ndjson_line_count(self):
        """valid.assay.ndjson has exactly 4 lines."""
        text = VALID_GOLDEN.read_text(encoding="utf-8")
        lines = [l for l in text.split("\n") if l]
        self.assertEqual(len(lines), 4)

    # 2
    def test_failure_ndjson_line_count(self):
        """failure.assay.ndjson has exactly 4 lines."""
        text = FAILURE_GOLDEN.read_text(encoding="utf-8")
        lines = [l for l in text.split("\n") if l]
        self.assertEqual(len(lines), 4)

    # 3
    def test_envelope_required_fields(self):
        """Every event has all 15 required envelope fields."""
        for i, event in enumerate(self.all_events):
            with self.subTest(event_index=i):
                missing = REQUIRED_ENVELOPE_FIELDS - set(event.keys())
                self.assertEqual(
                    missing, set(),
                    f"Event {i} missing fields: {missing}",
                )

    # 4
    def test_specversion_is_1_0(self):
        """Every event has specversion '1.0'."""
        for i, event in enumerate(self.all_events):
            with self.subTest(event_index=i):
                self.assertEqual(event["specversion"], "1.0")

    # 5
    def test_type_prefix(self):
        """Every event type starts with 'example.placeholder.harness.'."""
        for i, event in enumerate(self.all_events):
            with self.subTest(event_index=i):
                self.assertTrue(
                    event["type"].startswith("example.placeholder.harness."),
                    f"Event {i} type {event['type']!r} has wrong prefix",
                )

    # 6
    def test_assaycontenthash_format(self):
        """Every hash starts with 'sha256:' followed by 64 hex chars."""
        pattern = re.compile(r"^sha256:[0-9a-f]{64}$")
        for i, event in enumerate(self.all_events):
            with self.subTest(event_index=i):
                h = event["assaycontenthash"]
                self.assertRegex(h, pattern, f"Event {i} hash invalid: {h}")

    # 7
    def test_assayseq_is_ordered(self):
        """assayseq values are 0,1,2,3 in order within each file."""
        for label, events in [("valid", self.valid_events), ("failure", self.failure_events)]:
            with self.subTest(fixture=label):
                seqs = [e["assayseq"] for e in events]
                self.assertEqual(seqs, list(range(len(events))))

    # 8
    def test_assayrunid_consistent(self):
        """All events in a file share the same assayrunid."""
        for label, events in [("valid", self.valid_events), ("failure", self.failure_events)]:
            with self.subTest(fixture=label):
                run_ids = {e["assayrunid"] for e in events}
                self.assertEqual(
                    len(run_ids), 1,
                    f"{label}: expected one run id, got {run_ids}",
                )


# ===================================================================
# Hashing stability tests
# ===================================================================

class TestHashingStability(unittest.TestCase):
    """Verify determinism and sensitivity of content hashing."""

    # 9
    def test_hash_deterministic(self):
        """Running the mapper twice on the same input produces identical output."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out1 = Path(tmpdir) / "run1.ndjson"
            out2 = Path(tmpdir) / "run2.ndjson"

            r1 = _run_mapper(VALID_HARNESS, out1)
            r2 = _run_mapper(VALID_HARNESS, out2)

            self.assertEqual(r1.returncode, 0, f"Run 1 failed: {r1.stderr}")
            self.assertEqual(r2.returncode, 0, f"Run 2 failed: {r2.stderr}")

            self.assertEqual(
                out1.read_bytes(),
                out2.read_bytes(),
                "Two mapper runs on the same input produced different output",
            )

    # 10
    def test_hash_changes_on_input_change(self):
        """Modifying a field in the input changes content hashes."""
        with tempfile.TemporaryDirectory() as tmpdir:
            original = _load_valid_harness()
            modified = copy.deepcopy(original)
            modified["interruptions"][0]["tool_name"] = "delete_file"

            modified_path = _write_fixture(tmpdir, "modified.harness.json", modified)
            out_orig = Path(tmpdir) / "orig.ndjson"
            out_mod = Path(tmpdir) / "mod.ndjson"

            r1 = _run_mapper(VALID_HARNESS, out_orig)
            r2 = _run_mapper(modified_path, out_mod)

            self.assertEqual(r1.returncode, 0, f"Original run failed: {r1.stderr}")
            self.assertEqual(r2.returncode, 0, f"Modified run failed: {r2.stderr}")

            orig_events = _load_ndjson(out_orig)
            mod_events = _load_ndjson(out_mod)

            # At minimum the first event (approval-interruption) hash must differ
            self.assertNotEqual(
                orig_events[0]["assaycontenthash"],
                mod_events[0]["assaycontenthash"],
                "Hash did not change when input was modified",
            )

    # 11
    def test_golden_output_unchanged(self):
        """Mapper output matches the checked-in golden fixture byte-for-byte."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "valid.assay.ndjson"
            r = _run_mapper(VALID_HARNESS, out)
            self.assertEqual(r.returncode, 0, f"Mapper failed: {r.stderr}")
            self.assertEqual(
                out.read_bytes(),
                VALID_GOLDEN.read_bytes(),
                "Mapper output does not match checked-in golden fixture",
            )


# ===================================================================
# NDJSON ordering tests
# ===================================================================

class TestNdjsonOrdering(unittest.TestCase):
    """Verify canonical NDJSON formatting invariants."""

    @classmethod
    def setUpClass(cls):
        cls.valid_text = VALID_GOLDEN.read_text(encoding="utf-8")
        cls.failure_text = FAILURE_GOLDEN.read_text(encoding="utf-8")
        cls.all_texts = {
            "valid": cls.valid_text,
            "failure": cls.failure_text,
        }

    # 12
    def test_canonical_key_ordering(self):
        """Keys in each NDJSON line are alphabetically sorted."""
        for label, text in self.all_texts.items():
            for line_no, line in enumerate(text.rstrip("\n").split("\n"), start=1):
                with self.subTest(fixture=label, line=line_no):
                    # Use an ordered decoder to capture key order
                    from collections import OrderedDict
                    obj = json.loads(line, object_pairs_hook=OrderedDict)
                    keys = list(obj.keys())
                    self.assertEqual(
                        keys,
                        sorted(keys),
                        f"{label} line {line_no}: keys not sorted: {keys}",
                    )

    # 13
    def test_no_trailing_whitespace(self):
        """No trailing spaces on any line."""
        for label, text in self.all_texts.items():
            for line_no, line in enumerate(text.split("\n"), start=1):
                with self.subTest(fixture=label, line=line_no):
                    self.assertEqual(
                        line,
                        line.rstrip(" \t"),
                        f"{label} line {line_no} has trailing whitespace",
                    )

    # 14
    def test_single_newline_terminated(self):
        """File ends with exactly one newline."""
        for label, text in self.all_texts.items():
            with self.subTest(fixture=label):
                self.assertTrue(
                    text.endswith("\n"),
                    f"{label}: file does not end with a newline",
                )
                self.assertFalse(
                    text.endswith("\n\n"),
                    f"{label}: file ends with more than one trailing newline",
                )


# ===================================================================
# Mapper rejection tests
# ===================================================================

class TestMapperRejection(unittest.TestCase):
    """Verify the mapper rejects invalid inputs with non-zero exit codes."""

    # 15
    def test_malformed_rejected(self):
        """malformed.harness.json causes the mapper to exit non-zero."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(MALFORMED_HARNESS, out)
            self.assertNotEqual(
                r.returncode, 0,
                f"Mapper should have rejected malformed input but exited 0; "
                f"stderr: {r.stderr}",
            )

    # 16
    def test_malformed_rejects_raw_run_state(self):
        """Error message mentions 'raw_run_state'."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(MALFORMED_HARNESS, out)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(
                "raw_run_state",
                r.stderr,
                "Rejection message should mention 'raw_run_state'",
            )

    # 17
    def test_missing_interruptions_rejected(self):
        """Fixture with missing 'interruptions' key fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data = _load_valid_harness()
            del data["interruptions"]
            fixture = _write_fixture(tmpdir, "no_interruptions.json", data)
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(fixture, out)
            self.assertNotEqual(
                r.returncode, 0,
                f"Mapper should reject missing interruptions; stderr: {r.stderr}",
            )

    # 18
    def test_empty_interruptions_rejected(self):
        """Fixture with empty interruptions array fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data = _load_valid_harness()
            data["interruptions"] = []
            fixture = _write_fixture(tmpdir, "empty_interruptions.json", data)
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(fixture, out)
            self.assertNotEqual(
                r.returncode, 0,
                f"Mapper should reject empty interruptions; stderr: {r.stderr}",
            )

    # 19
    def test_bad_pause_reason_rejected(self):
        """Fixture with pause_reason != 'tool_approval' fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data = _load_valid_harness()
            data["pause_reason"] = "rate_limit"
            fixture = _write_fixture(tmpdir, "bad_pause.json", data)
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(fixture, out)
            self.assertNotEqual(
                r.returncode, 0,
                f"Mapper should reject bad pause_reason; stderr: {r.stderr}",
            )

    # 20
    def test_bad_resume_state_ref_rejected(self):
        """Fixture with non-sha256 resume_state_ref fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data = _load_valid_harness()
            data["resume_state_ref"] = "https://example.com/state/raw-dump"
            fixture = _write_fixture(tmpdir, "bad_ref.json", data)
            out = Path(tmpdir) / "out.ndjson"
            r = _run_mapper(fixture, out)
            self.assertNotEqual(
                r.returncode, 0,
                f"Mapper should reject non-sha256 resume_state_ref; stderr: {r.stderr}",
            )


# ===================================================================
# Event type contract tests
# ===================================================================

class TestEventTypeContract(unittest.TestCase):
    """Verify expected event types appear (or are absent) in fixtures."""

    @classmethod
    def setUpClass(cls):
        cls.valid_events = _load_ndjson(VALID_GOLDEN)
        cls.failure_events = _load_ndjson(FAILURE_GOLDEN)

    def _event_types(self, events: list[dict]) -> list[str]:
        return [e["type"] for e in events]

    # 21
    def test_valid_has_approval_interruption_event(self):
        """At least one event type ends with '.approval-interruption'."""
        types = self._event_types(self.valid_events)
        self.assertTrue(
            any(t.endswith(".approval-interruption") for t in types),
            f"No approval-interruption event found in valid fixture: {types}",
        )

    # 22
    def test_valid_has_policy_decision_event(self):
        """At least one '.policy-decision' event."""
        types = self._event_types(self.valid_events)
        self.assertTrue(
            any(t.endswith(".policy-decision") for t in types),
            f"No policy-decision event found in valid fixture: {types}",
        )

    # 23
    def test_valid_has_process_summary_event(self):
        """At least one '.process-summary' event."""
        types = self._event_types(self.valid_events)
        self.assertTrue(
            any(t.endswith(".process-summary") for t in types),
            f"No process-summary event found in valid fixture: {types}",
        )

    # 24
    def test_failure_has_no_resumed_run(self):
        """Failure fixture has no resumed-run event (input has no 'resumed' key)."""
        # Confirm the input fixture truly lacks a 'resumed' key.
        failure_input = json.loads(
            FAILURE_HARNESS.read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "resumed", failure_input,
            "Precondition violated: failure.harness.json unexpectedly has a 'resumed' key",
        )

        # Now check the golden output has no resumed-run event.
        types = self._event_types(self.failure_events)
        self.assertFalse(
            any(t.endswith(".resumed-run") for t in types),
            f"Failure fixture should not have a resumed-run event, but found: {types}",
        )


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    unittest.main()
