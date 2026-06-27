import { EXIT } from "./cli_exit.js";
import {
  formatSupplyChainMarkdown,
  formatSupplyChainSummary,
  loadSupplyChainReport,
  writeSupplyChainProjections,
} from "./carrier_supply_chain.js";
import {
  formatRenderSafetyMarkdown,
  formatRenderSafetySummary,
  loadRenderSafetyReport,
  writeRenderSafetyProjections,
} from "./carrier_render_safety.js";
import {
  formatTokenPassthroughMarkdown,
  formatTokenPassthroughSummary,
  loadTokenPassthroughReport,
  writeTokenPassthroughProjections,
} from "./carrier_token_passthrough.js";
import {
  formatCarrierContractSummary,
  loadCarrierContract,
} from "./carrier_drift.js";
import {
  formatEnforcementHealthMarkdown,
  formatEnforcementHealthSummary,
  loadEnforcementHealthReport,
  writeEnforcementHealthProjections,
} from "./carrier_enforcement_health.js";
import {
  formatMcpInventoryMarkdown,
  formatMcpInventorySummary,
  loadMcpInventoryReport,
  writeMcpInventoryProjections,
} from "./carrier_inventory.js";
import {
  formatCodingAgentMarkdown,
  formatCodingAgentSummary,
  loadCodingAgentReport,
  writeCodingAgentProjections,
} from "./carrier_coding_agent.js";

function carrierFormat(args: Record<string, string | boolean>): "markdown" | "json" {
  const format = args.format === undefined ? "markdown" : args.format;
  if (format !== "markdown" && format !== "json") {
    console.error(
      `[config_error] --format must be markdown or json; got ${JSON.stringify(args.format)}`,
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  return format;
}

// Resolve `--out-dir`. A bare `--out-dir` (no value) parses as `true`; treat that
// as a config error rather than silently skipping the projection write.
function carrierOutDir(args: Record<string, string | boolean>): string | undefined {
  const raw = args["out-dir"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    console.error("[config_error] --out-dir requires a directory path");
    process.exit(EXIT.CONFIG_ERROR);
  }
  return raw;
}

export function cmdCarrier(args: Record<string, string | boolean>): void {
  const subcommand = args._file as string | undefined;
  if (subcommand === "supply-chain") {
    cmdCarrierSupplyChain(args);
    return;
  }
  if (subcommand === "render-safety") {
    cmdCarrierRenderSafety(args);
    return;
  }
  if (subcommand === "token-passthrough") {
    cmdCarrierTokenPassthrough(args);
    return;
  }
  if (subcommand === "check") {
    cmdCarrierCheck(args);
    return;
  }
  if (subcommand === "enforcement-health") {
    cmdCarrierEnforcementHealth(args);
    return;
  }
  if (subcommand === "inventory") {
    cmdCarrierInventory(args);
    return;
  }
  if (subcommand === "coding-agent") {
    cmdCarrierCodingAgent(args);
    return;
  }
  console.error(`[config_error] Unknown carrier subcommand: ${subcommand ?? "(none)"}`);
  console.error(
    "Usage:\n" +
      "  carrier supply-chain --carrier <supply-chain-conformance.json> [--out-dir <dir>] [--format markdown|json]\n" +
      "  carrier render-safety --carrier <render-safety-conformance.json> [--out-dir <dir>] [--format markdown|json]\n" +
      "  carrier token-passthrough --carrier <token-passthrough-conformance.json> [--out-dir <dir>] [--format markdown|json]\n" +
      "  carrier enforcement-health --carrier <enforcement-health.json> [--out-dir <dir>] [--format markdown|json]\n" +
      "  carrier check --carrier <conformance.json> [--format markdown|json]\n" +
      "  carrier inventory --carrier <mcp-server-inventory.json> [--out-dir <dir>] [--format markdown|json]\n" +
      "  carrier coding-agent --carrier <coding-agent-evidence-event.json> [--out-dir <dir>] [--format markdown|json]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdCarrierSupplyChain(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  // Bare `--carrier` without a value parses as `true`; require a non-empty path.
  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <supply-chain-conformance.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier supply-chain --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadSupplyChainReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] Supply-chain carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  // Write projection artifacts when requested; a write failure is a formatter error.
  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeSupplyChainProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable;
  // the human summary and the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSupplyChainMarkdown(report).trimEnd());
    console.log(formatSupplyChainSummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(
      `[carrier-supply-chain] artifacts: ${outDir}/supply-chain-conformance.{md,junit.xml,sarif.json}`,
    );
  }

  // Exit routing (carrier-local, producer-owned):
  //   - invalid carrier (malformed JSON, schema mismatch, unknown status /
  //     policy_result, contract-shape violation) -> ARTIFACT_CONTRACT (3)
  //   - valid but policy_result != pass (fail or incomplete) -> REGRESSION (6);
  //     incomplete is never clean
  //   - valid and policy_result == pass -> SUCCESS (0)
  //   - missing file / bare --carrier -> CONFIG_ERROR (2) (handled above)
  // The gate consumes the producer's own policy_result; it does not re-derive a
  // verdict from the dimensions (policy-aware review is a separate, private step).
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier supply-chain: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (!report.passed) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierRenderSafety(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <render-safety-conformance.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier render-safety --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadRenderSafetyReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] Render-safety carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeRenderSafetyProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable;
  // the human summary and the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatRenderSafetyMarkdown(report).trimEnd());
    console.log(formatRenderSafetySummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(
      `[carrier-render-safety] artifacts: ${outDir}/render-safety-conformance.{md,junit.xml,sarif.json}`,
    );
  }

  // Exit routing: invalid carrier -> ARTIFACT_CONTRACT (3); a sink the producer
  // reports as not clean (any raw leak, truncation-order, or benign-overredaction)
  // -> REGRESSION (6); all sinks clean -> SUCCESS (0). The gate consumes the
  // producer-reported per-sink facts; it does not re-render or re-judge.
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier render-safety: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (!report.passed) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierTokenPassthrough(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <token-passthrough-conformance.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier token-passthrough --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadTokenPassthroughReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] Token-passthrough carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeTokenPassthroughProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable;
  // the human summary and the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTokenPassthroughMarkdown(report).trimEnd());
    console.log(formatTokenPassthroughSummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(
      `[carrier-token-passthrough] artifacts: ${outDir}/token-passthrough-conformance.{md,junit.xml,sarif.json}`,
    );
  }

  // Exit routing: invalid carrier -> ARTIFACT_CONTRACT (3); a checked outbound
  // channel the producer reports as leaked or failed -> REGRESSION (6); no checked
  // channel leaked -> SUCCESS (0). The gate consumes the producer-reported per-channel
  // facts; not_applicable channels are out of scope.
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier token-passthrough: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (!report.passed) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierEnforcementHealth(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <enforcement-health.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier enforcement-health --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadEnforcementHealthReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] Enforcement-health carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeEnforcementHealthProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable;
  // the human summary and the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatEnforcementHealthMarkdown(report).trimEnd());
    console.log(formatEnforcementHealthSummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(
      `[carrier-enforcement-health] artifacts: ${outDir}/enforcement-health.{md,junit.xml,sarif.json}`,
    );
  }

  // Exit routing (carrier-local honest-state; the enforcement-truth review is a
  // separate, private step):
  //   - invalid carrier -> ARTIFACT_CONTRACT (3)
  //   - status=failed (enforcement requested but not installed) -> REGRESSION (6)
  //   - status=active -> SUCCESS (0)
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier enforcement-health: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (!report.passed) {
    process.exit(EXIT.REGRESSION);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierCheck(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error("[config_error] --carrier <conformance.json> is required (must be a non-empty path)");
    console.error("Usage: carrier check --carrier <path> [--format markdown|json]");
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadCarrierContract(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] Carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const result = load.result!;

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCarrierContractSummary(result));
  }

  // Exit routing (contract / shape dimension only; the gate verdict is the
  // schema-specific verb's job):
  //   - recognized schema + valid shape -> SUCCESS (0)
  //   - unknown schema id, missing/non-string schema, malformed JSON, or a
  //     recognized schema whose shape drifted -> ARTIFACT_CONTRACT (3)
  //   - missing file / bare --carrier -> CONFIG_ERROR (2) (handled above)
  if (!result.recognized || !result.valid) {
    const codes = result.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier check: contract not recognized or drifted (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierInventory(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <mcp-server-inventory.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier inventory --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadMcpInventoryReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] MCP inventory carrier file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeMcpInventoryProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable;
  // the human summary and the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMcpInventoryMarkdown(report).trimEnd());
    console.log(formatMcpInventorySummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(`[carrier-inventory] artifacts: ${outDir}/mcp-server-inventory.md`);
  }

  // Exit routing (DESCRIPTIVE / non-gating): a valid inventory exits 0 regardless of
  // contents; only a malformed / wrong-schema / unknown-coverage-state carrier is a
  // contract error (3). Drift / approval over the inventory is a separate review step.
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier inventory: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}

function cmdCarrierCodingAgent(args: Record<string, string | boolean>): void {
  const carrierArg = args.carrier;
  const outDir = carrierOutDir(args);
  const format = carrierFormat(args);

  if (typeof carrierArg !== "string" || carrierArg.length === 0) {
    console.error(
      "[config_error] --carrier <coding-agent-evidence-event.json> is required (must be a non-empty path)",
    );
    console.error(
      "Usage: carrier coding-agent --carrier <path> [--out-dir <dir>] [--format markdown|json]",
    );
    process.exit(EXIT.CONFIG_ERROR);
  }
  const carrierPath = carrierArg;

  const load = loadCodingAgentReport(carrierPath);
  if (load.not_found) {
    console.error(`[config_error] coding-agent evidence event file not found: ${carrierPath}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  const report = load.report!;

  if (typeof outDir === "string" && outDir.length > 0) {
    try {
      writeCodingAgentProjections(report, outDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ci_formatter] ${message}`);
      process.exit(EXIT.CI_FORMATTER);
    }
  }

  // `--format json` emits only the JSON document on stdout so it stays parseable; the human summary and
  // the artifacts notice go to the markdown path / stderr.
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCodingAgentMarkdown(report).trimEnd());
    console.log(formatCodingAgentSummary(report));
  }
  if (typeof outDir === "string" && outDir.length > 0) {
    console.error(`[carrier-coding-agent] artifacts: ${outDir}/coding-agent-review.md`);
  }

  // Exit routing (DESCRIPTIVE / non-gating): a valid event exits 0 regardless of contents; only a
  // malformed / wrong-type / missing-required-field event is a contract error (3). The bounded verdict
  // and effect-sufficiency are a separate downstream review consumer's job, not the Harness's.
  if (!report.validation.valid) {
    const codes = report.validation.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] carrier coding-agent: invalid carrier (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  process.exit(EXIT.SUCCESS);
}
