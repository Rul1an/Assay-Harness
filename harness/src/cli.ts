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

import { cmdBaseline } from "./cli_baseline.js";
import { cmdCarrier } from "./cli_carrier.js";
import { cmdCompare } from "./cli_compare.js";
import { EXIT } from "./cli_exit.js";
import { cmdPolicy } from "./cli_policy.js";
import { cmdRun } from "./cli_run.js";
import { cmdRunner, cmdVerifyRunner } from "./cli_runner.js";
import { cmdEvidencePack, cmdSuite } from "./cli_suite.js";
import { cmdTrustBasis } from "./cli_trust_basis.js";
import { cmdVerify } from "./cli_verify.js";

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
  runner claims report --claims <claims.json> --annotation <annotation.json> [--format markdown|json]
  runner claims gate --claims <claims.json> --annotation <annotation.json> [--allow-degraded] [--format markdown|json]
  runner sandbox report --events <events.json> [--format markdown|json]
  runner sandbox gate --events <events.json> [--allow-degraded] [--format markdown|json]
  carrier supply-chain --carrier <supply-chain-conformance.json> [--out-dir <dir>] [--format markdown|json]
  carrier render-safety --carrier <render-safety-conformance.json> [--out-dir <dir>] [--format markdown|json]
  carrier token-passthrough --carrier <token-passthrough-conformance.json> [--out-dir <dir>] [--format markdown|json]
  carrier enforcement-health --carrier <enforcement-health.json> [--out-dir <dir>] [--format markdown|json]
  carrier check --carrier <conformance.json> [--format markdown|json]
  carrier inventory --carrier <mcp-server-inventory.json> [--out-dir <dir>] [--format markdown|json]
  carrier coding-agent --carrier <coding-agent-evidence-event.json> [--out-dir <dir>] [--format markdown|json]
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
  case "carrier":
    cmdCarrier(args);
    break;
  case "suite":
    cmdSuite(args);
    break;
  case "evidence-pack":
    cmdEvidencePack(args);
    break;
  case "run":
    cmdRun(args);
    break;
  default:
    usage();
}
