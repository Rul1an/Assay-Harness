#!/usr/bin/env node
/**
 * CLI entry point for the Assay Harness.
 *
 * Commands:
 *   run      — run the harness agent with policy enforcement
 *   verify   — verify a harness evidence file against the artifact contract
 *   policy   — evaluate a tool name against a policy file
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessAgent } from "./agent.js";
import { PolicyEngine } from "./policy.js";
import { runHarness } from "./harness.js";
import { EvidenceCompiler } from "./evidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage(): never {
  console.log(`assay-harness — Approval-aware resumable harness with Assay evidence governance

Commands:
  run      --policy <path> --input <prompt> [--output <path>] [--auto-approve] [--auto-deny]
  verify   <evidence-file>
  policy   --policy <path> --tool <name>

Options:
  --policy       Path to policy YAML file
  --input        Agent input prompt
  --output       Output path for evidence NDJSON (default: results/evidence.ndjson)
  --auto-approve Auto-approve all approval-required tools
  --auto-deny    Auto-deny all approval-required tools
  --run-id       Custom run ID (default: generated)
  --format       Output format: ndjson | json (default: ndjson)
`);
  process.exit(1);
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

async function cmdRun(args: Record<string, string | boolean>): Promise<void> {
  const policyPath = (args.policy as string) ?? resolve(__dirname, "..", "policy.yaml");
  const input = (args.input as string) ?? "List the files in /tmp and then write a summary to /tmp/summary.txt";
  const outputPath = (args.output as string) ?? "results/evidence.ndjson";
  const format = (args.format as string) ?? "ndjson";
  const runId = (args["run-id"] as string) ?? `harness-${Date.now()}`;

  if (!existsSync(policyPath)) {
    console.error(`Policy file not found: ${policyPath}`);
    process.exit(2);
  }

  const policy = PolicyEngine.fromFile(policyPath);
  const agent = createHarnessAgent();

  console.log(`[harness] run-id: ${runId}`);
  console.log(`[harness] policy: ${policy.policyId}`);
  console.log(`[harness] input: "${input.slice(0, 80)}..."`);
  console.log();

  const result = await runHarness(
    {
      agent,
      policy,
      runId,
      autoApprove: args["auto-approve"] === true,
      autoDeny: args["auto-deny"] === true,
    },
    input
  );

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

  // Exit code: 0 = clean, 1 = denied actions present
  process.exit(result.denied.length > 0 ? 1 : 0);
}

function cmdVerify(args: Record<string, string | boolean>): void {
  const filePath = args._file as string;
  if (!filePath || !existsSync(filePath)) {
    console.error(`Evidence file not found: ${filePath}`);
    process.exit(2);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  let valid = 0;
  let invalid = 0;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const event = JSON.parse(lines[i]);

      // Basic contract checks
      if (event.specversion !== "1.0") {
        errors.push(`line ${i + 1}: specversion must be 1.0`);
        invalid++;
        continue;
      }
      if (!event.type || !event.type.startsWith("assay.harness.")) {
        errors.push(`line ${i + 1}: type must start with assay.harness.`);
        invalid++;
        continue;
      }
      if (!event.assayrunid) {
        errors.push(`line ${i + 1}: missing assayrunid`);
        invalid++;
        continue;
      }
      if (!event.assaycontenthash || !event.assaycontenthash.startsWith("sha256:")) {
        errors.push(`line ${i + 1}: missing or invalid assaycontenthash`);
        invalid++;
        continue;
      }
      if (!event.data || typeof event.data !== "object") {
        errors.push(`line ${i + 1}: missing or invalid data`);
        invalid++;
        continue;
      }

      // Type-specific validation
      if (event.type === "assay.harness.approval-interruption") {
        const d = event.data;
        if (d.pause_reason !== "tool_approval") {
          errors.push(`line ${i + 1}: pause_reason must be tool_approval`);
          invalid++;
          continue;
        }
        if (!Array.isArray(d.interruptions) || d.interruptions.length === 0) {
          errors.push(`line ${i + 1}: interruptions must be a non-empty array`);
          invalid++;
          continue;
        }
        if (!d.resume_state_ref || !d.resume_state_ref.startsWith("sha256:")) {
          errors.push(`line ${i + 1}: resume_state_ref must be a sha256 hash`);
          invalid++;
          continue;
        }
      }

      valid++;
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      invalid++;
    }
  }

  console.log(`[verify] ${filePath}`);
  console.log(`[verify] valid events: ${valid}`);
  console.log(`[verify] invalid events: ${invalid}`);

  if (errors.length > 0) {
    console.log(`\n[verify] errors:`);
    for (const err of errors) {
      console.log(`  - ${err}`);
    }
  }

  process.exit(invalid > 0 ? 1 : 0);
}

function cmdPolicy(args: Record<string, string | boolean>): void {
  const policyPath = (args.policy as string) ?? resolve(__dirname, "..", "policy.yaml");
  const toolName = args.tool as string;

  if (!toolName) {
    console.error("--tool is required");
    process.exit(2);
  }

  if (!existsSync(policyPath)) {
    console.error(`Policy file not found: ${policyPath}`);
    process.exit(2);
  }

  const policy = PolicyEngine.fromFile(policyPath);
  const result = policy.evaluateTool(toolName);

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.decision === "deny" ? 1 : 0);
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
  case "policy":
    cmdPolicy(args);
    break;
  default:
    usage();
}
