/**
 * Coding-agent governance recipe — consumer-only.
 *
 * Consumes the sandbox evidence-bundle events that `assay sandbox --bundle`
 * emits (`assay.sandbox.summary` / `.fs` / `.exec` / `.degraded`) and produces a
 * report of the observed effects plus a CI gate. It reads only the published
 * event shape; it performs no capture and adds no semantics beyond summarizing
 * what was independently observed.
 *
 * Honest boundary: this reports what the sandbox observed. It does not prove
 * intent, and Landlock is not VM-level isolation (see the upstream
 * coding-agent-governance guide). A containment degradation means enforcement
 * was weakened while the run continued; that is what the gate keys on.
 */

export const SANDBOX_FS_EVENT = "assay.sandbox.fs";
export const SANDBOX_EXEC_EVENT = "assay.sandbox.exec";
export const SANDBOX_DEGRADED_EVENT = "assay.sandbox.degraded";
export const SANDBOX_SUMMARY_EVENT = "assay.sandbox.summary";

export interface SandboxEvent {
  type: string;
  subject?: string;
  // The assay bundle carries the body under `payload`; tolerate `data` too.
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface SandboxSummary {
  fs_ops: number;
  fs_by_op: Record<string, number>;
  execs: number;
  degradations: number;
  subjects: { fs: string[]; exec: string[] };
}

function carrier(event: SandboxEvent): Record<string, unknown> {
  return (event.payload ?? event.data ?? {}) as Record<string, unknown>;
}

/** Summarize the observed effects from a list of sandbox evidence events. */
export function summarizeSandbox(events: SandboxEvent[]): SandboxSummary {
  const fsByOp: Record<string, number> = {};
  const fsSubjects: string[] = [];
  const execSubjects: string[] = [];
  let fsOps = 0;
  let execs = 0;
  let degradations = 0;

  for (const event of events) {
    switch (event.type) {
      case SANDBOX_FS_EVENT: {
        fsOps += 1;
        const op = String(carrier(event).op ?? "unknown");
        fsByOp[op] = (fsByOp[op] ?? 0) + 1;
        if (event.subject) fsSubjects.push(event.subject);
        break;
      }
      case SANDBOX_EXEC_EVENT: {
        execs += 1;
        if (event.subject) execSubjects.push(event.subject);
        break;
      }
      case SANDBOX_DEGRADED_EVENT:
        degradations += 1;
        break;
      default:
        break;
    }
  }

  return {
    fs_ops: fsOps,
    fs_by_op: fsByOp,
    execs,
    degradations,
    subjects: { fs: fsSubjects, exec: execSubjects },
  };
}

export interface SandboxGateResult {
  pass: boolean;
  reason: string;
  summary: SandboxSummary;
}

/**
 * Gate: a containment degradation means enforcement was weakened while the run
 * continued, so the gate fails unless `allowDegraded` is set. Observed fs/exec
 * effects alone never fail the gate — they are the record, not a verdict.
 */
export function sandboxGate(
  events: SandboxEvent[],
  opts: { allowDegraded?: boolean } = {},
): SandboxGateResult {
  const summary = summarizeSandbox(events);
  if (summary.degradations > 0 && !opts.allowDegraded) {
    return {
      pass: false,
      reason: `containment degraded ${summary.degradations} time(s); enforcement was weakened`,
      summary,
    };
  }
  return {
    pass: true,
    reason: summary.degradations > 0 ? "degradations present but allowed" : "no containment degradation",
    summary,
  };
}

/** Render a human-readable markdown report. */
export function sandboxReportMarkdown(summary: SandboxSummary): string {
  const fsByOp = Object.entries(summary.fs_by_op)
    .map(([op, n]) => `${op}=${n}`)
    .join(", ");
  return [
    "# Coding-Agent Sandbox Report",
    "",
    `- Filesystem operations: ${summary.fs_ops}${fsByOp ? ` (${fsByOp})` : ""}`,
    `- Executed programs: ${summary.execs}`,
    `- Containment degradations: ${summary.degradations}`,
    "",
    "> Observed effects from the sandbox vantage. Not a proof of intent;",
    "> Landlock is not VM-level isolation.",
    "",
  ].join("\n");
}

/** Parse a JSON document of sandbox events (array, or `{events: [...]}`). */
export function parseSandboxEvents(raw: string): SandboxEvent[] {
  const doc = JSON.parse(raw) as unknown;
  const events = Array.isArray(doc)
    ? doc
    : ((doc as { events?: unknown }).events ?? []);
  if (!Array.isArray(events)) {
    throw new Error("sandbox events document must be an array or { events: [...] }");
  }
  return events as SandboxEvent[];
}
