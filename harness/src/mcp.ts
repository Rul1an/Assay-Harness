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

import { Agent, MCPServerStdio, MCPServerStreamableHttp } from "@openai/agents";
import { PolicyEngine, type PolicyDecisionResult } from "./policy.js";
import {
  EvidenceCompiler,
  hashArguments,
  type AssayEvidenceEvent,
} from "./evidence.js";

export interface McpInteractionArtifact {
  server_ref: string;
  tool_name: string;
  decision: string;
  timestamp: string;
  approval_ref?: string;
  call_id_ref?: string;
  argument_hash?: string;
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
 */
export function createMcpServer(config: {
  name: string;
  command: string;
  args: string[];
}): MCPServerStdio {
  return new MCPServerStdio({
    name: config.name,
    fullCommand: `${config.command} ${config.args.join(" ")}`,
  });
}

/**
 * Evaluate an MCP tool call against policy and emit evidence.
 */
export function evaluateMcpCall(
  config: McpLaneConfig,
  toolName: string,
  args?: Record<string, unknown>
): { policyResult: PolicyDecisionResult; evidenceEvent: AssayEvidenceEvent } {
  const policyResult = config.policy.evaluateMcp(toolName);

  // Emit policy decision
  config.evidence.emitPolicyDecision(policyResult);

  // Build MCP interaction artifact
  const mcpArtifact: McpInteractionArtifact = {
    server_ref: config.serverRef,
    tool_name: toolName,
    decision: policyResult.decision,
    timestamp: policyResult.timestamp,
  };

  if (args) {
    mcpArtifact.argument_hash = hashArguments(args);
  }

  // Emit as evidence event
  const evidenceEvent = config.evidence.events[config.evidence.events.length - 1];

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
