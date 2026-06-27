import { existsSync } from "node:fs";
import { EXIT } from "./cli_exit.js";
import { cmdRunnerClaims, cmdRunnerCoverage, cmdRunnerSandbox } from "./cli_runner_coverage.js";
import {
  checkHonestHealth,
  detectInputMode,
  validateRunnerArchive,
} from "./runner_archive.js";
import {
  compareRunnerArchivesCapabilitySurface,
  formatRunnerCompareResult,
} from "./runner_compare.js";
import {
  formatCrossRuntimeReport,
  loadCrossRuntimeReport,
} from "./runner_cross_runtime.js";
import {
  formatKernelCaptureSignals,
  parseKernelCaptureSignals,
  signalsEmpty,
} from "./runner_signals.js";

export function cmdVerifyRunner(args: Record<string, string | boolean>): void {
  const archivePath = (args._file as string | undefined) ?? (args.archive as string | undefined);
  const format = (args.format as string) ?? "markdown";
  const allowDegraded = args["allow-degraded"] === true;

  if (!archivePath || !existsSync(archivePath)) {
    console.error(
      `[config_error] Runner archive not found: ${archivePath ?? "(none)"}`,
    );
    console.error(
      `Usage: verify-runner <archive.tar.gz> [--format markdown|json] [--allow-degraded]`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }

  const validation = validateRunnerArchive(archivePath);
  const health = checkHonestHealth(validation, { allow_degraded: allowDegraded });
  const networkSignals = parseKernelCaptureSignals(
    validation.observation_health?.notes,
  );

  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          archive: archivePath,
          recognised: validation.recognised,
          manifest_valid: validation.manifest_valid,
          honest_health: {
            passed: health.passed,
            reasons: health.reasons,
            structural_reasons: health.structural_reasons,
            measurement_health_reasons: health.measurement_health_reasons,
            allow_degraded: allowDegraded,
          },
          manifest_errors: validation.manifest_errors,
          artifact_parse_errors: validation.artifact_parse_errors,
          run_id: validation.manifest?.run_id,
          observation_health: validation.observation_health,
          correlation_report_status: validation.correlation_report?.status,
          // Additive: only present when the kernel-capture note carries signals.
          ...(signalsEmpty(networkSignals) ? {} : { network_signals: networkSignals }),
        },
        null,
        2,
      ),
    );
  } else {
    const lines: string[] = [];
    lines.push("# Runner Archive Verification");
    lines.push("");
    lines.push(`**Archive:** \`${archivePath}\``);
    lines.push(`**Recognised:** ${validation.recognised ? "yes" : "no"}`);
    lines.push(`**Manifest valid:** ${validation.manifest_valid ? "yes" : "no"}`);
    if (validation.manifest?.run_id) {
      lines.push(`**Run id:** \`${validation.manifest.run_id}\``);
    }
    lines.push(
      `**Honest health:** ${health.passed ? "passed" : "failed"}${
        allowDegraded ? " (allow_degraded enabled)" : ""
      }`,
    );
    lines.push("");
    if (validation.manifest_errors.length > 0) {
      lines.push("## Manifest / Digest Errors (H1)");
      lines.push("");
      for (const e of validation.manifest_errors) {
        lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
      }
      lines.push("");
    }
    if (validation.artifact_parse_errors.length > 0) {
      lines.push("## Artifact Parse Errors (observation-health / correlation-report)");
      lines.push("");
      for (const e of validation.artifact_parse_errors) {
        lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ""}: ${e.message}`);
      }
      lines.push("");
    }
    if (health.reasons.length > 0) {
      lines.push("## Honest Health Reasons");
      lines.push("");
      if (health.structural_reasons.length > 0) {
        lines.push("Structural (not bypassable by `--allow-degraded`):");
        for (const r of health.structural_reasons) {
          lines.push(`- \`${r}\``);
        }
      }
      if (health.measurement_health_reasons.length > 0) {
        lines.push("Measurement health (bypassable by `--allow-degraded`):");
        for (const r of health.measurement_health_reasons) {
          lines.push(`- \`${r}\``);
        }
      }
      lines.push("");
    }
    for (const line of formatKernelCaptureSignals(networkSignals)) {
      lines.push(line);
    }
    console.log(lines.join("\n"));
  }

  // Exit code routing:
  //   - manifest/digest failure → ARTIFACT_CONTRACT (3)
  //   - honest-health failure (without --allow-degraded) → REGRESSION (6)
  //   - otherwise → SUCCESS (0)
  if (!validation.recognised || !validation.manifest_valid) {
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (!health.passed) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

export function cmdRunner(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string;
  if (subcommand === "compare") {
    cmdRunnerCompare(args);
    return;
  }
  if (subcommand === "cross-runtime") {
    cmdRunnerCrossRuntime(args);
    return;
  }
  if (subcommand === "coverage") {
    cmdRunnerCoverage(args);
    return;
  }
  if (subcommand === "claims") {
    cmdRunnerClaims(args);
    return;
  }
  if (subcommand === "sandbox") {
    cmdRunnerSandbox(args);
    return;
  }
  console.error(`[config_error] Unknown runner subcommand: ${subcommand ?? "(none)"}`);
  console.error(
    "Usage:\n" +
      "  runner compare --baseline <archive.tar.gz> --candidate <archive.tar.gz> [--format markdown|json] [--allow-degraded]\n" +
      "  runner cross-runtime report --diff <cross-runtime-diff.json> [--format markdown|json]\n" +
      "  runner cross-runtime gate --diff <cross-runtime-diff.json>\n" +
      "  runner coverage report --annotation <annotation.json> [--format markdown|json]\n" +
      "  runner coverage gate --annotation <annotation.json> --assert-claim TYPE:DIM[,TYPE:DIM...] [--policy <claims.json>] [--format text|json|sarif]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdRunnerCrossRuntime(args: Record<string, string | boolean>): void {
  const subsubcommand = args._subfile as string | undefined;
  if (subsubcommand === "report") {
    cmdRunnerCrossRuntimeReport(args);
    return;
  }
  if (subsubcommand === "gate") {
    cmdRunnerCrossRuntimeGate(args);
    return;
  }
  console.error(
    `[config_error] Unknown runner cross-runtime subcommand: ${subsubcommand ?? "(none)"}`,
  );
  console.error(
    "Usage:\n" +
      "  runner cross-runtime report --diff <cross-runtime-diff.json> [--format markdown|json]\n" +
      "  runner cross-runtime gate --diff <cross-runtime-diff.json>",
  );
  console.error(
    "Tier 3B (archive-pair convenience wrapper) is not implemented yet.",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdRunnerCrossRuntimeReport(args: Record<string, string | boolean>): void {
  const diffArg = args.diff;
  const format = (args.format as string) ?? "markdown";

  // Bare `--diff` without a value is parsed as `true` by parseArgs, so
  // require an explicit non-empty string here to avoid passing `true` (or
  // any non-string) into existsSync / readFileSync.
  if (typeof diffArg !== "string" || diffArg.length === 0) {
    console.error(
      "[config_error] --diff <cross-runtime-diff.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: runner cross-runtime report --diff <cross-runtime-diff.json> [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const diffPath = diffArg;

  const load = loadCrossRuntimeReport(diffPath);
  if (load.not_found) {
    console.error(`[config_error] Cross-runtime diff file not found: ${diffPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCrossRuntimeReport(report));
  }

  // Exit routing for Tier 3A `report`:
  //   - invalid diff (schema mismatch, JSON parse failure, contract-shape
  //     violation, out-of-scope-marker tampering) → ARTIFACT_CONTRACT (3)
  //   - otherwise (including a diff that contains regressions) → SUCCESS (0)
  // The regression signal is rendered in the report status line but does
  // NOT translate to exit 6 here — that is the `gate` verb's job
  // (cmdRunnerCrossRuntimeGate below).
  if (!report.validation.valid) {
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdRunnerCrossRuntimeGate(args: Record<string, string | boolean>): void {
  // Tier 3C — same parser as `report`, different exit-code semantics.
  // The gate verb translates the v0 capability-regression signal into a
  // CI-blocking exit code. No new contract logic and no new validation —
  // it consumes the exact same `CrossRuntimeReport` and applies the
  // documented routing.
  const diffArg = args.diff;

  if (typeof diffArg !== "string" || diffArg.length === 0) {
    console.error(
      "[config_error] --diff <cross-runtime-diff.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: runner cross-runtime gate --diff <cross-runtime-diff.json>",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const diffPath = diffArg;

  const load = loadCrossRuntimeReport(diffPath);
  if (load.not_found) {
    console.error(`[config_error] Cross-runtime diff file not found: ${diffPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  // The gate verb is exit-focused, so emit a one-line summary on stderr
  // for CI logs but keep stdout clean. (Callers that want full output
  // should use `runner cross-runtime report` instead.)
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] runner cross-runtime gate: invalid diff (${codes})`);
  } else if (report.has_added_capability) {
    const counts = Object.entries(report.added_counts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    console.error(`[regression] runner cross-runtime gate: added capability surface (${counts})`);
  } else {
    console.error("[success] runner cross-runtime gate: no added capability surface");
  }

  // Exit routing for Tier 3C `gate`:
  //   - invalid diff (schema/contract violation) → ARTIFACT_CONTRACT (3)
  //   - added capability surface on any of the five v0 categories →
  //     REGRESSION (6). New `allow:*` policy decisions count here per the
  //     within-runtime Tier-2A policy mirrored cross-runtime.
  //   - removed entries / SDK metadata changes / notes / etc. → SUCCESS (0)
  //   - missing file / bare --diff → CONFIG_ERROR (2) (handled above)
  // No new semantic logic vs `report`; only the exit translation.
  if (!report.validation.valid) {
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (report.has_added_capability) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdRunnerCompare(args: Record<string, string | boolean>): void {
  const baselinePath = args.baseline as string;
  const candidatePath = args.candidate as string;
  const format = (args.format as string) ?? "markdown";
  const allowDegraded = args["allow-degraded"] === true;

  if (!baselinePath || !existsSync(baselinePath)) {
    console.error(
      `[config_error] Baseline archive not found: ${baselinePath ?? "(none)"}`,
    );
    console.error(
      "Usage: runner compare --baseline <archive.tar.gz> --candidate <archive.tar.gz> [--format markdown|json] [--allow-degraded]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!candidatePath || !existsSync(candidatePath)) {
    console.error(
      `[config_error] Candidate archive not found: ${candidatePath ?? "(none)"}`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }

  // Refuse non-archive extensions up front. `runner compare` is the
  // explicit Runner-aware verb; passing an NDJSON or arbitrary file here is
  // a configuration mistake, not a Tier-1 archive failure. Surfacing this
  // as `config_error` (2) matches the documented routing and gives a
  // clearer error than letting the validator try to gunzip arbitrary
  // bytes.
  const baselineMode = detectInputMode(baselinePath);
  const candidateMode = detectInputMode(candidatePath);
  if (baselineMode !== "runner_archive") {
    console.error(
      `[config_error] Baseline is not a Runner archive (detected mode: ${baselineMode}). ` +
        `runner compare requires .tar.gz / .tgz inputs.`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (candidateMode !== "runner_archive") {
    console.error(
      `[config_error] Candidate is not a Runner archive (detected mode: ${candidateMode}). ` +
        `runner compare requires .tar.gz / .tgz inputs.`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }

  const result = compareRunnerArchivesCapabilitySurface(baselinePath, candidatePath, {
    allow_degraded: allowDegraded,
  });

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatRunnerCompareResult(result));
  }

  // Exit-code routing (Tier 2A refinement F + PR #60 review):
  //   - Any Tier-1-not-clean result on either side → ARTIFACT_CONTRACT (3).
  //     This includes archive/manifest/digest failures AND honest-health
  //     failures AND missing observation-health / correlation-report /
  //     capability-surface. The verb's purpose is "Tier-2 diff over Tier-1
  //     clean archives"; if the precondition isn't met, the input is the
  //     problem, not the diff outcome.
  //   - Capability regression (added capability surface or new allow:*) →
  //     REGRESSION (6).
  //   - Clean → SUCCESS (0).
  if (!result.tier1_clean) {
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  // `tier1_clean` is true but capability_surface may still be unavailable
  // (the archive lacked the payload). Treat that as a Tier-1-incomplete
  // input failure for the same reason: there is no Tier-2 result to report.
  if (!result.capability_surface) {
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(result.has_regressions ? EXIT.REGRESSION : EXIT.SUCCESS);
}
