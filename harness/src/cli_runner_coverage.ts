import { readFileSync, readdirSync } from "node:fs";
import { EXIT } from "./cli_exit.js";
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
  buildClaimReport,
  formatClaimReport,
  loadClaims,
} from "./runner_claims.js";
import {
  parseSandboxEvents,
  sandboxGate,
  sandboxReportMarkdown,
  summarizeSandbox,
} from "./runner_sandbox.js";

export function cmdRunnerCoverage(args: Record<string, string | boolean>): void {
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

export function cmdRunnerClaims(args: Record<string, string | boolean>): void {
  const subsubcommand = args._subfile as string | undefined;
  if (subsubcommand === "report" || subsubcommand === "gate") {
    cmdRunnerClaimsReportOrGate(args, subsubcommand);
    return;
  }
  console.error(`[config_error] Unknown runner claims subcommand: ${subsubcommand ?? "(none)"}`);
  console.error(
    "Usage:\n" +
      "  runner claims report --claims <claims.json> --annotation <annotation.json> [--format markdown|json]\n" +
      "  runner claims gate --claims <claims.json> --annotation <annotation.json> [--allow-degraded] [--format markdown|json]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdRunnerClaimsReportOrGate(
  args: Record<string, string | boolean>,
  mode: "report" | "gate",
): void {
  const format = (args.format as string) ?? "markdown";
  const allowDegraded = args["allow-degraded"] === true;
  const claimsArg = args.claims;
  const annotationArg = args.annotation;
  if (typeof claimsArg !== "string" || claimsArg.length === 0) {
    console.error("[config_error] --claims <claims.json> is required (non-empty path)");
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (typeof annotationArg !== "string" || annotationArg.length === 0) {
    console.error("[config_error] --annotation <annotation.json> is required (non-empty path)");
    process.exit(EXIT.CONFIG_ERROR);
  }
  const claimsLoad = loadClaims(claimsArg);
  if (claimsLoad.not_found) {
    console.error(`[config_error] Claims file not found: ${claimsArg}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!claimsLoad.ok || !claimsLoad.claims) {
    console.error(`[artifact_contract] invalid claims document: ${claimsLoad.error}`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  const annLoad = loadCoverageAnnotation(annotationArg);
  if (annLoad.not_found) {
    console.error(`[config_error] Coverage annotation file not found: ${annotationArg}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  if (!annLoad.valid || !annLoad.annotation) {
    const codes = annLoad.errors.map((e) => e.code).join(",");
    console.error(`[artifact_contract] invalid coverage annotation (${codes})`);
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  const report = buildClaimReport(claimsLoad.claims, annLoad.annotation, allowDegraded);
  console.log(formatClaimReport(report, format));
  if (mode === "report") {
    process.exit(EXIT.SUCCESS);
  }
  if (report.passed) {
    console.error("[success] runner claims gate: all required claims supported");
    process.exit(EXIT.SUCCESS);
  }
  const failing = report.results
    .filter((r) => !(r.decision === "supported" || (r.decision === "degraded" && allowDegraded)))
    .map((r) => `${r.id}:${r.decision}`);
  console.error(`[regression] runner claims gate: unsupported claims (${failing.join(",")})`);
  process.exit(EXIT.REGRESSION);
}

export function cmdRunnerSandbox(args: Record<string, string | boolean>): void {
  const subsubcommand = args._subfile as string | undefined;
  if (subsubcommand === "report" || subsubcommand === "gate") {
    cmdRunnerSandboxReportOrGate(args, subsubcommand);
    return;
  }
  console.error(`[config_error] Unknown runner sandbox subcommand: ${subsubcommand ?? "(none)"}`);
  console.error(
    "Usage:\n" +
      "  runner sandbox report --events <events.json> [--format markdown|json]\n" +
      "  runner sandbox gate --events <events.json> [--allow-degraded] [--format markdown|json]",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

function cmdRunnerSandboxReportOrGate(
  args: Record<string, string | boolean>,
  mode: "report" | "gate",
): void {
  const format = (args.format as string) ?? "markdown";
  const allowDegraded = args["allow-degraded"] === true;
  const eventsArg = args.events;
  if (typeof eventsArg !== "string" || eventsArg.length === 0) {
    console.error("[config_error] --events <events.json> is required (non-empty path)");
    process.exit(EXIT.CONFIG_ERROR);
  }
  let raw: string;
  try {
    raw = readFileSync(eventsArg, "utf-8");
  } catch {
    console.error(`[config_error] Sandbox events file not found: ${eventsArg}`);
    process.exit(EXIT.CONFIG_ERROR);
  }
  let events;
  try {
    events = parseSandboxEvents(raw);
  } catch (err) {
    console.error(
      `[artifact_contract] invalid sandbox events document: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(EXIT.ARTIFACT_CONTRACT);
  }
  if (mode === "report") {
    const summary = summarizeSandbox(events);
    console.log(format === "json" ? JSON.stringify(summary, null, 2) : sandboxReportMarkdown(summary));
    process.exit(EXIT.SUCCESS);
  }
  const gate = sandboxGate(events, { allowDegraded });
  console.log(format === "json" ? JSON.stringify(gate, null, 2) : sandboxReportMarkdown(gate.summary));
  if (gate.pass) {
    console.error(`[success] runner sandbox gate: ${gate.reason}`);
    process.exit(EXIT.SUCCESS);
  }
  console.error(`[regression] runner sandbox gate: ${gate.reason}`);
  process.exit(EXIT.REGRESSION);
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
