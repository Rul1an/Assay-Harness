/**
 * MCP lane for the Assay Harness.
 *
 * Integrates MCP tools via the OpenAI Agents SDK's built-in MCP support.
 * Policy decisions for MCP tools follow the same allow/deny/require_approval
 * model as regular tools, using the mcp section of the policy file.
 *
 * Evidence artifacts for MCP interactions are bounded:
 * - server_ref (which server)
 * - tool_name (which tool)
 * - decision (allow/deny/require_approval)
 * - argument_hash (content-addressed, not raw args)
 *
 * NOT captured: full MCP payloads, server state, transport details.
 */

import { Agent, MCPServerStdio } from "@openai/agents";
import { PolicyEngine, type PolicyDecisionResult } from "./policy.js";
import {
  EvidenceCompiler,
  hashArguments,
  type AssayEvidenceEvent,
  type McpInteractionArtifact,
} from "./evidence.js";

// Re-export so existing consumers of `mcp.ts` keep the same import surface
// after the artifact type moved to evidence.ts (single source of truth for
// the artifact shape).
export type { McpInteractionArtifact };

/**
 * Characters that would be interpreted by a shell if `command` or any element
 * of `args` is passed to the MCP server as a concatenated `fullCommand`. The
 * OpenAI Agents SDK's `MCPServerStdio` accepts only `fullCommand` (a single
 * string), so we cannot use the safer argv-array form. Until the SDK exposes
 * argv, we reject any input that could change the shape of the resulting
 * command line.
 */
const SHELL_METACHAR = /[\s;&|`$<>()*?#"'\\!{}\[\]]/;

function validateCommandPart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: must be a non-empty string`);
  }
  if (SHELL_METACHAR.test(value)) {
    throw new Error(
      `${label}: contains shell metacharacters and cannot be safely concatenated into fullCommand (${JSON.stringify(value)})`,
    );
  }
  return value;
}

export interface McpLaneConfig {
  /** Display name for the MCP server */
  serverRef: string;
  /** Command to start the MCP server (stdio transport) */
  command: string;
  /** Arguments for the MCP server command */
  args: string[];
  /** Policy engine for MCP tool evaluation */
  policy: PolicyEngine;
  /** Evidence compiler for this run */
  evidence: EvidenceCompiler;
}

/**
 * Create an MCP server connection via stdio transport.
 * This wraps the Agents SDK's MCPServerStdio.
 *
 * Hardening: `command` and every element of `args` are validated against a
 * shell-metacharacter denylist before being concatenated into `fullCommand`.
 * The SDK only accepts a single `fullCommand` string, so without this check
 * a caller could inject pipes/redirects/etc. by smuggling them through `args`.
 */
export function createMcpServer(config: {
  name: string;
  command: string;
  args: string[];
}): MCPServerStdio {
  validateCommandPart(config.command, "createMcpServer: command");
  if (!Array.isArray(config.args)) {
    throw new Error("createMcpServer: args must be an array of strings");
  }
  config.args.forEach((arg, i) =>
    validateCommandPart(arg, `createMcpServer: args[${i}]`),
  );
  return new MCPServerStdio({
    name: config.name,
    fullCommand: `${config.command} ${config.args.join(" ")}`,
  });
}

/**
 * Evaluate an MCP tool call against policy and emit evidence.
 *
 * Emits two events to the run's evidence stream, in order:
 *   1. `assay.harness.policy-decision` — the general policy verdict
 *   2. `assay.harness.mcp-interaction` — the MCP-specific context
 *      (server_ref, tool_name, decision, content-hashed args)
 *
 * Returns both the policy result and the *MCP* event (not the policy event).
 * The audit at commit c2c869c noted that this function previously built an
 * `mcpArtifact` and never emitted it, so the MCP-specific evidence was lost.
 * This fixes that gap.
 */
export function evaluateMcpCall(
  config: McpLaneConfig,
  toolName: string,
  args?: Record<string, unknown>,
  callIdRef?: string,
): { policyResult: PolicyDecisionResult; evidenceEvent: AssayEvidenceEvent } {
  const policyResult = config.policy.evaluateMcp(toolName);

  // Emit the policy decision event first so downstream readers see decision
  // context before the MCP-specific event.
  config.evidence.emitPolicyDecision(policyResult);

  const mcpArtifact: McpInteractionArtifact = {
    server_ref: config.serverRef,
    tool_name: toolName,
    decision: policyResult.decision,
    timestamp: policyResult.timestamp,
  };

  if (args) {
    mcpArtifact.argument_hash = hashArguments(args);
  }
  if (callIdRef) {
    mcpArtifact.call_id_ref = callIdRef;
  }
  if (policyResult.decision === "require_approval") {
    // Approval-required calls carry an approval anchor so a downstream resume
    // event can be paired with the original interaction.
    mcpArtifact.approval_ref = `${policyResult.policy_id}:${toolName}:${policyResult.timestamp}`;
  }

  const evidenceEvent = config.evidence.emitMcpInteraction(mcpArtifact);

  return { policyResult, evidenceEvent };
}

/**
 * Create an agent configured with MCP tools from a server.
 * The Agents SDK handles MCP tool discovery and invocation.
 */
export function createMcpAgent(
  name: string,
  instructions: string,
  mcpServers: MCPServerStdio[]
): Agent {
  return new Agent({
    name,
    instructions,
    mcpServers,
  });
}

/**
 * MCP fixture artifact for evidence corpus testing.
 */
export interface McpFixtureArtifact {
  schema: string;
  framework: string;
  surface: string;
  server_ref: string;
  interactions: McpInteractionArtifact[];
  timestamp: string;
}

export function buildMcpFixture(
  serverRef: string,
  interactions: McpInteractionArtifact[]
): McpFixtureArtifact {
  return {
    schema: "assay.harness.mcp-interaction.v1",
    framework: "openai_agents_sdk",
    surface: "mcp_tool_call",
    server_ref: serverRef,
    interactions,
    timestamp: new Date().toISOString().replace("+00:00", "Z"),
  };
}
