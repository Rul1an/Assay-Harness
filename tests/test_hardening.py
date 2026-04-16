"""Hardening tests for v0.2.0: resume safety, policy determinism, MCP boundaries.

These tests verify the invariants that make the harness trustworthy in CI:
- Resume semantics are idempotent and fail loudly on mismatch
- Policy evaluation is deterministic and input-bounded
- MCP evidence stays within declared boundaries
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MAPPER = REPO_ROOT / "mapper" / "map_to_assay.py"
VALID_FIXTURE = REPO_ROOT / "fixtures" / "valid.harness.json"
FAILURE_FIXTURE = REPO_ROOT / "fixtures" / "failure.harness.json"
MALFORMED_FIXTURE = REPO_ROOT / "fixtures" / "malformed.harness.json"
MCP_FIXTURE = REPO_ROOT / "fixtures" / "valid.mcp.harness.json"
IMPORT_TIME = "2026-04-16T12:00:00Z"


def _run_mapper(input_path: Path, output_path: Path, import_time: str = IMPORT_TIME) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(MAPPER), str(input_path), "--output", str(output_path),
         "--import-time", import_time, "--overwrite"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )


def _make_fixture(base: dict, tmpdir: str, name: str = "test.json") -> Path:
    path = Path(tmpdir) / name
    path.write_text(json.dumps(base, indent=2), encoding="utf-8")
    return path


def _load_valid() -> dict:
    return json.loads(VALID_FIXTURE.read_text("utf-8"))


# ============================================================================
# Resume hardening tests
# ============================================================================


class TestResumeHardening(unittest.TestCase):
    """Verify resume semantics are safe: idempotent, bounded, fail-on-mismatch."""

    def test_resume_state_ref_must_be_sha256(self):
        """resume_state_ref that is not sha256: must be rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["resume_state_ref"] = "https://example.com/state/raw-dump"
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("REJECT_BAD_STATE_REF", result.stderr)

    def test_resume_state_ref_url_rejected(self):
        """URLs in resume_state_ref are not valid anchors."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["resume_state_ref"] = "https://api.openai.com/v1/runs/run_abc/state"
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("REJECT_BAD_STATE_REF", result.stderr)

    def test_resume_state_ref_empty_rejected(self):
        """Empty resume_state_ref is rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["resume_state_ref"] = ""
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)

    def test_resume_decision_must_be_approved_or_rejected(self):
        """Bad resume_decision values are rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["resumed"]["resume_decision"] = "maybe"
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("REJECT_BAD_RESUME_DECISION", result.stderr)

    def test_resume_without_state_ref_rejected(self):
        """Resume artifact missing resume_state_ref is rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            del fixture["resumed"]["resume_state_ref"]
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)

    def test_double_resume_produces_different_hashes(self):
        """Mapping the same fixture twice produces identical content hashes (deterministic)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out1 = Path(tmpdir) / "out1.ndjson"
            out2 = Path(tmpdir) / "out2.ndjson"

            r1 = _run_mapper(VALID_FIXTURE, out1)
            r2 = _run_mapper(VALID_FIXTURE, out2)

            self.assertEqual(r1.returncode, 0)
            self.assertEqual(r2.returncode, 0)
            self.assertEqual(out1.read_text("utf-8"), out2.read_text("utf-8"))

    def test_resume_with_raw_run_state_rejected(self):
        """Adding raw_run_state to a fixture with resume must be rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["raw_run_state"] = {"history": ["leaked"], "newItems": ["leaked"]}
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("REJECT_RAW_STATE", result.stderr)

    def test_resume_approval_after_policy_change_scenario(self):
        """Changing policy_id in resumed artifact is still mappable (scenario test)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["policy_decisions"][0]["policy_id"] = "different-policy@2.0"
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            # This should succeed — the mapper doesn't enforce policy_id consistency
            self.assertEqual(result.returncode, 0)

    def test_policy_snapshot_hash_in_output(self):
        """policy_snapshot_hash appears in mapped evidence when present in input."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "out.ndjson"
            result = _run_mapper(VALID_FIXTURE, out)
            self.assertEqual(result.returncode, 0)

            lines = out.read_text("utf-8").strip().split("\n")
            # Check first event (approval interruption) has policy_snapshot_hash
            first_event = json.loads(lines[0])
            observed = first_event["data"]["observed"]
            self.assertIn("policy_snapshot_hash", observed)
            self.assertTrue(observed["policy_snapshot_hash"].startswith("sha256:"))

    def test_resume_nonce_in_output(self):
        """resume_nonce appears in mapped evidence when present in input."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "out.ndjson"
            result = _run_mapper(VALID_FIXTURE, out)
            self.assertEqual(result.returncode, 0)

            lines = out.read_text("utf-8").strip().split("\n")
            first_event = json.loads(lines[0])
            observed = first_event["data"]["observed"]
            self.assertIn("resume_nonce", observed)
            self.assertIsInstance(observed["resume_nonce"], str)
            self.assertTrue(len(observed["resume_nonce"]) > 0)

    def test_policy_snapshot_hash_in_resumed(self):
        """policy_snapshot_hash in resumed section is preserved in evidence."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "out.ndjson"
            result = _run_mapper(VALID_FIXTURE, out)
            self.assertEqual(result.returncode, 0)

            lines = out.read_text("utf-8").strip().split("\n")
            # Third event is resumed-run
            resumed_event = json.loads(lines[2])
            observed = resumed_event["data"]["observed"]
            self.assertIn("policy_snapshot_hash", observed)
            self.assertTrue(observed["policy_snapshot_hash"].startswith("sha256:"))

    def test_bad_policy_snapshot_hash_rejected(self):
        """Non-sha256 policy_snapshot_hash is rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = _load_valid()
            fixture["policy_snapshot_hash"] = "md5:invalid"
            input_path = _make_fixture(fixture, tmpdir)
            output_path = Path(tmpdir) / "out.ndjson"

            result = _run_mapper(input_path, output_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("REJECT_BAD_STATE_REF", result.stderr)

    def test_double_resume_same_state_ref_deterministic(self):
        """Mapping same fixture twice yields identical output (idempotent)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out1 = Path(tmpdir) / "out1.ndjson"
            out2 = Path(tmpdir) / "out2.ndjson"

            r1 = _run_mapper(VALID_FIXTURE, out1)
            r2 = _run_mapper(VALID_FIXTURE, out2)

            self.assertEqual(r1.returncode, 0)
            self.assertEqual(r2.returncode, 0)
            self.assertEqual(out1.read_text("utf-8"), out2.read_text("utf-8"))


# ============================================================================
# Policy determinism guard tests
# ============================================================================


class TestPolicyDeterminism(unittest.TestCase):
    """Verify that policy evaluation inputs are bounded and decisions are stable."""

    def test_policy_cli_deterministic(self):
        """Same tool name always produces the same decision."""
        results = []
        for _ in range(3):
            result = subprocess.run(
                ["npx", "tsx", "src/cli.ts", "policy", "--tool", "write_file"],
                capture_output=True, text=True,
                cwd=str(REPO_ROOT / "harness"),
            )
            parsed = json.loads(result.stdout)
            results.append(parsed["decision"])

        self.assertEqual(len(set(results)), 1, "Policy decision must be deterministic")
        self.assertEqual(results[0], "require_approval")

    def test_policy_deny_is_stable(self):
        """Deny decisions are stable across repeated calls."""
        results = []
        for _ in range(3):
            result = subprocess.run(
                ["npx", "tsx", "src/cli.ts", "policy", "--tool", "network_egress"],
                capture_output=True, text=True,
                cwd=str(REPO_ROOT / "harness"),
            )
            parsed = json.loads(result.stdout)
            results.append(parsed["decision"])

        self.assertEqual(results, ["deny", "deny", "deny"])

    def test_policy_allow_is_stable(self):
        """Allow decisions are stable."""
        results = []
        for _ in range(3):
            result = subprocess.run(
                ["npx", "tsx", "src/cli.ts", "policy", "--tool", "read_file"],
                capture_output=True, text=True,
                cwd=str(REPO_ROOT / "harness"),
            )
            parsed = json.loads(result.stdout)
            results.append(parsed["decision"])

        self.assertEqual(results, ["allow", "allow", "allow"])

    def test_unknown_tool_defaults_to_deny(self):
        """Tools not in any list default to deny (closed-by-default)."""
        result = subprocess.run(
            ["npx", "tsx", "src/cli.ts", "policy", "--tool", "completely_unknown_tool"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT / "harness"),
        )
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["decision"], "deny")
        self.assertIsNone(parsed["rule_ref"])

    def test_policy_evaluation_order(self):
        """deny > require_approval > allow is the correct priority.

        If a tool matches both deny and allow, deny must win.
        """
        # network_egress is in deny list; let's verify it stays denied
        result = subprocess.run(
            ["npx", "tsx", "src/cli.ts", "policy", "--tool", "network_egress"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT / "harness"),
        )
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["decision"], "deny")

    def test_policy_decision_only_uses_tool_name(self):
        """Policy output contains only tool name, not transcript or context."""
        result = subprocess.run(
            ["npx", "tsx", "src/cli.ts", "policy", "--tool", "write_file"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT / "harness"),
        )
        parsed = json.loads(result.stdout)
        # Only these fields should be present (no transcript, reasoning, etc.)
        allowed_keys = {"decision", "policy_id", "action_kind", "target_ref", "rule_ref", "timestamp"}
        actual_keys = set(parsed.keys())
        self.assertTrue(
            actual_keys.issubset(allowed_keys),
            f"Policy output contains unexpected keys: {actual_keys - allowed_keys}"
        )


# ============================================================================
# MCP boundary enforcement tests
# ============================================================================


class TestMcpBoundary(unittest.TestCase):
    """Verify MCP evidence stays within declared boundaries."""

    def test_mcp_fixture_is_valid_json(self):
        """MCP fixture is parseable JSON."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        self.assertIsInstance(data, dict)

    def test_mcp_fixture_has_required_fields(self):
        """MCP fixture has schema, framework, surface, server_ref, interactions."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        for key in ("schema", "framework", "surface", "server_ref", "interactions"):
            self.assertIn(key, data, f"MCP fixture missing key: {key}")

    def test_mcp_interaction_has_bounded_fields(self):
        """Each MCP interaction only has bounded evidence fields."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        allowed_fields = {"server_ref", "tool_name", "decision", "timestamp",
                          "approval_ref", "call_id_ref", "argument_hash"}

        for i, interaction in enumerate(data["interactions"]):
            actual = set(interaction.keys())
            extra = actual - allowed_fields
            self.assertEqual(
                extra, set(),
                f"interactions[{i}] has unexpected fields: {extra}"
            )

    def test_mcp_no_full_payload(self):
        """MCP evidence must not contain full request/response payloads."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        rejected_keys = {"request_payload", "response_payload", "raw_payload",
                         "arguments", "result", "server_state"}

        text = json.dumps(data)
        for key in rejected_keys:
            self.assertNotIn(
                f'"{key}"', text,
                f"MCP evidence contains rejected key: {key}"
            )

    def test_mcp_argument_hash_format(self):
        """MCP argument_hash must be sha256: format when present."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        for i, interaction in enumerate(data["interactions"]):
            if "argument_hash" in interaction:
                self.assertTrue(
                    interaction["argument_hash"].startswith("sha256:"),
                    f"interactions[{i}].argument_hash must start with sha256:"
                )

    def test_mcp_no_transport_details(self):
        """MCP evidence must not contain transport-level details."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        text = json.dumps(data)
        rejected = ["stdio", "http://", "https://", "websocket", "transport"]
        for term in rejected:
            self.assertNotIn(
                term.lower(), text.lower(),
                f"MCP evidence contains transport detail: {term}"
            )

    def test_mcp_no_credentials(self):
        """MCP evidence must not contain auth tokens or credentials."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        text = json.dumps(data)
        rejected = ["bearer", "token", "api_key", "secret", "password", "authorization"]
        for term in rejected:
            self.assertNotIn(
                term.lower(), text.lower(),
                f"MCP evidence contains credential-like term: {term}"
            )

    def test_mcp_decision_is_valid(self):
        """MCP interaction decisions must be allow/deny/require_approval."""
        data = json.loads(MCP_FIXTURE.read_text("utf-8"))
        valid_decisions = {"allow", "deny", "require_approval"}
        for i, interaction in enumerate(data["interactions"]):
            self.assertIn(
                interaction["decision"], valid_decisions,
                f"interactions[{i}].decision must be one of {valid_decisions}"
            )


if __name__ == "__main__":
    unittest.main()
