/**
 * Evidence capture and compilation for the Assay Harness.
 *
 * Produces bounded, reviewable evidence artifacts following Assay conventions:
 * - CloudEvents-style envelope
 * - Content-addressed hashing (SHA-256)
 * - NDJSON output
 *
 * Does NOT capture: raw RunState, full transcript, session state, newItems.
 */

import { createHash } from "node:crypto";
import type { PolicyDecisionResult } from "./policy.js";

// --- Types ---

export interface ApprovalInterruption {
  tool_name: string;
  tool_call_id: string;
  arguments_hash: string;
}

export interface ApprovalInterruptionArtifact {
  schema: string;
  framework: string;
  surface: string;
  pause_reason: "tool_approval";
  interruptions: ApprovalInterruption[];
  resume_state_ref: string;
  policy_snapshot_hash: string;
  resume_nonce: string;
  timestamp: string;
  active_agent_ref?: string;
  metadata_ref?: string;
}

export interface PolicyDecisionArtifact {
  decision: string;
  policy_id: string;
  action_kind: string;
  target_ref: string;
  rule_ref: string | null;
  timestamp: string;
  approval_required?: boolean;
  reason_code?: string;
}

export interface DeniedActionArtifact {
  decision: "deny";
  action_kind: string;
  target_ref: string;
  policy_id: string;
  rule_ref: string | null;
  timestamp: string;
}

export interface ResumedRunArtifact {
  resume_state_ref: string;
  resumed_at: string;
  resume_decision: "approved" | "rejected";
  resume_decision_ref: string;
  policy_snapshot_hash: string;
  resume_nonce: string;
  resumed_from_artifact_hash?: string;
  active_agent_ref?: string;
}

export interface ProcessEvidencePack {
  approval_count: number;
  denied_action_count: number;
  resume_count: number;
  allowed_action_count: number;
  total_tool_calls: number;
  timestamp: string;
}

// --- Evidence envelope (CloudEvents-style, following Assay conventions) ---

export interface AssayEvidenceEvent {
  specversion: "1.0";
  type: string;
  source: string;
  id: string;
  time: string;
  datacontenttype: "application/json";
  assayrunid: string;
  assayseq: number;
  assayproducer: string;
  assayproducerversion: string;
  assaygit: string;
  assaypii: boolean;
  assaysecrets: boolean;
  assaycontenthash: string;
  data: Record<string, unknown>;
}

// --- Constants ---

const PRODUCER = "assay-harness";
const PRODUCER_VERSION = "0.1.0";
const SOURCE_PREFIX = "urn:assay:harness";

// --- Hashing ---

function sha256(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf-8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(sortedStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k]));
  return "{" + pairs.join(",") + "}";
}

function computeContentHash(data: Record<string, unknown>, eventType: string): string {
  const hashInput = {
    specversion: "1.0",
    type: eventType,
    datacontenttype: "application/json",
    data,
  };
  return sha256(sortedStringify(hashInput));
}

/**
 * Compute a bounded hash of tool arguments.
 * Only hashes the serialized argument keys+values, not raw SDK internals.
 */
export function hashArguments(args: Record<string, unknown>): string {
  return sha256(sortedStringify(args));
}

/**
 * Compute a resume_state_ref from serialized RunState.
 * This is Assay-derived — a content hash of the serialized state,
 * NOT the raw state itself.
 */
export function computeResumeStateRef(serializedState: string): string {
  return sha256(serializedState);
}

// --- Evidence compiler ---

export class EvidenceCompiler {
  private runId: string;
  private seq: number = 0;
  private gitRef: string;
  public events: AssayEvidenceEvent[] = [];

  // Process counters
  private approvalCount = 0;
  private deniedCount = 0;
  private resumeCount = 0;
  private allowedCount = 0;
  private totalToolCalls = 0;

  constructor(runId: string, gitRef: string = "local") {
    this.runId = runId;
    this.gitRef = gitRef;
  }

  private emit(eventType: string, data: Record<string, unknown>): AssayEvidenceEvent {
    const seqNum = this.seq++;
    const event: AssayEvidenceEvent = {
      specversion: "1.0",
      type: eventType,
      source: `${SOURCE_PREFIX}:${eventType.split(".").pop()}`,
      id: `${this.runId}:${seqNum}`,
      time: new Date().toISOString().replace("+00:00", "Z"),
      datacontenttype: "application/json",
      assayrunid: this.runId,
      assayseq: seqNum,
      assayproducer: PRODUCER,
      assayproducerversion: PRODUCER_VERSION,
      assaygit: this.gitRef,
      assaypii: false,
      assaysecrets: false,
      assaycontenthash: computeContentHash(data, eventType),
      data,
    };
    this.events.push(event);
    return event;
  }

  emitPolicyDecision(result: PolicyDecisionResult): AssayEvidenceEvent {
    this.totalToolCalls++;
    if (result.decision === "allow") this.allowedCount++;
    if (result.decision === "deny") this.deniedCount++;
    if (result.decision === "require_approval") this.approvalCount++;

    return this.emit("assay.harness.policy-decision", {
      decision: result.decision,
      policy_id: result.policy_id,
      action_kind: result.action_kind,
      target_ref: result.target_ref,
      rule_ref: result.rule_ref,
      timestamp: result.timestamp,
      approval_required: result.decision === "require_approval",
    });
  }

  emitApprovalInterruption(artifact: ApprovalInterruptionArtifact): AssayEvidenceEvent {
    return this.emit("assay.harness.approval-interruption", artifact as unknown as Record<string, unknown>);
  }

  emitDeniedAction(artifact: DeniedActionArtifact): AssayEvidenceEvent {
    return this.emit("assay.harness.denied-action", artifact as unknown as Record<string, unknown>);
  }

  emitResumedRun(artifact: ResumedRunArtifact): AssayEvidenceEvent {
    this.resumeCount++;
    return this.emit("assay.harness.resumed-run", artifact as unknown as Record<string, unknown>);
  }

  emitProcessSummary(): AssayEvidenceEvent {
    const pack: ProcessEvidencePack = {
      approval_count: this.approvalCount,
      denied_action_count: this.deniedCount,
      resume_count: this.resumeCount,
      allowed_action_count: this.allowedCount,
      total_tool_calls: this.totalToolCalls,
      timestamp: new Date().toISOString().replace("+00:00", "Z"),
    };
    return this.emit("assay.harness.process-summary", pack as unknown as Record<string, unknown>);
  }

  toNdjson(): string {
    return this.events.map((e) => sortedStringify(e)).join("\n") + "\n";
  }

  toJson(): string {
    return JSON.stringify(this.events, null, 2);
  }
}
