// Stable exit codes — see docs/contracts/EXIT_CODES.md
export const EXIT = {
  SUCCESS: 0,
  POLICY_VIOLATION: 1,
  CONFIG_ERROR: 2,
  ARTIFACT_CONTRACT: 3,
  MAPPER_FAILURE: 4,
  RESUME_ERROR: 5,
  REGRESSION: 6,
  CI_FORMATTER: 7,
} as const;
