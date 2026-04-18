"""Paused Approval Pattern (P23A v1).

Reusable Assay Harness pattern for one paused human-in-the-loop
approval. Four helpers, strict v1 validator, no runtime imports.

See README.md and FIELD_PRESENCE.md in this package for the full
contract.
"""

from patterns.paused_approval.capture import capture_paused_approval
from patterns.paused_approval.emit import emit_pause_artifact
from patterns.paused_approval.fingerprint import derive_resume_state_ref
from patterns.paused_approval.validate import (
    PauseArtifactValidationError,
    validate_pause_artifact,
)

__all__ = [
    "capture_paused_approval",
    "derive_resume_state_ref",
    "emit_pause_artifact",
    "validate_pause_artifact",
    "PauseArtifactValidationError",
]
