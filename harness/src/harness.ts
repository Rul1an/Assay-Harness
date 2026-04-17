/**
 * Harness orchestrator — the core runtime loop.
 *
 * Coordinates: agent run → policy gate → approval flow → resume → evidence.
 * Captures bounded artifacts at each decision point.
 *
 * Does NOT capture: raw RunState, full transcript, session state.
 */

import { run, RunState } from "@openai/agents";
import type { Agent } from "@openai/agents";
import { randomBytes } from "node:crypto";
import {
  EvidenceCompiler,
  hashArguments,
  computeResumeStateRef,
  type ApprovalInterruptionArtifact,
  type ApprovalInterruption,
  type DeniedActionArtifact,
  type ResumedRunArtifact,
} from "./evidence.js";
import { PolicyEngine, type PolicyDecisionResult } from "./policy.js";

/** Tracks which resume_state_refs have been consumed (exact-once guard). */
const consumedResumeRefs = new Set<string>();

export interface HarnessConfig {
  agent: Agent;
  policy: PolicyEngine;
  runId: string;
  gitRef?: string;
  /** Auto-approve all approval-required tools (for testing) */
  autoApprove?: boolean;
  /** Auto-deny all approval-required tools (for testing) */
  autoDeny?: boolean;
}

export interface HarnessResult {
  evidence: EvidenceCompiler;
  finalOutput: string | null;
  interrupted: boolean;
  denied: string[];
  approved: string[];
  rejected: string[];
}

/**
 * Run the harness: execute the agent, enforce policy, capture evidence.
 */
export async function runHarness(
  config: HarnessConfig,
  input: string
): Promise<HarnessResult> {
  const { agent, policy, runId, gitRef, autoApprove, autoDeny } = config;
  const evidence = new EvidenceCompiler(runId, gitRef ?? "local");

  const denied: string[] = [];
  const approved: string[] = [];
  const rejected: string[] = [];

  // Run the agent
  let result: any;
  try {
    result = await run(agent, input);
  } catch (err) {
    // Emit a process summary even on failure
    evidence.emitProcessSummary();
    throw err;
  }

  // Check for interruptions (approval-required tools)
  const state = result.state;
  const interruptions = state.getInterruptions();

  if (interruptions.length === 0) {
    // No approvals needed — check policy for each tool call in new items
    for (const item of result.newItems) {
      if (item.type === "tool_call_item") {
        const toolName = (item as any).rawItem?.name ?? "unknown";
        const policyResult = policy.evaluateTool(toolName);
        evidence.emitPolicyDecision(policyResult);

        if (policyResult.decision === "deny") {
          denied.push(toolName);
          evidence.emitDeniedAction({
            decision: "deny",
            action_kind: policyResult.action_kind,
            target_ref: policyResult.target_ref,
            policy_id: policyResult.policy_id,
            rule_ref: policyResult.rule_ref,
            timestamp: policyResult.timestamp,
          });
        }
      }
    }

    evidence.emitProcessSummary();
    return {
      evidence,
      finalOutput: result.finalOutput,
      interrupted: false,
      denied,
      approved,
      rejected,
    };
  }

  // --- Approval flow ---

  // Build bounded interruption artifacts.
  //
  // Per SDK guidance (openai/openai-agents-js#1177): prefer the stable public
  // accessors `item.name` and `item.arguments` over reaching into `rawItem`.
  // There is no normalized public call-id accessor across all approval item
  // variants yet, so we fall back to `rawItem.call_id ?? rawItem.id`.
  const boundedInterruptions: ApprovalInterruption[] = interruptions.map(
    (item: any) => {
      const rawArgs = item.arguments ?? item.rawItem?.arguments;
      const parsedArgs =
        typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs ?? {};
      return {
        tool_name: item.name ?? item.rawItem?.name ?? "unknown",
        tool_call_id:
          item.rawItem?.call_id ?? item.rawItem?.id ?? "unknown",
        arguments_hash: hashArguments(parsedArgs),
      };
    }
  );

  // Serialize state for resume anchor (Assay-derived, not raw)
  const serializedState = state.toString();
  const resumeStateRef = computeResumeStateRef(serializedState);

  // Emit policy decisions for each interrupted tool
  for (const interruption of boundedInterruptions) {
    const policyResult = policy.evaluateTool(interruption.tool_name);
    evidence.emitPolicyDecision(policyResult);
  }

  // Generate resume nonce for binding approval decision to this specific pause
  const resumeNonce = randomBytes(16).toString("hex");

  // Emit approval interruption artifact with policy snapshot hash
  const approvalArtifact: ApprovalInterruptionArtifact = {
    schema: "assay.harness.approval-interruption.v1",
    framework: "openai_agents_sdk",
    surface: "tool_approval",
    pause_reason: "tool_approval",
    interruptions: boundedInterruptions,
    resume_state_ref: resumeStateRef,
    policy_snapshot_hash: policy.snapshotHash,
    resume_nonce: resumeNonce,
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
    active_agent_ref: agent.name,
  };
  const approvalEvent = evidence.emitApprovalInterruption(approvalArtifact);
  const approvalArtifactHash = approvalEvent.assaycontenthash;

  // Exact-once resume guard: prevent double resume
  if (consumedResumeRefs.has(resumeStateRef)) {
    throw new Error(
      `Resume rejected: resume_state_ref ${resumeStateRef} has already been consumed (exact-once guard)`
    );
  }
  consumedResumeRefs.add(resumeStateRef);

  // Decide: approve or reject
  if (autoDeny) {
    // Reject all
    for (const interruption of boundedInterruptions) {
      rejected.push(interruption.tool_name);
      state.reject(interruption.tool_call_id);
    }

    evidence.emitResumedRun({
      resume_state_ref: resumeStateRef,
      resumed_at: new Date().toISOString().replace("+00:00", "Z"),
      resume_decision: "rejected",
      resume_decision_ref: `${runId}:rejected`,
      policy_snapshot_hash: policy.snapshotHash,
      resume_nonce: resumeNonce,
      resumed_from_artifact_hash: approvalArtifactHash,
      active_agent_ref: agent.name,
    });
  } else if (autoApprove || autoApprove === undefined) {
    // Approve all (default for MVP testing)
    for (const interruption of boundedInterruptions) {
      approved.push(interruption.tool_name);
      state.approve(interruption.tool_call_id);
    }

    // Resume from the same state
    const resumedResult = await run(agent, state);

    evidence.emitResumedRun({
      resume_state_ref: resumeStateRef,
      resumed_at: new Date().toISOString().replace("+00:00", "Z"),
      resume_decision: "approved",
      resume_decision_ref: `${runId}:approved`,
      policy_snapshot_hash: policy.snapshotHash,
      resume_nonce: resumeNonce,
      resumed_from_artifact_hash: approvalArtifactHash,
      active_agent_ref: agent.name,
    });

    evidence.emitProcessSummary();
    return {
      evidence,
      finalOutput: resumedResult.finalOutput ?? null,
      interrupted: true,
      denied,
      approved,
      rejected,
    };
  }

  evidence.emitProcessSummary();
  return {
    evidence,
    finalOutput: null,
    interrupted: true,
    denied,
    approved,
    rejected,
  };
}
