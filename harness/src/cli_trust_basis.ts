import { EXIT } from "./cli_exit.js";
import {
  formatTrustBasisGateSummary,
  runTrustBasisGate,
} from "./trust_basis_gate.js";
import {
  runTrustBasisReport,
  TrustBasisReportError,
} from "./trust_basis_report.js";

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

export function cmdTrustBasis(args: Record<string, string | boolean>): void {
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
