import type { PackManifest } from "./suite_evidence_pack.js";

const EXTERNAL_BUNDLE_ROLE = "external_attestation_bundle";

export function formatPackMarkdown(manifest: PackManifest): string {
  const src = (role: string) => (manifest.source_of_truth ?? []).find((e) => e.role === role)?.digest ?? "—";
  const lines: string[] = [];
  lines.push("# Assay Evidence Pack");
  lines.push("");
  lines.push(`Schema: ${manifest.schema}`);
  lines.push(`Subject: ${manifest.subject.carrier}`);
  lines.push(`Assay: ${manifest.subject.assay_version} · Harness: ${manifest.producer.version}`);
  lines.push("");
  lines.push("## Source of truth");
  lines.push(`- Assay carrier: ${src("assay_carrier")}`);
  lines.push(`- Suite matrix: ${src("suite_matrix")}`);
  lines.push(`- Recipe provenance: ${src("recipe_provenance")}`);
  lines.push("");
  lines.push("## Projections");
  for (const p of manifest.projections ?? []) lines.push(`- ${p.role}: lossy, source ${p.source_digest}`);
  const bundle = (manifest.external_evidence ?? []).find((e) => e.role === EXTERNAL_BUNDLE_ROLE);
  if (bundle) {
    lines.push("");
    lines.push("## External attestation cross-check");
    lines.push(`- Provider: ${bundle.provider ?? "github"}`);
    lines.push(`- Subject digest: ${bundle.subject_digest ?? "—"}`);
    lines.push(`- Bundle digest: ${bundle.digest}`);
    lines.push(`- Media type: ${bundle.media_type ?? "—"}`);
    lines.push(`- Binding: ${bundle.binding?.to ?? "none"}`);
    lines.push("- Signature trust verified by Harness: no");
    lines.push("- Subject decoded by Harness: yes");
  }
  lines.push("");
  lines.push("## Limits");
  lines.push("- This pack is not approval and not policy review.");
  lines.push("- Inventory coverage is bounded to scanned fixture sources.");
  lines.push("- Plimsoll review is not included.");
  if (bundle) {
    lines.push("- External attestation is included and digest-bound, not verified for trust by the Harness.");
    lines.push("- GitHub attested the release asset, not the extracted binary.");
  }
  return lines.join("\n");
}
