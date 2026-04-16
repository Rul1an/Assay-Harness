/**
 * Deterministic policy engine for the Assay Harness.
 *
 * Reads a YAML policy file and evaluates tool calls against allow/deny/require_approval
 * rules. Policy decisions use only: tool name, tool category, target kind.
 * No transcript, model reasoning, or volatile state.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

export type PolicyDecision = "allow" | "deny" | "require_approval";

export interface PolicyRule {
  pattern: string;
  decision: PolicyDecision;
}

export interface PolicyConfig {
  version: string;
  name: string;
  description?: string;
  tools: {
    allow: string[];
    deny: string[];
    require_approval: string[];
  };
  mcp?: {
    allow: string[];
    deny: string[];
    require_approval: string[];
  };
}

export interface PolicyDecisionResult {
  decision: PolicyDecision;
  policy_id: string;
  action_kind: "tool_call" | "mcp_call";
  target_ref: string;
  rule_ref: string | null;
  timestamp: string;
}

/**
 * Match a tool name against a pattern. Supports:
 * - exact match: "read_file"
 * - wildcard suffix: "*.readonly"
 * - wildcard prefix: "mcp.*"
 */
function matchPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.startsWith("*.")) {
    return toolName.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith(".*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );
    return regex.test(toolName);
  }
  return false;
}

export class PolicyEngine {
  readonly config: PolicyConfig;
  readonly policyId: string;
  readonly snapshotHash: string;

  constructor(config: PolicyConfig, rawYaml?: string) {
    this.config = config;
    this.policyId = `${config.name}@${config.version}`;
    // Compute deterministic snapshot hash from canonical config representation
    const hashInput = rawYaml ?? JSON.stringify(config, Object.keys(config).sort());
    this.snapshotHash = "sha256:" + createHash("sha256").update(hashInput, "utf-8").digest("hex");
  }

  static fromFile(path: string): PolicyEngine {
    const raw = readFileSync(path, "utf-8");
    const config = yaml.load(raw) as PolicyConfig;
    if (!config.version || !config.name || !config.tools) {
      throw new Error(`Invalid policy file: missing required fields in ${path}`);
    }
    return new PolicyEngine(config, raw);
  }

  /**
   * Evaluate a tool call against the policy. Order: deny > require_approval > allow.
   * If no rule matches, default is deny (closed-by-default).
   */
  evaluateTool(toolName: string): PolicyDecisionResult {
    const now = new Date().toISOString().replace("+00:00", "Z");

    // Check deny first (highest priority)
    for (const pattern of this.config.tools.deny) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "deny",
          policy_id: this.policyId,
          action_kind: "tool_call",
          target_ref: toolName,
          rule_ref: `deny:${pattern}`,
          timestamp: now,
        };
      }
    }

    // Check require_approval
    for (const pattern of this.config.tools.require_approval) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "require_approval",
          policy_id: this.policyId,
          action_kind: "tool_call",
          target_ref: toolName,
          rule_ref: `require_approval:${pattern}`,
          timestamp: now,
        };
      }
    }

    // Check allow
    for (const pattern of this.config.tools.allow) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "allow",
          policy_id: this.policyId,
          action_kind: "tool_call",
          target_ref: toolName,
          rule_ref: `allow:${pattern}`,
          timestamp: now,
        };
      }
    }

    // Default: deny (closed-by-default)
    return {
      decision: "deny",
      policy_id: this.policyId,
      action_kind: "tool_call",
      target_ref: toolName,
      rule_ref: null,
      timestamp: now,
    };
  }

  /**
   * Evaluate an MCP tool call against the MCP policy section.
   */
  evaluateMcp(toolName: string): PolicyDecisionResult {
    const now = new Date().toISOString().replace("+00:00", "Z");
    const mcpRules = this.config.mcp;

    if (!mcpRules) {
      return {
        decision: "deny",
        policy_id: this.policyId,
        action_kind: "mcp_call",
        target_ref: toolName,
        rule_ref: null,
        timestamp: now,
      };
    }

    for (const pattern of mcpRules.deny ?? []) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "deny",
          policy_id: this.policyId,
          action_kind: "mcp_call",
          target_ref: toolName,
          rule_ref: `mcp.deny:${pattern}`,
          timestamp: now,
        };
      }
    }

    for (const pattern of mcpRules.require_approval ?? []) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "require_approval",
          policy_id: this.policyId,
          action_kind: "mcp_call",
          target_ref: toolName,
          rule_ref: `mcp.require_approval:${pattern}`,
          timestamp: now,
        };
      }
    }

    for (const pattern of mcpRules.allow ?? []) {
      if (matchPattern(toolName, pattern)) {
        return {
          decision: "allow",
          policy_id: this.policyId,
          action_kind: "mcp_call",
          target_ref: toolName,
          rule_ref: `mcp.allow:${pattern}`,
          timestamp: now,
        };
      }
    }

    return {
      decision: "deny",
      policy_id: this.policyId,
      action_kind: "mcp_call",
      target_ref: toolName,
      rule_ref: null,
      timestamp: now,
    };
  }
}
