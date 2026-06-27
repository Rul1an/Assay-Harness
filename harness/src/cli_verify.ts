import { existsSync, readFileSync } from "node:fs";
import { EXIT } from "./cli_exit.js";

// --- Verify checks by category ---

interface VerifyError {
  line: number;
  category: "envelope" | "hash" | "type" | "parse";
  code: string;
  message: string;
}

/**
 * Raw SDK state that must never appear in any evidence event.
 *
 * Captures the OpenAI Agents SDK RunState and adjacent conversational
 * state that would leak prompt history, model session tokens, or other
 * runtime internals into a bundle.
 */
const FORBIDDEN_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  "raw_run_state",
  "history",
  "newItems",
  "lastResponseId",
  "session",
]);

/**
 * Raw payload bodies that must stay content-addressed (`*_hash` /
 * `*_ref` fields) rather than embedded as plaintext in evidence.
 *
 * The verifier policy is symmetric to the harness emitter policy: the
 * MCP hardening tests reject these on the way in; the verifier rejects
 * them on the way out of bundle inspection. Keeps fixture-policy and
 * verifier-policy aligned.
 */
const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "raw_arguments",
  "raw_output",
  "transcript",
  "audio_blob",
  "session_recording",
  "request_payload",
  "response_payload",
  "raw_payload",
]);

/**
 * Walk an object graph and report any forbidden key found at any depth.
 *
 * Error messages include the full dotted path (`data.observed.raw_arguments`)
 * so a reviewer can locate the leak without re-parsing the bundle. Arrays
 * are descended into with bracket-index notation.
 */
function scanForbiddenKeys(
  value: unknown,
  path: string,
  lineNum: number,
  errors: VerifyError[],
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForbiddenKeys(value[i], `${path}[${i}]`, lineNum, errors);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_RUNTIME_KEYS.has(key)) {
      errors.push({
        line: lineNum,
        category: "type",
        code: "VERIFY_FORBIDDEN_RUNTIME_KEY",
        message: `forbidden runtime key "${key}" found at ${childPath} — raw SDK state must not appear in evidence`,
      });
    } else if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      errors.push({
        line: lineNum,
        category: "type",
        code: "VERIFY_FORBIDDEN_PAYLOAD_KEY",
        message: `forbidden payload key "${key}" found at ${childPath} — raw payload must stay content-addressed, not embedded`,
      });
    }
    scanForbiddenKeys(child, childPath, lineNum, errors);
  }
}

function verifyEvents(lines: string[], category: string): VerifyError[] {
  const errors: VerifyError[] = [];
  const runIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let event: any;

    try {
      event = JSON.parse(lines[i]);
    } catch {
      errors.push({
        line: lineNum,
        category: "parse",
        code: "VERIFY_PARSE",
        message: "Invalid JSON",
      });
      continue;
    }

    // Envelope checks
    if (category === "all" || category === "envelope") {
      const requiredFields = [
        "specversion", "type", "source", "id", "time",
        "datacontenttype", "assayrunid", "assayseq",
        "assayproducer", "assayproducerversion", "assaygit",
        "assaypii", "assaysecrets", "assaycontenthash", "data",
      ];

      for (const field of requiredFields) {
        if (!(field in event)) {
          errors.push({
            line: lineNum,
            category: "envelope",
            code: "VERIFY_MISSING_FIELD",
            message: `Missing required field: ${field}`,
          });
        }
      }

      if (event.specversion !== "1.0") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_SPECVERSION",
          message: `specversion must be "1.0", got "${event.specversion}"`,
        });
      }

      if (event.datacontenttype && event.datacontenttype !== "application/json") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_CONTENT_TYPE",
          message: `datacontenttype must be "application/json"`,
        });
      }

      if (event.assayrunid) {
        runIds.add(event.assayrunid);
      }

      if (typeof event.assayseq !== "number" || event.assayseq < 0) {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_SEQ",
          message: `assayseq must be a non-negative integer`,
        });
      }

      if (event.data && typeof event.data !== "object") {
        errors.push({
          line: lineNum,
          category: "envelope",
          code: "VERIFY_DATA_TYPE",
          message: `data must be an object`,
        });
      }
    }

    // Hash checks
    if (category === "all" || category === "hash") {
      if (event.assaycontenthash) {
        const hash = event.assaycontenthash;
        if (!hash.startsWith("sha256:")) {
          errors.push({
            line: lineNum,
            category: "hash",
            code: "VERIFY_HASH_PREFIX",
            message: `assaycontenthash must start with "sha256:"`,
          });
        } else {
          const hexPart = hash.slice(7);
          if (hexPart.length !== 64 || !/^[0-9a-f]+$/.test(hexPart)) {
            errors.push({
              line: lineNum,
              category: "hash",
              code: "VERIFY_HASH_FORMAT",
              message: `assaycontenthash hex part must be 64 lowercase hex characters`,
            });
          }
        }
      }
    }

    // Type-specific checks
    if (category === "all" || category === "type") {
      const type = event.type;
      if (type && !type.startsWith("assay.harness.") && !type.startsWith("example.placeholder.harness.")) {
        errors.push({
          line: lineNum,
          category: "type",
          code: "VERIFY_TYPE_PREFIX",
          message: `type must start with "assay.harness." or "example.placeholder.harness."`,
        });
      }

      // Approval interruption specific
      if (type?.endsWith("approval-interruption") && event.data) {
        const d = event.data.observed ?? event.data;
        if (d.pause_reason && d.pause_reason !== "tool_approval") {
          errors.push({
            line: lineNum,
            category: "type",
            code: "VERIFY_PAUSE_REASON",
            message: `pause_reason must be "tool_approval"`,
          });
        }
        if (d.interruptions !== undefined) {
          if (!Array.isArray(d.interruptions) || d.interruptions.length === 0) {
            errors.push({
              line: lineNum,
              category: "type",
              code: "VERIFY_INTERRUPTIONS",
              message: `interruptions must be a non-empty array`,
            });
          }
        }
        if (d.resume_state_ref && !d.resume_state_ref.startsWith("sha256:")) {
          errors.push({
            line: lineNum,
            category: "type",
            code: "VERIFY_STATE_REF",
            message: `resume_state_ref must be a sha256: hash`,
          });
        }
      }

      // Rejected content checks — recursive scan of event.data.
      //
      // Two classes of forbidden keys, each with its own error code so
      // the verifier output tells a reviewer immediately which boundary
      // was crossed:
      //
      //   FORBIDDEN_RUNTIME_KEYS: raw SDK state that must never appear
      //     in evidence (RunState, conversation history, session tokens).
      //
      //   FORBIDDEN_PAYLOAD_KEYS: raw payload bodies that must stay as
      //     content hashes only (tool arguments/outputs, transcripts,
      //     audio blobs, full request/response payloads).
      //
      // The audit at commit 31669dc found the previous check only looked
      // one level deep under `event.data`, so a nested shape such as
      // `data.observed.raw_run_state` slipped through. This scan walks
      // the full object graph and reports the precise key path.
      if (event.data && typeof event.data === "object") {
        scanForbiddenKeys(event.data, "data", lineNum, errors);
      }
    }
  }

  // Cross-event checks
  if (category === "all" || category === "envelope") {
    if (runIds.size > 1) {
      errors.push({
        line: 0,
        category: "envelope",
        code: "VERIFY_RUNID_CONSISTENCY",
        message: `Multiple assayrunid values found: ${[...runIds].join(", ")}`,
      });
    }
  }

  return errors;
}

export function cmdVerify(args: Record<string, string | boolean>): void {
  const filePath = args._file as string;
  if (!filePath || !existsSync(filePath)) {
    console.error(`[config_error] Evidence file not found: ${filePath ?? "(none)"}`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const category = (args.category as string) ?? "all";
  if (!["all", "envelope", "hash", "type"].includes(category)) {
    console.error(`[config_error] Invalid category: ${category}. Must be: all, envelope, hash, type`);
    process.exit(EXIT.CONFIG_ERROR);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);

  const errors = verifyEvents(lines, category);

  // Group errors by category
  const byCategory = new Map<string, VerifyError[]>();
  for (const err of errors) {
    const list = byCategory.get(err.category) ?? [];
    list.push(err);
    byCategory.set(err.category, list);
  }

  console.log(`[verify] ${filePath}`);
  console.log(`[verify] category: ${category}`);
  console.log(`[verify] events: ${lines.length}`);
  console.log(`[verify] errors: ${errors.length}`);

  if (byCategory.size > 0) {
    console.log();
    for (const [cat, errs] of byCategory) {
      console.log(`[verify:${cat}] ${errs.length} error(s):`);
      for (const err of errs) {
        const lineRef = err.line > 0 ? `line ${err.line}` : "cross-event";
        console.log(`  [${err.code}] ${lineRef}: ${err.message}`);
      }
    }
  }

  process.exit(errors.length > 0 ? EXIT.ARTIFACT_CONTRACT : EXIT.SUCCESS);
}
