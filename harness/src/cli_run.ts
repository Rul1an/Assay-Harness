import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessAgent } from "./agent.js";
import { EXIT } from "./cli_exit.js";
import { runHarness } from "./harness.js";
import { PolicyEngine } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function cmdRun(args: Record<string, string | boolean>): Promise<void> {
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
