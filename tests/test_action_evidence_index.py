"""Action evidence index consumer validator tests (Assay-Harness #177).

TDD suite for ci/validate_action_evidence_index.py and the harness-ci.yml
callsite. Loads the validator via importlib (no package import).

Run with:
    python3 -m unittest tests.test_action_evidence_index -v
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


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


def _unbounded_read_bytes(_self):
    raise AssertionError("unbounded Path.read_bytes")


_JS_YAML_LOAD = (
    "import { load } from 'js-yaml';"
    "import { readFileSync } from 'fs';"
    "const doc = load(readFileSync(process.argv[1], 'utf8'));"
    "process.stdout.write(JSON.stringify(doc));"
)


def _load_workflow():
    """One structural parse via pinned harness js-yaml 5.2.2 (not PyYAML)."""
    js_yaml = REPO_ROOT / "harness" / "node_modules" / "js-yaml"
    if not js_yaml.is_dir():
        raise AssertionError(
            "js-yaml 5.2.2 is not installed; the Action Evidence Index job "
            "must run ./.github/actions/setup-node-harness before tests"
        )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _JS_YAML_LOAD, str(WORKFLOW_PATH)],
        cwd=str(REPO_ROOT / "harness"),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError(f"js-yaml parse failed: {proc.stderr}")
    return json.loads(proc.stdout)


def _action_evidence_index_job(data=None):
    data = data if data is not None else _load_workflow()
    jobs = data["jobs"]
    job = jobs.get("action-evidence-index")
    if job is None:
        for candidate in jobs.values():
            if candidate.get("name") == "Action Evidence Index":
                return candidate
        raise AssertionError("missing action-evidence-index job")
    return job


def _validate_action_evidence_index_step(data=None):
    job = _action_evidence_index_job(data)
    for step in job["steps"]:
        if step.get("name") == "Validate action evidence index":
            return step
    raise AssertionError("missing Validate action evidence index step")


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


class TestWorkflowStructuralGuard(unittest.TestCase):
    """Parse harness-ci.yml with pinned js-yaml 5.2.2 and lock the Validate step funnel."""

    @classmethod
    def setUpClass(cls):
        cls.data = _load_workflow()
        cls.step = _validate_action_evidence_index_step(cls.data)

    def test_validate_step_is_enabled(self):
        if_val = self.step.get("if", None)
        disabled = {False, "false", "False"}
        self.assertTrue(if_val is None or if_val not in disabled, if_val)

    def test_validate_step_env_bindings(self):
        env = self.step["env"]
        expected = {
            "INDEX_PATH": "${{ steps.assay.outputs.evidence_index_path }}",
            "INDEX_DIGEST": "${{ steps.assay.outputs.evidence_index_digest }}",
            "EVIDENCE_STATE": "${{ steps.assay.outputs.evidence_state }}",
            "VERIFIED": "${{ steps.assay.outputs.verified }}",
        }
        self.assertEqual(env, expected)
        self.assertEqual(set(env), set(expected))

    def test_validate_step_run_cli(self):
        run = self.step["run"]
        self.assertIn("python3 ci/validate_action_evidence_index.py", run)
        for flag in (
            "--workspace",
            "--index",
            "--digest",
            "--evidence-state",
            "--verified",
            "--if-present",
        ):
            self.assertIn(flag, run)

    def test_this_module_does_not_import_pyyaml(self):
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotEqual(alias.name, "yaml")
                    self.assertFalse(alias.name.startswith("yaml."))
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                self.assertNotEqual(mod, "yaml")
                self.assertFalse(mod.startswith("yaml."))

    def test_load_workflow_uses_js_yaml_not_pyyaml(self):
        self.assertIn("js-yaml", _JS_YAML_LOAD)
        self.assertIn("from 'js-yaml'", _JS_YAML_LOAD)
        helper = Path(__file__).read_text(encoding="utf-8")
        start = helper.index("def _load_workflow(")
        end = helper.index("def _action_evidence_index_job(")
        body = helper[start:end]
        self.assertIn("_JS_YAML_LOAD", body)
        self.assertNotIn("safe_load", body)

    def test_js_yaml_lockfile_is_5_2_2(self):
        lock = json.loads(
            (REPO_ROOT / "harness" / "package-lock.json").read_text(encoding="utf-8")
        )
        self.assertEqual(lock["packages"]["node_modules/js-yaml"]["version"], "5.2.2")

    def test_job_installs_js_yaml_via_setup_node_harness_before_tests(self):
        job = _action_evidence_index_job(self.data)
        uses = [step.get("uses") for step in job["steps"]]
        names = [step.get("name") for step in job["steps"]]
        self.assertIn("./.github/actions/setup-node-harness", uses)
        harness_i = uses.index("./.github/actions/setup-node-harness")
        test_i = names.index("Run action evidence index tests")
        self.assertLess(harness_i, test_i)


class TestValidatorExportsAndPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_validator()

    def test_ceiling_constant_is_one_mib(self):
        self.assertEqual(self.mod.CONSUMER_INDEX_BYTES_CEILING, ONE_MIB)
        self.assertEqual(self.mod.CONSUMER_INDEX_BYTES_CEILING, 1024 * 1024)

    def test_bundle_ceiling_constants(self):
        self.assertTrue(hasattr(self.mod, "CONSUMER_BUNDLE_BYTES_CEILING"))
        self.assertTrue(hasattr(self.mod, "CONSUMER_BUNDLE_BYTES_AGGREGATE"))
        self.assertEqual(self.mod.CONSUMER_BUNDLE_BYTES_CEILING, ONE_MIB)
        self.assertEqual(self.mod.CONSUMER_BUNDLE_BYTES_CEILING, 1024 * 1024)
        self.assertEqual(
            self.mod.CONSUMER_BUNDLE_BYTES_AGGREGATE,
            self.mod.MAX_BUNDLE_ROWS * self.mod.CONSUMER_BUNDLE_BYTES_CEILING,
        )
        self.assertEqual(self.mod.CONSUMER_BUNDLE_BYTES_AGGREGATE, 100 * ONE_MIB)

    def test_containment_predicate_pinned_in_source(self):
        src = VALIDATOR_PATH.read_text(encoding="utf-8")
        self.assertTrue(
            "escapes workspace" in src or "root not in resolved.parents" in src,
            "containment predicate missing from validator source",
        )

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


    def test_index_reader_never_uses_path_read_bytes(self):
        """A small valid absent index must validate without Path.read_bytes."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            index_path, digest = _write_index(ws, _index_payload([], complete=True))
            with patch.object(Path, "read_bytes", _unbounded_read_bytes):
                self._validate(ws, index_path, digest, "absent", False)

    def test_index_growth_after_stat_does_not_materialize_past_ceiling(self):
        """Lying st_size must not cause an unbounded Path.read_bytes of a >1MiB index."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            raw = b"{" + (b" " * ONE_MIB) + b"}"
            self.assertGreater(len(raw), ONE_MIB)
            index_path = ws / "huge.json"
            _write_bytes(index_path, raw)
            index_stat = os.stat(index_path)
            real_stat = Path.stat
            real_read_bytes = Path.read_bytes
            materialized: list[int] = []

            def lying_stat(self, *args, **kwargs):
                result = real_stat(self, *args, **kwargs)
                if (result.st_dev, result.st_ino) == (index_stat.st_dev, index_stat.st_ino):
                    vals = list(result)
                    vals[6] = 64  # st_size
                    return os.stat_result(vals)
                return result

            def spy_read_bytes(self):
                data = real_read_bytes(self)
                materialized.append(len(data))
                return data

            with patch.object(Path, "stat", lying_stat), patch.object(
                Path, "read_bytes", spy_read_bytes
            ):
                self._expect_error(
                    ws,
                    index_path,
                    _sha256_hex(raw),
                    "absent",
                    False,
                    substring="ceiling",
                )
            self.assertTrue(
                (not materialized) or all(n <= ONE_MIB + 1 for n in materialized),
                f"materialized unbounded lengths: {materialized}",
            )

    def test_bundle_hashing_never_uses_path_read_bytes(self):
        """Green discovered index + planted bundle must hash without Path.read_bytes."""
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
            with patch.object(Path, "read_bytes", _unbounded_read_bytes):
                self._validate(ws, index_path, digest, "discovered", False)

    def test_dot_segment_pair_is_same_identity(self):
        """evidence/a.tar.gz and evidence/./a.tar.gz are one identity; ./ is non-canonical."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            sha = _sha256_hex(content)
            canon = {
                "integrity": "pending",
                "path": "evidence/a.tar.gz",
                "sha256": sha,
                "source": "discovered",
            }
            dotted = dict(canon, path="evidence/./a.tar.gz")
            pair_path, pair_digest = _write_index(
                ws, _index_payload([canon, dotted], complete=False)
            )
            self._expect_error(ws, pair_path, pair_digest, "discovered", False)
            single_path, single_digest = _write_index(
                ws,
                _index_payload([dotted], complete=False),
                name="index-dot.json",
            )
            self._expect_error(ws, single_path, single_digest, "discovered", False)

    def test_nul_path_is_validation_error_not_valueerror(self):
        """NUL in a JSON path is ValidationError (explicit), never bare ValueError / traceback."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a.tar.gz")
            row = _bundle(
                "evidence/a.tar.gz",
                content,
                integrity="pending",
                source="discovered",
            )
            row["path"] = "evidence/a.tar.gz\u0000"
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            try:
                self._validate(ws, index_path, digest, "discovered", False)
            except self.mod.ValidationError as exc:
                msg = str(exc)
                self.assertNotIn("embedded null character", msg)
                self.assertTrue("NUL" in msg or "unsafe path" in msg, msg)
            except ValueError as exc:
                self.fail(f"ValueError leaked: {exc}")
            else:
                self.fail("expected ValidationError")

            proc = subprocess.run(
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
                    "discovered",
                    "--verified",
                    "false",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertTrue(proc.stderr.strip())
            self.assertNotIn("Traceback", proc.stderr)
            self.assertNotIn("Traceback", proc.stdout)
            self.assertNotIn("embedded null character", proc.stderr)
            self.assertNotIn("embedded null character", proc.stdout)

    def test_backslash_and_drive_aliases_refused(self):
        """Backslash and drive-letter aliases are ValidationError, not ValueError."""
        aliases = (
            "evidence\\a.tar.gz",
            "C:/evil.tar.gz",
            "C:\\evil.tar.gz",
        )
        for rel in aliases:
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as tmp:
                ws = Path(tmp)
                row = {
                    "integrity": "pending",
                    "path": rel,
                    "sha256": "a" * 64,
                    "source": "discovered",
                }
                index_path, digest = _write_index(
                    ws, _index_payload([row], complete=False)
                )
                try:
                    self._validate(ws, index_path, digest, "discovered", False)
                except self.mod.ValidationError:
                    pass
                except ValueError as exc:
                    self.fail(f"ValueError leaked for {rel!r}: {exc}")
                else:
                    self.fail(f"expected ValidationError for {rel!r}")


    def test_absolute_index_path_rejected(self):
        """Absolute index in a separate temp dir must fail before a successful read."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            ws = base / "ws"
            other = base / "other"
            ws.mkdir()
            other.mkdir()
            index_path, digest = _write_index(other, _index_payload([], complete=True))
            opened = []
            real_open = Path.open

            def spy_open(self, *args, **kwargs):
                opened.append(Path(self).resolve())
                return real_open(self, *args, **kwargs)

            with patch.object(Path, "open", spy_open):
                self._expect_error(ws, str(index_path), digest, "absent", False)
            outside = Path(index_path).resolve()
            self.assertNotIn(outside, opened)

    def test_outside_relative_index_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            ws = base / "ws"
            other = base / "other"
            ws.mkdir()
            other.mkdir()
            _index_path, digest = _write_index(other, _index_payload([], complete=True))
            self._expect_error(
                ws, "../other/index.json", digest, "absent", False, substring="unsafe"
            )

    def test_symlinked_index_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            real_path, digest = _write_index(
                ws, _index_payload([], complete=True), name="real.json"
            )
            link = ws / "link.json"
            link.symlink_to(real_path)
            opened = []
            real_open = Path.open

            def spy_open(self, *args, **kwargs):
                opened.append(Path(self).resolve())
                return real_open(self, *args, **kwargs)

            with patch.object(Path, "open", spy_open):
                self._expect_error(
                    ws, str(link), digest, "absent", False, substring="symlink"
                )
            self.assertNotIn(Path(real_path).resolve(), opened)

    def test_symlinked_parent_dir_index_rejected(self):
        """alias -> real plus alias/index.json is a second identity; reject before read."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            real_dir = ws / "real"
            real_dir.mkdir()
            index_path, digest = _write_index(
                real_dir, _index_payload([], complete=True)
            )
            alias = ws / "alias"
            alias.symlink_to(real_dir)
            opened = []
            real_open = Path.open

            def spy_open(self, *args, **kwargs):
                opened.append(Path(self).resolve())
                return real_open(self, *args, **kwargs)

            with patch.object(Path, "open", spy_open):
                self._expect_error(
                    ws, "alias/index.json", digest, "absent", False, substring="symlink"
                )
            self.assertNotIn(Path(index_path).resolve(), opened)
            # Positive pair: the canonical relative path still validates.
            self._validate(ws, "real/index.json", digest, "absent", False)

    def test_two_mib_bundle_exceeds_per_bundle_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = b"B" * (2 * ONE_MIB)
            _plant_file(ws, "evidence/a.tar.gz", content)
            row = _bundle(
                "evidence/a.tar.gz", content, integrity="pending", source="discovered"
            )
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            exc = self._expect_error(ws, index_path, digest, "discovered", False)
            msg = str(exc).lower()
            self.assertTrue("ceiling" in msg or "bundle" in msg, str(exc))

    def test_bundle_hash_stops_at_per_bundle_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = b"C" * (2 * ONE_MIB)
            rel = "evidence/a.tar.gz"
            bundle_path = ws / rel
            _plant_file(ws, rel, content)
            row = _bundle(rel, content, integrity="pending", source="discovered")
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            bytes_read = [0]
            real_open = Path.open

            def spy_open(self, *args, **kwargs):
                fh = real_open(self, *args, **kwargs)
                try:
                    same = Path(self).resolve() == bundle_path.resolve()
                except OSError:
                    same = False
                if same:
                    inner = fh.read

                    def spy_read(n=-1):
                        data = inner(n)
                        bytes_read[0] += len(data)
                        return data

                    fh.read = spy_read
                return fh

            with patch.object(Path, "open", spy_open):
                with self.assertRaises(self.mod.ValidationError):
                    self._validate(ws, index_path, digest, "discovered", False)
            chunk = self.mod.BUNDLE_HASH_CHUNK_BYTES
            self.assertLessEqual(bytes_read[0], ONE_MIB + chunk)

    def test_unindexed_stops_without_full_enumeration(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, ".assay/evidence/listed.tar.gz")
            _plant_file(ws, ".assay/evidence/u1.tar.gz", b"u1")
            _plant_file(ws, "evidence/u2.tar.gz", b"u2")
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
            glob_patterns = []
            real_glob = Path.glob

            def spy_glob(self, pattern, **kwargs):
                glob_patterns.append(pattern)
                return real_glob(self, pattern, **kwargs)

            with patch.object(Path, "glob", spy_glob):
                exc = self._expect_error(
                    ws, index_path, digest, "discovered", False, substring="unindexed"
                )
            msg = str(exc)
            self.assertNotIn("u2.tar.gz", msg)
            self.assertLess(len(msg), 400)
            self.assertNotIn("evidence/*.tar.gz", glob_patterns)

    def test_escaping_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            ws = base / "ws"
            ws.mkdir()
            secret = base / "secret.tar.gz"
            payload = b"secret-bytes"
            secret.write_bytes(payload)
            link = ws / "evidence" / "link.tar.gz"
            link.parent.mkdir(parents=True)
            link.symlink_to(secret)
            row = {
                "integrity": "pending",
                "path": "evidence/link.tar.gz",
                "sha256": _sha256_hex(payload),
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            hashed = []
            real_open = Path.open

            def spy_open(self, *args, **kwargs):
                fh = real_open(self, *args, **kwargs)
                try:
                    resolved = Path(self).resolve()
                except OSError:
                    resolved = Path(self)
                if resolved == secret.resolve():
                    hashed.append(True)
                return fh

            with patch.object(Path, "open", spy_open):
                self._expect_error(
                    ws,
                    index_path,
                    digest,
                    "discovered",
                    False,
                    substring="unsafe",
                )
            self.assertFalse(hashed, "must not follow/hash the outside file")

    def test_in_workspace_symlink_alias_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "other/real.tar.gz")
            link = ws / "evidence" / "link.tar.gz"
            link.parent.mkdir(parents=True)
            link.symlink_to(ws / "other" / "real.tar.gz")
            row = _bundle(
                "evidence/link.tar.gz",
                content,
                integrity="pending",
                source="discovered",
            )
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(ws, index_path, digest, "discovered", False)

    def test_regular_evidence_bundle_accepted(self):
        """Positive pair: a regular (non-symlink) evidence/a.tar.gz is accepted."""
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
            self._validate(ws, index_path, digest, "discovered", False)

    def test_safe_double_dot_filename_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            content = _plant_file(ws, "evidence/a..b.tar.gz")
            bundles = [
                _bundle(
                    "evidence/a..b.tar.gz",
                    content,
                    integrity="pending",
                    source="discovered",
                )
            ]
            index_path, digest = _write_index(
                ws, _index_payload(bundles, complete=False)
            )
            self._validate(ws, index_path, digest, "discovered", False)

    def test_unsafe_path_dotdot_component_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            row = {
                "integrity": "pending",
                "path": "evidence/../x.tar.gz",
                "sha256": "a" * 64,
                "source": "discovered",
            }
            index_path, digest = _write_index(
                ws, _index_payload([row], complete=False)
            )
            self._expect_error(ws, index_path, digest, "discovered", False)


if __name__ == "__main__":
    unittest.main()
