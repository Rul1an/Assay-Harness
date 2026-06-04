#!/usr/bin/env node
/**
 * CLI entry point for the Assay Harness.
 *
 * Commands:
 *   run      — run the harness agent with policy enforcement
 *   verify   — verify evidence file against the artifact contract
 *   compare  — compare baseline vs candidate evidence for regressions
 *   trust-basis gate — gate on Assay Trust Basis diff regressions
 *   trust-basis report — project Assay Trust Basis diff JSON into review reports
 *   policy   — evaluate a tool name against a policy file
 *
 * Exit codes (stable contract, see docs/contracts/EXIT_CODES.md):
 *   0 = success
 *   1 = policy_violation
 *   2 = config_error
 *   3 = artifact_contract
 *   4 = mapper_failure
 *   5 = resume_error
 *   6 = regression
 *   7 = ci_formatter
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessAgent } from "./agent.js";
import { PolicyEngine } from "./policy.js";
import { runHarness } from "./harness.js";
import {
  compareEvidence,
  compareRunnerArchivesTier1,
  formatCompareResult,
  formatRunnerCompareTier1Result,
} from "./compare.js";
import {
  formatTrustBasisGateSummary,
  runTrustBasisGate,
} from "./trust_basis_gate.js";
import {
  runTrustBasisReport,
  TrustBasisReportError,
} from "./trust_basis_report.js";
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
  buildCoverageProjection,
  foldCoverageFleet,
  formatCoverageFleet,
  formatCoverageGate,
  formatCoverageReport,
  gateCoverageClaims,
  loadCoverageAnnotation,
} from "./runner_coverage.js";
import {
  formatKernelCaptureSignals,
  parseKernelCaptureSignals,
  signalsEmpty,
} from "./runner_signals.js";

// Stable exit codes — see docs/contracts/EXIT_CODES.md
const EXIT = {
  SUCCESS: 0,
  POLICY_VIOLATION: 1,
  CONFIG_ERROR: 2,
  ARTIFACT_CONTRACT: 3,
  MAPPER_FAILURE: 4,
  RESUME_ERROR: 5,
  REGRESSION: 6,
  CI_FORMATTER: 7,
} as const;

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage(): never {
  console.log(`assay-harness — Approval-aware resumable harness with Assay evidence governance

Commands:
  compare  --baseline <path> --candidate <path> [--format markdown|json] [--allow-degraded]
  trust-basis gate --baseline <path> --candidate <path> --out <path> [--assay-bin <path>]
  trust-basis report --diff <path> [--summary-out <path>] [--junit-out <path>]
  verify   <evidence-file> [--category <all|envelope|hash|type>]
  verify-runner <archive.tar.gz> [--format markdown|json] [--allow-degraded]
  runner compare --baseline <archive.tar.gz> --candidate <archive.tar.gz> [--format markdown|json] [--allow-degraded]
  runner cross-runtime report --diff <cross-runtime-diff.json> [--format markdown|json]
  runner cross-runtime gate --diff <cross-runtime-diff.json>
  runner coverage report --annotation <annotation.json> [--format markdown|json]
  runner coverage gate --annotation <annotation.json> --assert-claim TYPE:DIM[,TYPE:DIM...] [--policy <claims.json>] [--format text|json|sarif]
  runner coverage fleet (--dir <dir> | --annotations <a.json,b.json,...>) [--format markdown|json]
  baseline <update|show|path> [--from <path>] [--dir <path>]
  policy   --policy <path> --tool <name>
  run      --policy <path> --input <prompt> [--output <path>] [--auto-approve] [--auto-deny]

Exit codes:
  0  success              No failures or regressions
  1  policy_violation     Tool call denied by policy
  2  config_error         Missing file or invalid configuration
  3  artifact_contract    Evidence fails contract validation
  4  mapper_failure       Mapper rejected input
  5  resume_error         Resume flow failed
  6  regression           Baseline comparison found regressions
  7  ci_formatter         JUnit/SARIF generation failed

Options:
  --policy       Path to policy YAML file
  --input        Agent input prompt
  --output       Output path for evidence NDJSON (default: results/evidence.ndjson)
  --auto-approve Auto-approve all approval-required tools
  --auto-deny    Auto-deny all approval-required tools
  --run-id       Custom run ID (default: generated)
  --format       Output format: ndjson | json | markdown (default: ndjson)
  --baseline     Baseline evidence file for compare
  --candidate    Candidate evidence file for compare
  --out          Output path for Trust Basis diff artifacts
  --assay-bin    Assay CLI binary for trust-basis-gate (default: assay)
  --diff         Trust Basis diff JSON for trust-basis report
  --summary-out  Markdown summary output path for trust-basis report
  --junit-out    JUnit XML output path for trust-basis report
  --category     Verify category: all | envelope | hash | type (default: all)
`);
  process.exit(EXIT.CONFIG_ERROR);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) args._command = positional[0];
  if (positional.length > 1) args._file = positional[1];
  // Third positional is used by nested namespaces such as
  // `runner cross-runtime report` where `_command=runner`, `_file=cross-runtime`,
  // and `_subfile=report`. Older verbs do not consume it.
  if (positional.length > 2) args._subfile = positional[2];
  return args;
}

// --- Verify checks by category ---

interface VerifyError {
  line: number;
  category: "envelope" | "hash" | "type" | "parse";
  code: string;
  message: string;
}

/**
 * Raw SDK state that must never appear in any evidence event.
 *
 * Captures the OpenAI Agents SDK RunState and adjacent conversational
 * state that would leak prompt history, model session tokens, or other
 * runtime internals into a bundle.
 */
const FORBIDDEN_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  "raw_run_state",
  "history",
  "newItems",
  "lastResponseId",
  "session",
]);

/**
 * Raw payload bodies that must stay content-addressed (`*_hash` /
 * `*_ref` fields) rather than embedded as plaintext in evidence.
 *
 * The verifier policy is symmetric to the harness emitter policy: the
 * MCP hardening tests reject these on the way in; the verifier rejects
 * them on the way out of bundle inspection. Keeps fixture-policy and
 * verifier-policy aligned.
 */
const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "raw_arguments",
  "raw_output",
  "transcript",
  "audio_blob",
  "session_recording",
  "request_payload",
  "response_payload",
  "raw_payload",
]);

/**
 * Walk an object graph and report any forbidden key found at any depth.
 *
 * Error messages include the full dotted path (`data.observed.raw_arguments`)
 * so a reviewer can locate the leak without re-parsing the bundle. Arrays
 * are descended into with bracket-index notation.
 */
function scanForbiddenKeys(
  value: unknown,
  path: string,
  lineNum: number,
  errors: VerifyError[],
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForbiddenKeys(value[i], `${path}[${i}]`, lineNum, errors);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_RUNTIME_KEYS.has(key)) {
      errors.push({
        line: lineNum,
        category: "type",
        code: "VERIFY_FORBIDDEN_RUNTIME_KEY",
        message: `forbidden runtime key "${key}" found at ${childPath} — raw SDK state must not appear in evidence`,
      });
    } else if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      errors.push({
        line: lineNum,
        category: "type",
        code: "VERIFY_FORBIDDEN_PAYLOAD_KEY",
        message: `forbidden payload key "${key}" found at ${childPath} — raw payload must stay content-addressed, not embedded`,
      });
    }
    scanForbiddenKeys(child, childPath, lineNum, errors);
  }
}

function verifyEvents(lines: string[], category: string): VerifyError[] {
  const errors: VerifyError[] = [];
  const runIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let event: any;

    try {
      event = JSON.parse(lines[i]);
    } catch {
      errors.push({
        line: lineNum,
        category: "parse",
        code: "VERIFY_PARSE",
        message: "Invalid JSON",
      });
      continue;
    }

    // Envelope checks
    if (category === "all" || category === "envelope") {
      const requiredFields = [
        "specversion", "type", "source", "id", "time",
        "datacontenttype", "assayrunid", "assayseq",
        "assayproducer", "assayproducerversion", "assaygit",
        "assaypii", "assaysecrets", "assaycontenthash", "data",
      ];

      for (const field of requiredFields) {
        if (!(field in event)) {
          errors.push({
            line: lineNum,
            category: "envelope",
            code: "VERIFY_MISSING_FIELD",
            message: `Missing required field: ${field}`,
          });
        }
      }

      if (event.specversion !== "1.0") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_SPECVERSION",
          message: `specversion must be "1.0", got "${event.specversion}"`,
        });
      }

      if (event.datacontenttype && event.datacontenttype !== "application/json") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_CONTENT_TYPE",
          message: `datacontenttype must be "application/json"`,
        });
      }

      if (event.assayrunid) {
        runIds.add(event.assayrunid);
      }

      if (typeof event.assayseq !== "number" || event.assayseq < 0) {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_SEQ",
          message: `assayseq must be a non-negative integer`,
        });
      }

      if (event.data && typeof event.data !== "object") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_DATA_TYPE",
          message: `data must be an object`,
        });
      }
    }

    // Hash checks
    if (category === "all" || category === "hash") {
      if (event.assaycontenthash) {
        const hash = event.assaycontenthash;
        if (!hash.startsWith("sha256:")) {
          errors.push({
            line: lineNum,
            category: "hash",
            code: "VERIFY_HASH_PREFIX",
            message: `assaycontenthash must start with "sha256:"`,
          });
        } else {
          const hexPart = hash.slice(7);
          if (hexPart.length !== 64 || !/^[0-9a-f]+$/.test(hexPart)) {
            errors.push({
              line: lineNum,
              category: "hash",
              code: "VERIFY_HASH_FORMAT",
              message: `assaycontenthash hex part must be 64 lowercase hex characters`,
            });
          }
        }
      }
    }

    // Type-specific checks
    if (category === "all" || category === "type") {
      const type = event.type;
      if (type && !type.startsWith("assay.harness.") && !type.startsWith("example.placeholder.harness.")) {
        errors.push({
          line: lineNum,
          category: "type",
          code: "VERIFY_TYPE_PREFIX",
          message: `type must start with "assay.harness." or "example.placeholder.harness."`,
        });
      }

      // Approval interruption specific
      if (type?.endsWith("approval-interruption") && event.data) {
        const d = event.data.observed ?? event.data;
        if (d.pause_reason && d.pause_reason !== "tool_approval") {
          errors.push({
            line: lineNum,
            category: "type",
            code: "VERIFY_PAUSE_REASON",
            message: `pause_reason must be "tool_approval"`,
          });
        }
        if (d.interruptions !== undefined) {
          if (!Array.isArray(d.interruptions) || d.interruptions.length === 0) {
            errors.push({
              line: lineNum,
              category: "type",
              code: "VERIFY_INTERRUPTIONS",
              message: `interruptions must be a non-empty array`,
            });
          }
        }
        if (d.resume_state_ref && !d.resume_state_ref.startsWith("sha256:")) {
          errors.push({
            line: lineNum,
            category: "type",
            code: "VERIFY_STATE_REF",
            message: `resume_state_ref must be a sha256: hash`,
          });
        }
      }

      // Rejected content checks — recursive scan of event.data.
      //
      // Two classes of forbidden keys, each with its own error code so
      // the verifier output tells a reviewer immediately which boundary
      // was crossed:
      //
      //   FORBIDDEN_RUNTIME_KEYS: raw SDK state that must never appear
      //     in evidence (RunState, conversation history, session tokens).
      //
      //   FORBIDDEN_PAYLOAD_KEYS: raw payload bodies that must stay as
      //     content hashes only (tool arguments/outputs, transcripts,
      //     audio blobs, full request/response payloads).
      //
      // The audit at commit 31669dc found the previous check only looked
      // one level deep under `event.data`, so a nested shape such as
      // `data.observed.raw_run_state` slipped through. This scan walks
      // the full object graph and reports the precise key path.
      if (event.data && typeof event.data === "object") {
        scanForbiddenKeys(event.data, "data", lineNum, errors);
      }
    }
  }

  // Cross-event checks
  if (category === "all" || category === "envelope") {
    if (runIds.size > 1) {
      errors.push({
        line: 0,
        category: "envelope",
        code: "VERIFY_RUNID_CONSISTENCY",
        message: `Multiple assayrunid values found: ${[...runIds].join(", ")}`,
      });
    }
  }

  return errors;
}

// --- Commands ---

async function cmdRun(args: Record<string, string | boolean>): Promise<void> {
  const policyPath = (args.policy as string) ?? resolve(__dirname, "..", "policy.yaml");
  const input = (args.input as string) ?? "List the files in /tmp and then write a summary to /tmp/summary.txt";
  const outputPath = (args.output as string) ?? "results/evidence.ndjson";
  const format = (args.format as string) ?? "ndjson";
  const runId = (args["run-id"] as string) ?? `harness-${Date.now()}`;

  if (!existsSync(policyPath)) {
    console.error(`[config_error] Policy file not found: ${policyPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const policy = PolicyEngine.fromFile(policyPath);
  const agent = createHarnessAgent();

  console.log(`[harness] run-id: ${runId}`);
  console.log(`[harness] policy: ${policy.policyId}`);
  console.log(`[harness] input: "${input.slice(0, 80)}..."`);
  console.log();

  let result;
  try {
    result = await runHarness(
      {
        agent,
        policy,
        runId,
        autoApprove: args["auto-approve"] === true,
        autoDeny: args["auto-deny"] === true,
      },
      input
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("resume") || msg.includes("Resume")) {
      console.error(`[resume_error] ${msg}`);
      process.exit(EXIT.RESUME_ERROR);
    }
    throw err;
  }

  // Write evidence
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });
  }

  const output = format === "json" ? result.evidence.toJson() : result.evidence.toNdjson();
  writeFileSync(outputPath, output, "utf-8");

  // Summary
  console.log(`[harness] completed`);
  console.log(`[harness] interrupted: ${result.interrupted}`);
  console.log(`[harness] denied: ${result.denied.length > 0 ? result.denied.join(", ") : "none"}`);
  console.log(`[harness] approved: ${result.approved.length > 0 ? result.approved.join(", ") : "none"}`);
  console.log(`[harness] evidence events: ${result.evidence.events.length}`);
  console.log(`[harness] output: ${outputPath}`);

  if (result.finalOutput) {
    console.log(`\n[agent] ${result.finalOutput.slice(0, 200)}`);
  }

  process.exit(result.denied.length > 0 ? EXIT.POLICY_VIOLATION : EXIT.SUCCESS);
}

function cmdVerify(args: Record<string, string | boolean>): void {
  const filePath = args._file as string;
  if (!filePath || !existsSync(filePath)) {
    console.error(`[config_error] Evidence file not found: ${filePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const category = (args.category as string) ?? "all";
  if (!["all", "envelope", "hash", "type"].includes(category)) {
    console.error(`[config_error] Invalid category: ${category}. Must be: all, envelope, hash, type`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);

  const errors = verifyEvents(lines, category);

  // Group errors by category
  const byCategory = new Map<string, VerifyError[]>();
  for (const err of errors) {
    const list = byCategory.get(err.category) ?? [];
    list.push(err);
    byCategory.set(err.category, list);
  }

  console.log(`[verify] ${filePath}`);
  console.log(`[verify] category: ${category}`);
  console.log(`[verify] events: ${lines.length}`);
  console.log(`[verify] errors: ${errors.length}`);

  if (byCategory.size > 0) {
    console.log();
    for (const [cat, errs] of byCategory) {
      console.log(`[verify:${cat}] ${errs.length} error(s):`);
      for (const err of errs) {
        const lineRef = err.line > 0 ? `line ${err.line}` : "cross-event";
        console.log(`  [${err.code}] ${lineRef}: ${err.message}`);
      }
    }
  }

  process.exit(errors.length > 0 ? EXIT.ARTIFACT_CONTRACT : EXIT.SUCCESS);
}

function cmdCompare(args: Record<string, string | boolean>): void {
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

function cmdVerifyRunner(args: Record<string, string | boolean>): void {
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

function cmdRunner(args: Record<string, string | boolean>): void {
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

function cmdRunnerCoverage(args: Record<string, string | boolean>): void {
  const subsubcommand = args._subfile as string | undefined;
  if (subsubcommand === "report") {
    cmdRunnerCoverageReport(args);
    return;
  }
  if (subsubcommand === "gate") {
    cmdRunnerCoverageGate(args);
    return;
  }
  if (subsubcommand === "fleet") {
    cmdRunnerCoverageFleet(args);
    return;
  }
  console.error(
    `[config_error] Unknown runner coverage subcommand: ${subsubcommand ?? "(none)"}`,
  );
  console.error(
    "Usage:\n" +
      "  runner coverage report --annotation <annotation.json> [--format markdown|json]\n" +
      "  runner coverage gate --annotation <annotation.json> --assert-claim TYPE:DIM[,TYPE:DIM...] [--policy <claims.json>] [--format text|json|sarif]\n" +
      "  runner coverage fleet (--dir <dir> | --annotations <a.json,b.json,...>) [--format markdown|json]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdRunnerCoverageFleet(args: Record<string, string | boolean>): void {
  const format = (args.format as string) ?? "markdown";
  const paths: string[] = [];
  const dir = args.dir;
  if (typeof dir === "string" && dir.length > 0) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    } catch (err) {
      console.error(
        `[config_error] --dir unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT.CONFIG_ERROR);
    }
    for (const n of names) paths.push(`${dir}/${n}`);
  }
  const annotations = args.annotations;
  if (typeof annotations === "string" && annotations.length > 0) {
    for (const part of annotations.split(",")) {
      const t = part.trim();
      if (t) paths.push(t);
    }
  }
  if (paths.length === 0) {
    console.error(
      "[config_error] no annotations (use --dir <dir> and/or --annotations <a.json,b.json,...>)",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const loaded = [];
  for (const p of paths) {
    const load = loadCoverageAnnotation(p);
    if (load.not_found) {
      console.error(`[config_error] Coverage annotation file not found: ${p}`);
      process.exit(EXIT.CONFIG_ERROR);
    }
    if (!load.valid || !load.annotation) {
      const codes = load.errors.map((e) => e.code).join(",");
      console.error(`[artifact_contract] runner coverage fleet: invalid annotation ${p} (${codes})`);
      process.exit(EXIT.ARTIFACT_CONTRACT);
    }
    loaded.push(load.annotation);
  }
  console.log(formatCoverageFleet(foldCoverageFleet(loaded), format));
  process.exit(EXIT.SUCCESS);
}

function loadCoverageOrExit(annotationArg: string | boolean | undefined): {
  annotation: import("./runner_coverage.js").CoverageAnnotation;
} {
  if (typeof annotationArg !== "string" || annotationArg.length === 0) {
    console.error(
      "[config_error] --annotation <annotation.json> is required (must be a non-empty path)",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const load = loadCoverageAnnotation(annotationArg);
  if (load.not_found) {
    console.error(`[config_error] Coverage annotation file not found: ${annotationArg}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!load.valid || !load.annotation) {
    const codes = load.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] runner coverage: invalid annotation (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  return { annotation: load.annotation };
}

function cmdRunnerCoverageReport(args: Record<string, string | boolean>): void {
  const format = (args.format as string) ?? "markdown";
  const { annotation } = loadCoverageOrExit(args.annotation);
  const projection = buildCoverageProjection(annotation);
  console.log(formatCoverageReport(projection, format));
  // Report is informational only.
  process.exit(EXIT.SUCCESS);
}

function collectClaimSpecs(args: Record<string, string | boolean>): string[] {
  const specs: string[] = [];
  const assert = args["assert-claim"];
  if (typeof assert === "string" && assert.length > 0) {
    for (const part of assert.split(",")) {
      const t = part.trim();
      if (t) specs.push(t);
    }
  }
  const policy = args.policy;
  if (typeof policy === "string" && policy.length > 0) {
    try {
      const parsed = JSON.parse(readFileSync(policy, "utf8"));
      if (Array.isArray(parsed)) {
        for (const item of parsed) specs.push(String(item));
      } else {
        console.error("[config_error] --policy file must contain a JSON array of claim strings");
        process.exit(EXIT.CONFIG_ERROR);
      }
    } catch (err) {
      console.error(
        `[config_error] --policy file unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT.CONFIG_ERROR);
    }
  }
  return specs;
}

function cmdRunnerCoverageGate(args: Record<string, string | boolean>): void {
  const format = (args.format as string) ?? "text";
  const { annotation } = loadCoverageOrExit(args.annotation);
  const specs = collectClaimSpecs(args);
  if (specs.length === 0) {
    console.error(
      "[config_error] no claims asserted (use --assert-claim TYPE:DIM[,...] and/or --policy <file>)",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const res = gateCoverageClaims(annotation, specs);
  if (!res.ok || !res.gate) {
    console.error(`[config_error] ${res.error ?? "invalid claim spec"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  console.log(formatCoverageGate(res.gate, format));
  const blocked = res.gate.results.filter((r) => !r.permitted).map((r) => r.claim);
  if (blocked.length > 0) {
    console.error(`[regression] runner coverage gate: blocked claims (${blocked.join(",")})`);
    process.exit(EXIT.REGRESSION);
  }
  console.error("[success] runner coverage gate: all asserted claims permitted");
  process.exit(EXIT.SUCCESS);
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

function cmdTrustBasisGate(args: Record<string, string | boolean>): void {
  const baselinePath = args.baseline as string;
  const candidatePath = args.candidate as string;
  const outPath = args.out as string;
  const assayBin = args["assay-bin"] as string | undefined;

  try {
    const result = runTrustBasisGate({
      baseline: baselinePath,
      candidate: candidatePath,
      out: outPath,
      assayBin,
    });
    console.log(formatTrustBasisGateSummary(result, outPath));
    process.exit(result.hasRegressions ? EXIT.REGRESSION : EXIT.SUCCESS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[config_error] ${message}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
}

function cmdTrustBasisReport(args: Record<string, string | boolean>): void {
  const diffPath = args.diff as string;
  const summaryOut = args["summary-out"] as string | undefined;
  const junitOut = args["junit-out"] as string | undefined;

  try {
    const result = runTrustBasisReport({
      diff: diffPath,
      summaryOut,
      junitOut,
    });
    if (result.summaryMarkdown && !summaryOut) {
      console.log(result.summaryMarkdown.trimEnd());
    }
    console.log("[trust-basis-report] schema: assay.trust-basis.diff.v1");
    if (summaryOut) console.log(`[trust-basis-report] summary: ${summaryOut}`);
    if (junitOut) console.log(`[trust-basis-report] junit: ${junitOut}`);
    process.exit(EXIT.SUCCESS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TrustBasisReportError && err.kind === "ci_formatter") {
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
    console.error(`[config_error] ${message}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
}

function cmdTrustBasis(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string;
  if (subcommand === "gate") {
    cmdTrustBasisGate(args);
    return;
  }
  if (subcommand === "report") {
    cmdTrustBasisReport(args);
    return;
  }

  console.error(`[config_error] Unknown trust-basis subcommand: ${subcommand ?? "(none)"}`);
  console.error(
    "Usage: trust-basis <gate|report> [options]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdPolicy(args: Record<string, string | boolean>): void {
  const policyPath = (args.policy as string) ?? resolve(__dirname, "..", "policy.yaml");
  const toolName = args.tool as string;

  if (!toolName) {
    console.error("[config_error] --tool is required");
    process.exit(EXIT.CONFIG_ERROR);
  }

  if (!existsSync(policyPath)) {
    console.error(`[config_error] Policy file not found: ${policyPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const policy = PolicyEngine.fromFile(policyPath);
  const result = policy.evaluateTool(toolName);

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.decision === "deny" ? EXIT.POLICY_VIOLATION : EXIT.SUCCESS);
}

function cmdBaseline(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string;
  const baselineDir = (args.dir as string) ?? resolve(process.cwd(), "baselines");
  const baselinePath = resolve(baselineDir, "baseline.assay.ndjson");

  if (!subcommand || subcommand === "path") {
    // Show the current baseline path
    console.log(baselinePath);
    if (existsSync(baselinePath)) {
      const content = readFileSync(baselinePath, "utf-8");
      const lineCount = content.trim().split("\n").filter((l) => l.length > 0).length;
      console.log(`[baseline] exists: ${lineCount} events`);
    } else {
      console.log(`[baseline] not found`);
    }
    process.exit(EXIT.SUCCESS);
  }

  if (subcommand === "show") {
    if (!existsSync(baselinePath)) {
      console.error(`[config_error] No baseline found at: ${baselinePath}`);
      process.exit(EXIT.CONFIG_ERROR);
    }
    const content = readFileSync(baselinePath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    console.log(`[baseline] ${baselinePath}`);
    console.log(`[baseline] events: ${lines.length}`);

    // Show event types and summary
    const types = new Set<string>();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        types.add(event.type);
      } catch { /* skip */ }
    }
    for (const type of [...types].sort()) {
      console.log(`  - ${type}`);
    }
    process.exit(EXIT.SUCCESS);
  }

  if (subcommand === "update") {
    const fromPath = args.from as string;
    if (!fromPath) {
      console.error(`[config_error] --from is required for baseline update`);
      console.error(`Usage: baseline update --from <evidence.ndjson> [--dir <baselines/>]`);
      process.exit(EXIT.CONFIG_ERROR);
    }
    if (!existsSync(fromPath)) {
      console.error(`[config_error] Source file not found: ${fromPath}`);
      process.exit(EXIT.CONFIG_ERROR);
    }

    // Verify the source file is valid evidence
    const content = readFileSync(fromPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);

    // Basic validation: each line must be valid JSON with required fields
    for (let i = 0; i < lines.length; i++) {
      try {
        const event = JSON.parse(lines[i]);
        if (!event.specversion || !event.type || !event.assayrunid) {
          console.error(`[artifact_contract] Line ${i + 1}: missing required envelope fields`);
          process.exit(EXIT.ARTIFACT_CONTRACT);
        }
      } catch {
        console.error(`[artifact_contract] Line ${i + 1}: invalid JSON`);
        process.exit(EXIT.ARTIFACT_CONTRACT);
      }
    }

    // Create baseline directory if needed
    if (!existsSync(baselineDir)) {
      mkdirSync(baselineDir, { recursive: true });
    }

    // Copy with metadata
    copyFileSync(fromPath, baselinePath);

    // Write metadata
    const meta = {
      updated_at: new Date().toISOString().replace("+00:00", "Z"),
      source: fromPath,
      event_count: lines.length,
      source_file: basename(fromPath),
    };
    writeFileSync(
      resolve(baselineDir, "baseline.meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8"
    );

    console.log(`[baseline] updated: ${baselinePath}`);
    console.log(`[baseline] events: ${lines.length}`);
    console.log(`[baseline] source: ${fromPath}`);
    process.exit(EXIT.SUCCESS);
  }

  console.error(`[config_error] Unknown baseline subcommand: ${subcommand}`);
  console.error(`Usage: baseline <update|show|path> [--from <path>] [--dir <path>]`);
  process.exit(EXIT.CONFIG_ERROR);
}

// --- Main ---

const args = parseArgs(process.argv.slice(2));
const command = args._command as string;

switch (command) {
  case "compare":
    cmdCompare(args);
    break;
  case "verify-runner":
    cmdVerifyRunner(args);
    break;
  case "runner":
    cmdRunner(args);
    break;
  case "trust-basis":
    cmdTrustBasis(args);
    break;
  case "verify":
    cmdVerify(args);
    break;
  case "baseline":
    cmdBaseline(args);
    break;
  case "policy":
    cmdPolicy(args);
    break;
  case "run":
    cmdRun(args);
    break;
  default:
    usage();
}
