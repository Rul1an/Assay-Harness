import { existsSync } from "node:fs";
import { EXIT } from "./cli_exit.js";
import {
  compareEvidence,
  compareRunnerArchivesTier1,
  formatCompareResult,
  formatRunnerCompareTier1Result,
} from "./compare.js";
import { detectInputMode } from "./runner_archive.js";

export function cmdCompare(args: Record<string, string | boolean>): void {
  const baselinePath = args.baseline as string;
  const candidatePath = args.candidate as string;
  const format = (args.format as string) ?? "markdown";
  const allowDegraded = args["allow-degraded"] === true;

  if (!baselinePath || !existsSync(baselinePath)) {
    console.error(`[config_error] Baseline file not found: ${baselinePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!candidatePath || !existsSync(candidatePath)) {
    console.error(`[config_error] Candidate file not found: ${candidatePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  // H6 — mode detection. Route NDJSON evidence to the existing comparison,
  // and Runner archives to the Tier-1 validation path. Refuse mixed modes
  // with a clear error rather than producing a misleading diff.
  const baselineMode = detectInputMode(baselinePath);
  const candidateMode = detectInputMode(candidatePath);

  if (baselineMode !== candidateMode) {
    console.error(
      `[config_error] Input mode mismatch: baseline=${baselineMode}, candidate=${candidateMode}. ` +
        `compare requires both inputs to be the same kind ` +
        `(both NDJSON evidence files, or both Runner .tar.gz archives).`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }

  if (baselineMode === "unknown") {
    console.error(
      `[config_error] Unrecognised input shape for ${baselinePath} and ${candidatePath}. ` +
        `Expected NDJSON evidence (.ndjson, .jsonl) or a Runner archive (.tar.gz with ` +
        `assay.runner.archive_manifest.v0 at manifest.json).`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }

  if (baselineMode === "runner_archive") {
    const runnerResult = compareRunnerArchivesTier1(baselinePath, candidatePath, {
      allow_degraded: allowDegraded,
    });
    if (format === "json") {
      console.log(JSON.stringify(runnerResult, null, 2));
    } else {
      console.log(formatRunnerCompareTier1Result(runnerResult));
    }
    // Routing:
    //   - either side fails manifest/digest validation → ARTIFACT_CONTRACT
    //   - otherwise honest-health failure (or any other Tier-1 fail) → REGRESSION
    //   - clean → SUCCESS
    const manifestFailure =
      !runnerResult.baseline.manifest_valid || !runnerResult.candidate.manifest_valid ||
      !runnerResult.baseline.recognised || !runnerResult.candidate.recognised;
    if (manifestFailure) {
      process.exit(EXIT.ARTIFACT_CONTRACT);
    }
    process.exit(runnerResult.has_regressions ? EXIT.REGRESSION : EXIT.SUCCESS);
  }

  // Legacy path: both inputs are NDJSON evidence files.
  const result = compareEvidence(baselinePath, candidatePath);

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCompareResult(result));
  }

  process.exit(result.has_regressions ? EXIT.REGRESSION : EXIT.SUCCESS);
}
