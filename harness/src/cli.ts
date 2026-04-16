#!/usr/bin/env node
/**
 * CLI entry point for the Assay Harness.
 *
 * Commands:
 *   run      — run the harness agent with policy enforcement
 *   verify   — verify evidence file against the artifact contract
 *   compare  — compare baseline vs candidate evidence for regressions
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

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessAgent } from "./agent.js";
import { PolicyEngine } from "./policy.js";
import { runHarness } from "./harness.js";
import { compareEvidence, formatCompareResult } from "./compare.js";

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
  run      --policy <path> --input <prompt> [--output <path>] [--auto-approve] [--auto-deny]
  verify   <evidence-file> [--category <all|envelope|hash|type>]
  compare  --baseline <path> --candidate <path> [--format markdown|json]
  policy   --policy <path> --tool <name>

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
  return args;
}

// --- Verify checks by category ---

interface VerifyError {
  line: number;
  category: "envelope" | "hash" | "type" | "parse";
  code: string;
  message: string;
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

      // Rejected content checks
      if (event.data) {
        const rejectedKeys = ["raw_run_state", "history", "newItems", "lastResponseId", "session"];
        for (const key of rejectedKeys) {
          if (key in event.data) {
            errors.push({
              line: lineNum,
              category: "type",
              code: "VERIFY_REJECTED_KEY",
              message: `data contains rejected key "${key}" — raw state must not appear in evidence`,
            });
          }
        }
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

  if (!baselinePath || !existsSync(baselinePath)) {
    console.error(`[config_error] Baseline file not found: ${baselinePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!candidatePath || !existsSync(candidatePath)) {
    console.error(`[config_error] Candidate file not found: ${candidatePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const result = compareEvidence(baselinePath, candidatePath);

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCompareResult(result));
  }

  process.exit(result.has_regressions ? EXIT.REGRESSION : EXIT.SUCCESS);
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

// --- Main ---

const args = parseArgs(process.argv.slice(2));
const command = args._command as string;

switch (command) {
  case "run":
    cmdRun(args);
    break;
  case "verify":
    cmdVerify(args);
    break;
  case "compare":
    cmdCompare(args);
    break;
  case "policy":
    cmdPolicy(args);
    break;
  default:
    usage();
}
