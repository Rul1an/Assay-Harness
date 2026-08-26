#!/usr/bin/env python3
"""Consumer-side validator for assay-action-evidence-index/v1.

Stdlib only. Bounds, digests, and checks the index; does not extract archives.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


class ValidationError(Exception):
    """Raised when the index, handshake, or listed files fail validation."""


# Bound RAW index bytes before JSON parse. This ceiling is Harness resource policy,
# not a producer guarantee.
CONSUMER_INDEX_BYTES_CEILING = 1024 * 1024

SCHEMA_ID = "assay-action-evidence-index/v1"
ALLOWED_TOP_LEVEL = frozenset({"bundles", "complete", "schema"})
ALLOWED_BUNDLE_KEYS = frozenset({"integrity", "path", "sha256", "source"})
ALLOWED_SOURCES = frozenset({"discovered", "sandbox_command"})
ALLOWED_INTEGRITIES = frozenset({"pending", "verified", "rejected"})
CLOSED_EVIDENCE_STATES = frozenset({"absent", "discovered", "verified", "rejected"})
MAX_BUNDLE_ROWS = 100
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
IN_SCOPE_GLOBS = (
    ".assay/evidence/*.tar.gz",
    "evidence/*.tar.gz",
)
SANDBOX_COMMAND_EVIDENCE = ".assay/sandbox-command/evidence.tar.gz"


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and value == "":
        return True
    if isinstance(value, os.PathLike) and os.fspath(value) == "":
        return True
    return False


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return os.fspath(value) if isinstance(value, os.PathLike) else str(value)


def _normalize_verified(verified: Any) -> bool:
    if verified is True or verified == "true":
        return True
    if verified is False or verified == "false":
        return False
    raise ValidationError("verified must be true or false")


def _object_pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValidationError(f"duplicate JSON key: {key}")
        obj[key] = value
    return obj


def _assert_safe_relpath(rel: str) -> None:
    if not isinstance(rel, str) or rel == "":
        raise ValidationError("bundle path must be a non-empty workspace-relative path")
    if ".." in rel:
        raise ValidationError(f"unsafe path (..): {rel}")
    if rel.startswith("/"):
        raise ValidationError(f"unsafe path (absolute): {rel}")
    if rel.startswith("\\"):
        raise ValidationError(f"unsafe path: {rel}")
    if "://" in rel:
        raise ValidationError(f"unsafe path (URL): {rel}")
    if len(rel) >= 3 and rel[1:3] == ":/":
        raise ValidationError(f"unsafe path (windows drive): {rel}")
    # Normalize only for safety checks; do not accept unsafe forms.
    norm = os.path.normpath(rel.replace("\\", "/"))
    if norm in {".", ""} or norm.startswith("..") or os.path.isabs(norm):
        raise ValidationError(f"unsafe path: {rel}")


def _listed_file(workspace: Path, rel: str) -> Path:
    _assert_safe_relpath(rel)
    root = workspace.resolve()
    candidate = root / rel
    resolved = candidate.resolve(strict=False)
    if resolved != root and root not in resolved.parents:
        raise ValidationError(f"unsafe path (escapes workspace): {rel}")
    return candidate


def _in_scope_paths(workspace: Path) -> list[str]:
    found: list[str] = []
    for pattern in IN_SCOPE_GLOBS:
        for path in sorted(workspace.glob(pattern)):
            if path.is_file():
                found.append(path.relative_to(workspace).as_posix())
    exact = workspace / SANDBOX_COMMAND_EVIDENCE
    if exact.is_file():
        found.append(SANDBOX_COMMAND_EVIDENCE)
    return found


def _validate_bundle_row(row: Any, seen_paths: set[str]) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise ValidationError("bundle row must be an object")
    keys = set(row)
    extra = keys - ALLOWED_BUNDLE_KEYS
    missing = ALLOWED_BUNDLE_KEYS - keys
    if extra:
        raise ValidationError(f"unknown bundle member: {sorted(extra)}")
    if missing:
        raise ValidationError(f"bundle missing member: {sorted(missing)}")
    integrity = row["integrity"]
    source = row["source"]
    sha256 = row["sha256"]
    path = row["path"]
    if integrity not in ALLOWED_INTEGRITIES:
        raise ValidationError(f"invalid integrity: {integrity!r}")
    if source not in ALLOWED_SOURCES:
        raise ValidationError(f"invalid source: {source!r}")
    if not isinstance(sha256, str) or not SHA256_HEX_RE.fullmatch(sha256):
        raise ValidationError("bundle sha256 must be 64 lowercase hex")
    if not isinstance(path, str):
        raise ValidationError("bundle path must be a string")
    if path in seen_paths:
        raise ValidationError(f"duplicate path: {path}")
    seen_paths.add(path)
    _assert_safe_relpath(path)
    return row


def _check_state_consistency(
    evidence_state: str,
    verified: bool,
    rows: list[dict[str, Any]],
    complete: bool,
) -> None:
    if verified and evidence_state != "verified":
        raise ValidationError("verified=true is only valid with evidence_state=verified")

    integrities = [row["integrity"] for row in rows]
    if evidence_state == "absent":
        if rows or complete is not True or verified is not False:
            raise ValidationError("absent requires bundles=[], complete=true, verified=false")
        return
    if evidence_state == "discovered":
        if (
            len(rows) < 1
            or any(item != "pending" for item in integrities)
            or complete is not False
            or verified is not False
        ):
            raise ValidationError(
                "discovered requires >=1 pending row, complete=false, verified=false"
            )
        return
    if evidence_state == "verified":
        if (
            len(rows) < 1
            or any(item != "verified" for item in integrities)
            or complete is not True
            or verified is not True
        ):
            raise ValidationError(
                "verified requires >=1 verified row, complete=true, verified=true"
            )
        return
    if evidence_state == "rejected":
        if (
            len(rows) < 1
            or complete is not True
            or "pending" in integrities
            or "rejected" not in integrities
            or verified is not False
        ):
            raise ValidationError(
                "rejected requires >=1 row, complete=true, at least one rejected, "
                "none pending, verified=false (lint is not rejection)"
            )
        return
    raise ValidationError(f"unknown evidence_state: {evidence_state!r}")


def validate_index(
    workspace: Any,
    index_path: Any,
    digest: Any,
    evidence_state: Any,
    verified: Any,
    if_present: bool = False,
) -> None:
    state_text = _as_text(evidence_state).strip() if isinstance(evidence_state, str) else evidence_state
    digest_text = _as_text(digest).strip() if not _is_empty(digest) else ""
    verified_value = verified
    if isinstance(verified, str):
        verified_value = verified.strip()

    empties = (
        _is_empty(index_path),
        _is_empty(digest_text) and _is_empty(digest),
        _is_empty(state_text),
        _is_empty(verified_value),
    )
    if if_present and all(empties):
        return
    if if_present and any(empties):
        raise ValidationError("partial handshake")

    if _is_empty(state_text) or state_text not in CLOSED_EVIDENCE_STATES:
        raise ValidationError(
            f"evidence_state must be one of {sorted(CLOSED_EVIDENCE_STATES)}"
        )

    verified_bool = _normalize_verified(verified_value)
    if verified_bool and state_text != "verified":
        raise ValidationError("verified=true is only valid with evidence_state=verified")

    ws = Path(workspace)
    if not ws.is_dir():
        raise ValidationError(f"workspace is not a directory: {workspace}")

    idx = Path(index_path)
    if not idx.is_file():
        raise ValidationError(f"index file missing: {index_path}")

    size = idx.stat().st_size
    if size > CONSUMER_INDEX_BYTES_CEILING:
        raise ValidationError(
            f"index exceeds consumer ceiling of {CONSUMER_INDEX_BYTES_CEILING} bytes"
        )
    raw = idx.read_bytes()
    if len(raw) > CONSUMER_INDEX_BYTES_CEILING:
        raise ValidationError(
            f"index exceeds consumer ceiling of {CONSUMER_INDEX_BYTES_CEILING} bytes"
        )

    actual_digest = hashlib.sha256(raw).hexdigest()
    expected_digest = digest_text.lower()
    if not SHA256_HEX_RE.fullmatch(expected_digest) or actual_digest != expected_digest:
        raise ValidationError("index digest mismatch")

    try:
        parsed = json.loads(raw, object_pairs_hook=_object_pairs_hook)
    except ValidationError:
        raise
    except json.JSONDecodeError as exc:
        raise ValidationError(f"index is not strict JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ValidationError("index must be a JSON object")

    keys = set(parsed)
    extra = keys - ALLOWED_TOP_LEVEL
    missing = ALLOWED_TOP_LEVEL - keys
    if extra:
        raise ValidationError(f"unknown member: {sorted(extra)}")
    if missing:
        raise ValidationError(f"missing member: {sorted(missing)}")

    if parsed["schema"] != SCHEMA_ID:
        raise ValidationError(f"wrong or missing schema: {parsed['schema']!r}")

    bundles = parsed["bundles"]
    complete = parsed["complete"]
    if not isinstance(bundles, list):
        raise ValidationError("bundles must be a list")
    if not isinstance(complete, bool):
        raise ValidationError("complete must be a JSON boolean")
    if len(bundles) > MAX_BUNDLE_ROWS:
        raise ValidationError(
            f"index has {len(bundles)} rows; 101st bundle exceeds the {MAX_BUNDLE_ROWS}-row limit"
        )

    seen_paths: set[str] = set()
    rows = [_validate_bundle_row(row, seen_paths) for row in bundles]

    computed_complete = all(row["integrity"] in {"verified", "rejected"} for row in rows)
    if complete is not computed_complete:
        raise ValidationError("complete does not match row integrities")

    for row in rows:
        listed = _listed_file(ws, row["path"])
        if not listed.is_file():
            raise ValidationError(f"missing listed file: {row['path']}")
        actual = hashlib.sha256(listed.read_bytes()).hexdigest()
        if actual != row["sha256"]:
            raise ValidationError(f"bundle digest mismatch: {row['path']}")

    unindexed = [rel for rel in _in_scope_paths(ws) if rel not in seen_paths]
    if unindexed:
        raise ValidationError(f"unindexed in-scope bundle: {unindexed}")

    _check_state_consistency(state_text, verified_bool, rows, complete)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(message, file=sys.stderr)
        raise SystemExit(1)


def main(argv: list[str] | None = None) -> int:
    parser = _Parser(prog="validate_action_evidence_index.py")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--index", default="")
    parser.add_argument("--digest", default="")
    parser.add_argument("--evidence-state", default="")
    parser.add_argument("--verified", default="")
    parser.add_argument("--if-present", action="store_true")
    try:
        args = parser.parse_args(argv)
        validate_index(
            args.workspace,
            args.index,
            args.digest,
            args.evidence_state,
            args.verified,
            if_present=args.if_present,
        )
    except ValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except SystemExit as exc:
        code = exc.code
        if code in (None, 0):
            return 0
        return 1 if code == 2 else int(code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
