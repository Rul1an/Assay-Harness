import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { SupplyChainReport } from "./carrier_supply_chain.js";

const BLOCKING_STATUSES: readonly string[] = [
  "failed",
  "subject_digest_mismatch",
  "identity_mismatch",
  "policy_not_satisfied",
];

function statusLine(report: SupplyChainReport): string {
  if (!report.validation.valid) return "SUPPLY-CHAIN CARRIER INVALID";
  if (report.policy_result === "pass") return "OK";
  if (report.policy_result === "fail") return "SUPPLY-CHAIN CONFORMANCE FAIL";
  return "SUPPLY-CHAIN CONFORMANCE INCOMPLETE";
}

function xmlEscape(value: string): string {
  // Replace XML 1.0 forbidden control characters (they cannot appear even escaped)
  // with U+FFFD, then escape entities, so a control byte in producer-supplied text
  // cannot produce malformed JUnit that breaks CI parsers.
  let cleaned = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    cleaned += cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d ? "�" : ch;
  }
  return cleaned
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatSupplyChainJUnit(report: SupplyChainReport): string {
  interface Case {
    name: string;
    failure: boolean;
    message: string;
  }
  const cases: Case[] = [];

  // One overall case for the producer verdict: anything other than pass is a failure
  // (captures `incomplete`, which has no per-dimension blocking status but is never clean).
  const verdict = report.policy_result ?? "invalid";
  cases.push({
    name: "policy_result",
    failure: verdict !== "pass",
    message: `carrier policy_result is ${verdict}`,
  });

  // One case per dimension; blocking statuses fail.
  for (const d of report.dimensions) {
    cases.push({
      name: `${d.group}.${d.name}`,
      failure: d.class === "blocking",
      message: `${d.group}.${d.name} = ${d.status}`,
    });
  }

  const failures = cases.filter((c) => c.failure).length;
  const body = cases
    .map((c) => {
      const open = `    <testcase classname="assay.supply_chain_conformance" name="${xmlEscape(c.name)}" time="0">`;
      if (!c.failure) return `${open}</testcase>\n`;
      return [
        open,
        `      <failure message="${xmlEscape(c.message)}">${xmlEscape(c.message)}</failure>`,
        "    </testcase>",
        "",
      ].join("\n");
    })
    .join("");

  const summary = `status=${statusLine(report)} policy_result=${verdict} verified=${report.counts.verified} blocking=${report.counts.blocking} pending=${report.counts.pending} not_applicable=${report.counts.not_applicable}`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="assay.supply_chain_conformance" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="0">`,
    body,
    `    <system-out>${xmlEscape(summary)}</system-out>`,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";

/**
 * SARIF rule registry. Carrier states are evidence findings, NOT vulnerabilities:
 * a `failed` dimension means "the carrier reports this verification did not hold",
 * never "an attack was detected". Rule ids are namespaced `assay.carrier.supply_chain.*`.
 */
const SARIF_RULES = [
  {
    id: "assay.carrier.supply_chain.failed",
    name: "SupplyChainCarrierFailedDimension",
    shortDescription: { text: "Supply-chain carrier reports a failed verification" },
    fullDescription: {
      text: "A dimension in the supply-chain conformance carrier reports a failed verification (failed / subject_digest_mismatch / identity_mismatch / policy_not_satisfied).",
    },
    defaultConfiguration: { level: "error" },
    properties: { "security-severity": "7.0" },
  },
  {
    id: "assay.carrier.supply_chain.incomplete",
    name: "SupplyChainCarrierIncomplete",
    shortDescription: { text: "Supply-chain carrier reports an unresolved dimension or an incomplete result" },
    fullDescription: {
      text: "The carrier reports policy_result=incomplete, or a dimension is unresolved (not_present / not_checked / online_required / trust_root_unavailable). An incomplete result is never read as clean.",
    },
    defaultConfiguration: { level: "warning" },
    properties: { "security-severity": "3.0" },
  },
  {
    id: "assay.carrier.supply_chain.unsupported",
    name: "SupplyChainCarrierUnsupportedFormat",
    shortDescription: { text: "Supply-chain carrier reports an unsupported provenance format" },
    fullDescription: {
      text: "A dimension reports unsupported_format: the provenance was present but in a format this verification slice does not handle.",
    },
    defaultConfiguration: { level: "warning" },
    properties: { "security-severity": "3.0" },
  },
];

function relativeUri(carrierPath: string): string {
  const base = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const abs = resolve(carrierPath);
  const rel = relative(base, abs);
  // Outside the workspace (escapes via "..") or on a different drive (absolute on
  // Windows) -> fall back to the basename rather than emitting a traversal path.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return basename(carrierPath);
  // SARIF artifact URIs are POSIX-style; normalize Windows "\" separators to "/".
  return rel.split(sep).join("/");
}

export function formatSupplyChainSarif(report: SupplyChainReport): string {
  const uri = relativeUri(report.carrier_path);
  const results: unknown[] = [];

  function ruleForStatus(status: string): string {
    if (BLOCKING_STATUSES.includes(status)) return "assay.carrier.supply_chain.failed";
    if (status === "unsupported_format") return "assay.carrier.supply_chain.unsupported";
    return "assay.carrier.supply_chain.incomplete";
  }
  function levelForRule(ruleId: string): string {
    return ruleId === "assay.carrier.supply_chain.failed" ? "error" : "warning";
  }

  // Overall verdict result when not clean.
  if (report.validation.valid && report.policy_result !== "pass") {
    const ruleId =
      report.policy_result === "fail"
        ? "assay.carrier.supply_chain.failed"
        : "assay.carrier.supply_chain.incomplete";
    results.push({
      ruleId,
      level: levelForRule(ruleId),
      message: { text: `Supply-chain conformance carrier reports policy_result=${report.policy_result}` },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
      partialFingerprints: { carrierVerdict: `policy_result:${report.policy_result}` },
      properties: { policy_result: report.policy_result },
    });
  }

  // One result per dimension that is blocking or unresolved (verified / not_applicable are clean).
  for (const d of report.dimensions) {
    if (d.class === "verified" || d.class === "not_applicable") continue;
    const ruleId = ruleForStatus(d.status);
    results.push({
      ruleId,
      level: levelForRule(ruleId),
      message: { text: `${d.group}.${d.name} = ${d.status}` },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
      partialFingerprints: { dimension: `${d.group}.${d.name}` },
      properties: { group: d.group, dimension: d.name, status: d.status },
    });
  }

  return (
    JSON.stringify(
      {
        $schema: SARIF_SCHEMA,
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "assay-harness-supply-chain-carrier",
                version: "0.8.0",
                informationUri: "https://github.com/Rul1an/Assay-Harness",
                rules: SARIF_RULES,
              },
            },
            results,
            automationDetails: { id: "assay-harness/supply-chain-conformance/" },
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}
