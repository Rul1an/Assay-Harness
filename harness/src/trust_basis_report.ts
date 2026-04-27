import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TrustBasisReportArgs {
  diff: string;
  summaryOut?: string;
  junitOut?: string;
}

export interface TrustBasisDiffSummary {
  regressed_claims: number;
  improved_claims: number;
  removed_claims: number;
  added_claims: number;
  metadata_changes: number;
  unchanged_claim_count: number;
  has_regressions: boolean;
}

export interface TrustBasisDiffItem {
  diff_class: string;
  claim_id: string;
  baseline_level?: string | null;
  candidate_level?: string | null;
}

export interface TrustBasisDiffReport {
  schema: "assay.trust-basis.diff.v1";
  claim_identity: "claim.id";
  summary: TrustBasisDiffSummary;
  regressed_claims: TrustBasisDiffItem[];
  improved_claims: TrustBasisDiffItem[];
  removed_claims: TrustBasisDiffItem[];
  added_claims: TrustBasisDiffItem[];
  metadata_changes: TrustBasisDiffItem[];
  unchanged_claim_count: number;
}

export interface TrustBasisProjectionResult {
  report: TrustBasisDiffReport;
  summaryMarkdown?: string;
  junitXml?: string;
}

export class TrustBasisReportError extends Error {
  readonly kind = "config_error";

  constructor(message: string) {
    super(message);
    this.name = "TrustBasisReportError";
  }
}

export function runTrustBasisReport(args: TrustBasisReportArgs): TrustBasisProjectionResult {
  const report = readTrustBasisDiff(args.diff);
  const result: TrustBasisProjectionResult = { report };

  if (args.summaryOut) {
    result.summaryMarkdown = formatTrustBasisSummaryMarkdown(report, args.diff);
    writeOutput(args.summaryOut, result.summaryMarkdown);
  }

  if (args.junitOut) {
    result.junitXml = formatTrustBasisJUnit(report);
    writeOutput(args.junitOut, result.junitXml);
  }

  if (!args.summaryOut && !args.junitOut) {
    result.summaryMarkdown = formatTrustBasisSummaryMarkdown(report, args.diff);
  }

  return result;
}

export function readTrustBasisDiff(path: string): TrustBasisDiffReport {
  if (!path || !existsSync(path)) {
    throw new TrustBasisReportError(`Trust Basis diff file not found: ${path || "(none)"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TrustBasisReportError(`failed to parse Trust Basis diff JSON: ${path}`);
  }

  if (!isTrustBasisDiffReport(parsed)) {
    throw new TrustBasisReportError(
      "Trust Basis reporter only consumes assay.trust-basis.diff.v1",
    );
  }
  return normalizeReport(parsed);
}

export function formatTrustBasisSummaryMarkdown(
  report: TrustBasisDiffReport,
  diffPath: string,
): string {
  const status = report.summary.has_regressions ? "REGRESSION" : "OK";
  const lines = [
    "## Trust Basis Gate",
    "",
    `**Status:** ${status}`,
    `**Schema:** \`${report.schema}\``,
    `**Claim identity:** \`${report.claim_identity}\``,
    `**Diff artifact:** \`${diffPath}\``,
    "",
    "| Category | Count | Blocking |",
    "| --- | ---: | --- |",
    `| Regressed claims | ${report.summary.regressed_claims} | yes |`,
    `| Removed claims | ${report.summary.removed_claims} | yes |`,
    `| Improved claims | ${report.summary.improved_claims} | no |`,
    `| Added claims | ${report.summary.added_claims} | no |`,
    `| Metadata changes | ${report.summary.metadata_changes} | no |`,
    `| Unchanged claims | ${report.summary.unchanged_claim_count} | no |`,
  ];

  appendClaimList(lines, "Regressed Claims", report.regressed_claims);
  appendClaimList(lines, "Removed Claims", report.removed_claims);

  return lines.join("\n") + "\n";
}

export function formatTrustBasisJUnit(report: TrustBasisDiffReport): string {
  const cases = [
    ...testCasesFor("regressed_claims", report.regressed_claims, true),
    ...testCasesFor("removed_claims", report.removed_claims, true),
    ...testCasesFor("improved_claims", report.improved_claims, false),
    ...testCasesFor("added_claims", report.added_claims, false),
    ...testCasesFor("metadata_changes", report.metadata_changes, false),
  ].sort((a, b) => {
    const claimOrder = a.item.claim_id.localeCompare(b.item.claim_id);
    if (claimOrder !== 0) {
      return claimOrder;
    }
    return a.name.localeCompare(b.name);
  });

  const failures = cases.filter((testCase) => testCase.failure).length;
  const body = cases.map(formatTestCase).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="assay.trust-basis.diff" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">`,
    body,
    `<system-out>${xmlEscape(summaryLine(report))}</system-out>`,
    "</testsuite>",
    "",
  ].join("\n");
}

function writeOutput(path: string, content: string): void {
  const outDir = dirname(path);
  if (outDir && outDir !== ".") {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(path, content, "utf8");
}

function appendClaimList(lines: string[], title: string, items: TrustBasisDiffItem[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push("", `### ${title}`);
  for (const item of sortedItems(items)) {
    lines.push(`- \`${item.claim_id}\`: ${levelLabel(item.baseline_level)} -> ${levelLabel(item.candidate_level)}`);
  }
}

interface JUnitCase {
  name: string;
  classname: string;
  item: TrustBasisDiffItem;
  failure: boolean;
}

function testCasesFor(
  category: string,
  items: TrustBasisDiffItem[],
  failure: boolean,
): JUnitCase[] {
  return sortedItems(items).map((item) => ({
    name: `${category}.${item.claim_id}`,
    classname: "assay.trust-basis.diff",
    item,
    failure,
  }));
}

function formatTestCase(testCase: JUnitCase): string {
  const open = `  <testcase classname="${xmlEscape(testCase.classname)}" name="${xmlEscape(testCase.name)}">`;
  if (!testCase.failure) {
    return `${open}</testcase>\n`;
  }

  const message = `${testCase.item.claim_id}: ${levelLabel(testCase.item.baseline_level)} -> ${levelLabel(testCase.item.candidate_level)}`;
  return [
    open,
    `    <failure message="${xmlEscape(message)}">${xmlEscape(message)}</failure>`,
    "  </testcase>",
    "",
  ].join("\n");
}

function summaryLine(report: TrustBasisDiffReport): string {
  const summary = report.summary;
  return [
    `regressed=${summary.regressed_claims}`,
    `removed=${summary.removed_claims}`,
    `improved=${summary.improved_claims}`,
    `added=${summary.added_claims}`,
    `metadata=${summary.metadata_changes}`,
    `unchanged=${summary.unchanged_claim_count}`,
  ].join(" ");
}

function sortedItems(items: TrustBasisDiffItem[]): TrustBasisDiffItem[] {
  return [...items].sort((left, right) => {
    const claimOrder = left.claim_id.localeCompare(right.claim_id);
    if (claimOrder !== 0) {
      return claimOrder;
    }
    return left.diff_class.localeCompare(right.diff_class);
  });
}

function normalizeReport(value: TrustBasisDiffReport): TrustBasisDiffReport {
  return {
    ...value,
    regressed_claims: sortedItems(value.regressed_claims),
    improved_claims: sortedItems(value.improved_claims),
    removed_claims: sortedItems(value.removed_claims),
    added_claims: sortedItems(value.added_claims),
    metadata_changes: sortedItems(value.metadata_changes),
  };
}

function levelLabel(value: string | null | undefined): string {
  return value ?? "absent";
}

function isTrustBasisDiffReport(value: unknown): value is TrustBasisDiffReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    report.schema === "assay.trust-basis.diff.v1" &&
    report.claim_identity === "claim.id" &&
    isSummary(report.summary) &&
    isDiffArray(report.regressed_claims) &&
    isDiffArray(report.improved_claims) &&
    isDiffArray(report.removed_claims) &&
    isDiffArray(report.added_claims) &&
    isDiffArray(report.metadata_changes) &&
    typeof report.unchanged_claim_count === "number"
  );
}

function isSummary(value: unknown): value is TrustBasisDiffSummary {
  if (!value || typeof value !== "object") {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(summary.regressed_claims) &&
    isNonNegativeInteger(summary.improved_claims) &&
    isNonNegativeInteger(summary.removed_claims) &&
    isNonNegativeInteger(summary.added_claims) &&
    isNonNegativeInteger(summary.metadata_changes) &&
    isNonNegativeInteger(summary.unchanged_claim_count) &&
    typeof summary.has_regressions === "boolean"
  );
}

function isDiffArray(value: unknown): value is TrustBasisDiffItem[] {
  return Array.isArray(value) && value.every(isDiffItem);
}

function isDiffItem(value: unknown): value is TrustBasisDiffItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.diff_class === "string" && typeof item.claim_id === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
