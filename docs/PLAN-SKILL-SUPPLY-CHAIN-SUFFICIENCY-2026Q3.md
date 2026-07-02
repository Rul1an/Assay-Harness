# Skill Supply-Chain Review Sufficiency

> **Status:** DoR, held; producer build held; a Plimsoll consumer contract pin
> is staged to follow this document
> **Target repo:** `Rul1an/Assay-Harness`
> **Source finding:** `skill-supply-chain-reviewer-2026-07`
> **SOTA anchor:** Skills Are Not Islands, arXiv:2607.01136

---

## One-Line Goal

Keep an implementation-ready carrier contract for a reviewer-facing skill
supply-chain review sufficiency layer: given a retained skill record, can a
reviewer reach a bounded conclusion about the skill's dependency chain from the
retained evidence alone? Assay-Harness does not emit the carrier until a real
reviewer workflow needs skill-dependency review states.

## Why This Is Banked

The July 2026 skill ecosystem made the gap concrete. Agent skills are shipped
as reusable artifacts that declare dependencies across three channels: other
skills, software packages, and remote services. "Skills Are Not Islands"
(arXiv:2607.01136) names these Agent Skill Supply Chains, shows recursive skill
reuse creating hidden package inventory at registry scale, and finds skill
metadata "activation-ready but governance-poor". Public registry incident
reports over February-June 2026 showed screened marketplaces still shipping
malicious skills, which means "the registry screened it" and "the root artifact
was inspected" are being read as stronger claims than they are.

Registry-side scanners answer "does this artifact trip a detector today". None
of them answer the reviewer-side question this contract covers: does the
retained evidence for this specific skill support a bounded conclusion about
its dependency chain, and if not, exactly what is missing? That distinction is
the same artifact-contract versus reviewer-state boundary that
`suite.evidence_pack.v0/v1` already keeps for evidence packs.

The frontier movement validates the finding, not the product timing. This DoR
is banked as a contract-ready document and explicitly held as a build until a
real workflow needs the states.

The sharp line from the lab finding:

> `root skill inspected` is a root-artifact claim. It does not imply transitive
> dependency coverage or absence of reachable security signals.

## Build Gate

Do not implement this as Assay-Harness product surface merely because the lab
finding is true or because the SOTA frontier is moving. Implementation requires
all of:

1. a named reviewer workflow that needs skill-dependency review states over
   retained skill records (not a hypothetical);
2. a producer that can capture the record honestly, including explicit
   `not_present` coverage flags for evidence it did not retain;
3. the Plimsoll consumer contract pin merged, so the verdict vocabulary and
   ceilings are fixed by the consumer before any producer emits them;
4. an explicit decision on where capture runs (developer machine, CI, or
   registry ingest) — this DoR does not choose.

## Consumer Contract Alignment

Plimsoll pins the consumer side: verdict vocabulary, ceiling separation, and
the absence rule. The producer carrier stays held. The pinned surface is:

- Verdicts: `review_complete`, `review_incomplete`, `review_ambiguous`,
  `transitive_risk_present`, `invalid`.
- Three ceilings are kept separate and are never aggregated: the root-skill
  verdict, the dependency-coverage verdict, and the transitive-risk verdict.
- There is no numeric trust score and no whole-skill `safe`/`unsafe` verdict
  anywhere in the contract.

## Lab Finding

The source experiment modeled retained skill records with root metadata and
path safety, dependency-evidence coverage flags (front matter, body text,
scripts, lockfiles, transitive graph traversal), declared dependencies across
the three channels, reachable dependencies after skill reuse and
package/service expansion, known security signals attached to reachable
dependencies, and content digests over each record. A producer generated 10
vectors; a clean-room reproducer re-derived every verdict from the serialized
bytes alone.

| Case family | Verdict |
| --- | --- |
| Root declares package + service deps with versions/endpoints and graph evidence | `review_complete` |
| Root package dependency lacks version and lockfile evidence | `review_incomplete` |
| Service dependency lacks endpoint evidence | `review_incomplete` |
| Dependency cluster has unversioned skill members | `review_incomplete` |
| Natural-language dependency mention is unresolved | `review_ambiguous` |
| Reused skill brings hidden package inventory | `transitive_risk_present` |
| Reused skill reaches a known malicious-skill signal | `transitive_risk_present` |
| No dependencies, with complete scan evidence | `review_complete` |
| Content digest mismatch or unsafe skill path | `invalid` |

The fixture is reviewability-only: it proves the verdict is recomputable from
retained bytes, not that any real skill is safe or malicious.

## Scope

In scope, if and when implemented:

- one carrier, `assay.skill_supply_chain.v0`, embedded in or alongside an
  evidence pack;
- verdicts over retained evidence for one skill root at one capture time;
- declared dependency metadata across the skill, package, and service channels;
- reachable-dependency expansion over declared reuse (graph traversal over
  retained records, not live resolution);
- attached security signals as source-classed evidence.

Out of scope, permanently for this contract:

- scanning registries or fetching live dependency state;
- malware detection, semantic code analysis, or behavioral analysis (scanner
  reports can appear as attached signals with their own source class; the
  contract never produces them);
- registry-wide or ecosystem-wide claims of any kind;
- a numeric trust score, weighted aggregate, or any single whole-skill verdict;
- runtime behavior claims (effect-layer evidence is a different contract);
- reimplementing SkillDepAnalyzer or reproducing the arXiv corpus results.

## Proposed Contract

### Inputs

A retained skill record containing:

- **Root identity:** skill name, root path (path-safety checked), content
  digest per file and over the record (JCS-canonicalized JSON, SHA-256).
  Optionally a reverse-DNS extension identifier plus version, matching the
  extension-identity direction of the MCP 2026-07-28 specification line, so the
  carrier survives the move from path-identified to registry-identified skills.
- **Coverage flags:** one flag per evidence source — front matter, body text,
  scripts, lockfiles, transitive traversal — each `present`, `not_present`, or
  `not_applicable`. A producer that did not retain an evidence source MUST say
  `not_present`; silence is not permitted.
- **Declared dependencies:** per channel (skill / package / service), each with
  the strongest identity the evidence supports: version + lockfile ref for
  packages, endpoint for services, name + version (or digest) for skills.
- **Reachable dependencies:** the closure after expanding declared skill reuse
  and package/service declarations over retained records, each entry marked
  with the channel and the declaring parent.
- **Attached signals:** zero or more security signals bound to reachable
  dependencies, each with a `source_class` (for example `declared_metadata`,
  `lockfile`, `registry_scanner_report`, `manual_review`) and, for
  absence-style statements, a machine-readable justification in the spirit of
  the OpenVEX `not_affected` rule (a bare absence statement is not accepted).

### Output

An `assay.skill_supply_chain.v0` carrier with:

- the three verdicts (root-skill, dependency-coverage, transitive-risk), each
  from its own vocabulary, never aggregated;
- a per-channel coverage summary naming exactly which evidence was missing or
  unresolved (reason codes below);
- the reachable-dependency summary with per-entry provenance;
- attached signals passed through unchanged with their source class;
- an explicit `non_claims` block (see Ceilings);
- a content digest over the carrier (JCS, SHA-256) so the verdict is
  recomputable and tamper-evident.

### State Rules

Worst-wins precedence, evaluated in this order:

1. `invalid` — digest mismatch, unsafe skill path, or malformed record.
   Review semantics do not apply to an artifact that fails its own integrity.
2. `transitive_risk_present` — a reachable dependency adds hidden inventory or
   carries a known risk signal. This is an occurrence-type finding: it reports
   at any coverage level, because partial evidence can establish presence.
3. `review_incomplete` — a declared dependency lacks the evidence its channel
   requires (version/lockfile for packages, endpoint for services, versioned
   identity for skill members).
4. `review_ambiguous` — dependency evidence exists but cannot be resolved to
   an identity (for example an unstructured natural-language mention).
5. `review_complete` — every declared dependency has channel-appropriate
   evidence and the transitive traversal flag is `present`.

The absence rule is stricter than the occurrence rule: a "no reachable
security signal" statement is an absence claim. It requires `review_complete`
coverage, a source class that can carry absence for the reviewed boundary, and
a justification on the attached signal. Occurrence never requires
completeness; absence always does.

### Source Class x Channel Authority

A signal's source class caps what it can support, per channel:

| Source class | Can support | Cannot support |
| --- | --- | --- |
| `declared_metadata` | what the skill says about itself | that the declaration is accurate |
| `lockfile` | pinned package identity at capture time | service or skill-channel state |
| `registry_scanner_report` | occurrence findings the scanner reports | absence of anything outside its scan scope |
| `manual_review` | what the named reviewer examined | anything outside the reviewed boundary |

Attestation over a signal (signatures, digests) raises integrity, not
authority: a signed scanner report is still a scanner-scoped occurrence source.

## Reason Classes

The reason vocabulary is closed and validated up front. A reason outside this
list makes the record `invalid` rather than being carried as free text:

- `missing_package_version`
- `missing_lockfile_evidence`
- `missing_service_endpoint`
- `unversioned_cluster_member`
- `unresolved_text_dependency`
- `hidden_package_inventory`
- `known_risk_signal_reachable`
- `digest_mismatch`
- `unsafe_skill_path`
- `traversal_not_retained`

Consumers MUST reject unknown reason codes instead of reinterpreting them.
Diagnostic-style reasons can never be relabelled as risk findings, and risk
findings can never be silently dropped for coverage reasons.

## Ceilings

The carrier's `non_claims` block states, at minimum:

- verdicts cover retained evidence for one skill root at one capture time,
  nothing wider;
- `review_complete` means the retained evidence is sufficient at the reviewed
  boundary, not that the skill is safe;
- `transitive_risk_present` means a reachable dependency carries a named
  signal, not that the skill is malicious;
- absence of `transitive_risk_present` is not an absence-of-risk claim unless
  the absence rule above is satisfied, and then only for the reviewed boundary;
- no statement is made about registry state, other skills, other versions, or
  runtime behavior.

## Build Gate Acceptance

Un-holding the producer requires, beyond the Build Gate conditions:

1. fixture parity: the producer reproduces all lab vector families byte-stably
   under the pinned canonicalization;
2. the Plimsoll consumer accepts the carrier with zero vocabulary drift (its
   pinned verdicts and reason codes are byte-identical to this document);
3. coverage honesty proven on a real input: at least one capture over this
   repository's own skill/config artifacts where missing evidence reports
   `not_present` and the verdict degrades accordingly;
4. no changes to existing exit codes, pack digests, or verify semantics
   without a separate decision;
5. the sanitizer and existing CI gates stay green.

## Implementation Shelf

Ready when the gate opens, in this order:

1. carrier schema + validation (mirrors the existing carrier verb pattern);
2. Plimsoll consumer wire-up against fixture carriers;
3. producer capture for the skill channel (front matter, body, scripts);
4. package/service channel capture, reusing existing provenance verification
   surfaces where they exist rather than duplicating them;
5. evidence-pack embedding + projection (descriptive, non-gating first).

Deliberately not on the shelf: registry scanning, scanner adapters, CycloneDX
export, and any benchmark axis. Each of those is a separate decision with its
own gate.

## Sources

- Skills Are Not Islands: Performing Dependency Analysis and Governance for
  Agent Skill Supply Chains — arXiv:2607.01136
- OpenVEX specification, `not_affected` status justification requirement —
  github.com/openvex/spec
- CISA, Vulnerability Exploitability eXchange Status Justifications (2022) —
  cisa.gov
- Model Context Protocol 2026-07-28 release candidate (extension identity and
  versioning direction) — blog.modelcontextprotocol.io
- Public skill-registry incident reporting, February–June 2026 (Snyk
  "ToxicSkills"; Palo Alto Networks Unit 42 OpenClaw supply-chain analysis)
