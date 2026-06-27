import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./cli_exit.js";
import { PolicyEngine } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function cmdPolicy(args: Record<string, string | boolean>): void {
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
