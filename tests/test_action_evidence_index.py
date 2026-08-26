"""Action evidence index consumer validator tests (Assay-Harness #177).

TDD suite for ci/validate_action_evidence_index.py and the harness-ci.yml
callsite. Loads the validator via importlib (no package import).

Run with:
    python3 -m unittest tests.test_action_evidence_index -v
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR_PATH = REPO_ROOT / "ci" / "validate_action_evidence_index.py"
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "harness-ci.yml"

SCHEMA = "assay-action-evidence-index/v1"
ASSAY_ACTION_PIN = (
    "Rul1an/assay-action@184720a5cb051ebc2c1de7e52b113aa973f2c374"
)
ONE_MIB = 1024 * 1024


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_validator():
    if not VALIDATOR_PATH.is_file():
        raise FileNotFoundError(f"missing validator module: {VALIDATOR_PATH}")
    spec = importlib.util.spec_from_file_location(
        "validate_action_evidence_index", VALIDATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load validator from {VALIDATOR_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _bundle(rel: str, content: bytes, *, integrity: str, source: str) -> dict:
    return {
        "integrity": integrity,
        "path": rel,
        "sha256": _sha256_hex(content),
        "source": source,
    }


def _index_payload(bundles: list[dict], *, complete: bool) -> dict:
    return {
        "bundles": bundles,
        "complete": complete,
        "schema": SCHEMA,
    }


def _write_index(workspace: Path, payload: dict, name: str = "index.json") -> tuple[Path, str]:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    path = workspace / name
    _write_bytes(path, raw)
    return path, _sha256_hex(raw)


def _plant_file(workspace: Path, rel: str, content: bytes = b"bundle-bytes") -> bytes:
    _write_bytes(workspace / rel, content)
    return content


class TestWorkflowCallsite(unittest.TestCase):
    """Read harness-ci.yml as text and lock the #177 callsite contract."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW_PATH.read_text(encoding="utf-8")

    def test_assay_action_pin_exactly_once(self):
        self.assertEqual(self.text.count(ASSAY_ACTION_PIN), 1)

    def test_validator_script_invoked(self):
        self.assertIn("ci/validate_action_evidence_index.py", self.text)

    def test_sandbox_command_and_required_evidence_mode(self):
        self.assertIn("sandbox-command:", self.text)
        self.assertIn("evidence_mode: required", self.text)

    def test_no_floating_v3_or_local_action(self):
        self.assertNotIn("Rul1an/assay-action@v3", self.text)
        self.assertNotIn("uses: ./assay-action", self.text)

    def test_no_expected_sha_or_action_pin_env(self):
        self.assertNotIn("EXPECTED_SHA", self.text)
        self.assertNotIn("ASSAY_ACTION_PIN", self.text)

    def test_verify_evidence_job_remains(self):
        self.assertIn("name: Verify Evidence", self.text)

    def test_later_require_slice_comment(self):
        self.assertIn("later require-slice", self.text)


class TestValidatorExportsAndPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_validator()

    def test_ceiling_constant_is_one_mib(self):
        self.assertEqual(self.mod.CONSUMER_INDEX_BYTES_CEILING, ONE_MIB)
        self.assertEqual(self.mod.CONSUMER_INDEX_BYTES_CEILING, 1024 * 1024)

    def test_source_contains_harness_resource_policy_phrases(self):
        src = VALIDATOR_PATH.read_text(encoding="utf-8")
        self.assertIn("Harness resource policy", src)
        self.assertIn("not a producer guarantee", src)

    def test_validation_error_is_exception(self):
        self.assertTrue(issubclass(self.mod.ValidationError, Exception))


class TestActionEvidenceIndexValidator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_validator()

    def _validate(self, workspace, index_path, digest, evidence_state, verified, if_present=False):
        return self.mod.validate_index(
            workspace,
            index_path,
            digest,
            evidence_state,
            verified,
            if_present=if_present,
        )

    def _expect_error(self, *args, substring=None, **kwargs):
        with self.assertRaises(self.mod.ValidationError) as ctx:
            self._validate(*args, **kwargs)
        if substring is not None:
            self.assertIn(substring, str(ctx.exception))
        return ctx.exception

    def test_green_upstream_plus_empty_state_fails(self):
        """A well-formed (green) index is still a failure when state is empty."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, ".assay/evidence/ok.tar.gz")
            bundles = [
                _bundle(
                    ".assay/evidence/ok.tar.gz",
                    content,
                    integrity="pending",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._expect_error(ws, index_path, digest, "", False)

    def test_index_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            index_path, digest = _write_index(
                ws, _index_payload([], complete=True)
            )
            bad = "0" * 64
            self.assertNotEqual(bad, digest)
            self._expect_error(ws, index_path, bad, "absent", False)

    def test_wrong_schema_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            payload = _index_payload([], complete=True)
            payload["schema"] = "assay-action-evidence-index/v0"
            index_path, digest = _write_index(ws, payload)
            self._expect_error(ws, index_path, digest, "absent", False)

    def test_missing_schema_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            payload = {"bundles": [], "complete": True}
            index_path, digest = _write_index(ws, payload)
            self._expect_error(ws, index_path, digest, "absent", False)

    def test_duplicate_json_keys_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            raw = (
                b'{"schema":"%s","schema":"%s","bundles":[],"complete":true}'
                % (SCHEMA.encode("ascii"), SCHEMA.encode("ascii"))
            )
            index_path = ws / "dup.json"
            _write_bytes(index_path, raw)
            self._expect_error(ws, index_path, _sha256_hex(raw), "absent", False)

    def test_unknown_top_level_member_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            payload = _index_payload([], complete=True)
            payload["extra"] = True
            index_path, digest = _write_index(ws, payload)
            self._expect_error(ws, index_path, digest, "absent", False)

    def test_unknown_bundle_member_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            row = _bundle(
                "evidence/a.tar.gz", content, integrity="pending", source="discovered"
            )
            row["note"] = "nope"
            payload = _index_payload([row], complete=False)
            index_path, digest = _write_index(ws, payload)
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_duplicate_path_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            row = _bundle(
                "evidence/a.tar.gz", content, integrity="pending", source="discovered"
            )
            payload = _index_payload([row, dict(row)], complete=False)
            index_path, digest = _write_index(ws, payload)
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_unsafe_path_dotdot_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            rel = "../outside.tar.gz"
            row = {
                "integrity": "pending",
                "path": rel,
                "sha256": "a" * 64,
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_unsafe_path_absolute_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            row = {
                "integrity": "pending",
                "path": "/tmp/abs.tar.gz",
                "sha256": "a" * 64,
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_unsafe_path_url_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            row = {
                "integrity": "pending",
                "path": "https://example.test/evil.tar.gz",
                "sha256": "a" * 64,
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_missing_listed_file_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            row = {
                "integrity": "pending",
                "path": "evidence/missing.tar.gz",
                "sha256": "a" * 64,
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(
                ws, index_path, digest, "discovered", False, substring="missing"
            )

    def test_planted_unindexed_in_scope_bundle_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, ".assay/evidence/listed.tar.gz")
            _plant_file(ws, ".assay/evidence/planted.tar.gz", b"unindexed-bytes")
            bundles = [
                _bundle(
                    ".assay/evidence/listed.tar.gz",
                    content,
                    integrity="pending",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._expect_error(
                ws, index_path, digest, "discovered", False, substring="unindexed"
            )

    def test_one_hundred_rows_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            bundles = []
            for i in range(100):
                rel = f".assay/evidence/b{i:03d}.tar.gz"
                content = _plant_file(ws, rel, f"row-{i}".encode("ascii"))
                bundles.append(
                    _bundle(rel, content, integrity="pending", source="discovered")
                )
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._validate(ws, index_path, digest, "discovered", False)

    def test_one_hundred_one_rows_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            bundles = []
            for i in range(101):
                rel = f".assay/evidence/b{i:03d}.tar.gz"
                content = _plant_file(ws, rel, f"row-{i}".encode("ascii"))
                bundles.append(
                    _bundle(rel, content, integrity="pending", source="discovered")
                )
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._expect_error(
                ws, index_path, digest, "discovered", False, substring="101"
            )

    def test_verified_output_with_non_verified_state_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a.tar.gz",
                    content,
                    integrity="verified",
                    source="sandbox_command",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=True)
            )
            self._expect_error(ws, index_path, digest, "discovered", True)
            self._expect_error(ws, index_path, digest, "absent", True)
            self._expect_error(ws, index_path, digest, "rejected", True)

    def test_empty_handshake_fails_without_if_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            self._expect_error(ws, "", "", "", "")

    def test_absent_empty_index_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            index_path, digest = _write_index(
                ws, _index_payload([], complete=True)
            )
            self._validate(ws, index_path, digest, "absent", False)

    def test_pending_discovered_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, ".assay/sandbox-command/evidence.tar.gz")
            bundles = [
                _bundle(
                    ".assay/sandbox-command/evidence.tar.gz",
                    content,
                    integrity="pending",
                    source="sandbox_command",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._validate(ws, index_path, digest, "discovered", False)

    def test_pending_plus_verified_state_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a.tar.gz",
                    content,
                    integrity="pending",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._expect_error(ws, index_path, digest, "verified", False)
            self._expect_error(ws, index_path, digest, "verified", True)

    def test_all_verified_plus_state_rejected_fails(self):
        """Lint is not rejection: all-verified rows cannot claim state=rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a.tar.gz",
                    content,
                    integrity="verified",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=True)
            )
            self._expect_error(ws, index_path, digest, "rejected", False)

    def test_all_rejected_plus_state_rejected_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a.tar.gz",
                    content,
                    integrity="rejected",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=True)
            )
            self._validate(ws, index_path, digest, "rejected", False)

    def test_bundle_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            rel = "evidence/a.tar.gz"
            content = _plant_file(ws, rel, b"original")
            row = _bundle(rel, content, integrity="pending", source="discovered")
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            (ws / rel).write_bytes(b"tampered")
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_over_one_mib_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            raw = b"{" + (b" " * ONE_MIB) + b"}"
            self.assertGreater(len(raw), ONE_MIB)
            index_path = ws / "huge.json"
            _write_bytes(index_path, raw)
            self._expect_error(
                ws, index_path, _sha256_hex(raw), "absent", False, substring="ceiling"
            )

    def test_if_present_empty_handshake_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            self._validate(ws, "", "", "", "", if_present=True)

    def test_if_present_partial_handshake_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            index_path, digest = _write_index(
                ws, _index_payload([], complete=True)
            )
            self._expect_error(ws, index_path, digest, "", "", if_present=True)
            self._expect_error(ws, index_path, "", "absent", False, if_present=True)
            self._expect_error(ws, "", digest, "absent", False, if_present=True)

    def test_verified_state_green_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a.tar.gz",
                    content,
                    integrity="verified",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=True)
            )
            self._validate(ws, index_path, digest, "verified", True)
            self._validate(ws, index_path, digest, "verified", "true")

    def test_cli_success_and_validation_and_usage_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            index_path, digest = _write_index(
                ws, _index_payload([], complete=True)
            )
            ok = subprocess.run(
                [
                    sys.executable,
                    str(VALIDATOR_PATH),
                    "--workspace",
                    str(ws),
                    "--index",
                    str(index_path),
                    "--digest",
                    digest,
                    "--evidence-state",
                    "absent",
                    "--verified",
                    "false",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(ok.returncode, 0, ok.stderr)

            bad = subprocess.run(
                [
                    sys.executable,
                    str(VALIDATOR_PATH),
                    "--workspace",
                    str(ws),
                    "--index",
                    str(index_path),
                    "--digest",
                    "0" * 64,
                    "--evidence-state",
                    "absent",
                    "--verified",
                    "false",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(bad.returncode, 2, bad.stderr)

            usage = subprocess.run(
                [sys.executable, str(VALIDATOR_PATH), "--no-such-flag"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(usage.returncode, 1)

            empty = subprocess.run(
                [
                    sys.executable,
                    str(VALIDATOR_PATH),
                    "--workspace",
                    str(ws),
                    "--index",
                    "",
                    "--digest",
                    "",
                    "--evidence-state",
                    "",
                    "--verified",
                    "",
                    "--if-present",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(empty.returncode, 0, empty.stderr)


if __name__ == "__main__":
    unittest.main()
