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
import { z } from "zod";

export type PolicyDecision = "allow" | "deny" | "require_approval";

// Runtime schema for the on-disk policy.yaml. yaml.load returns `unknown`-shaped
// data so a `as PolicyConfig` cast alone is unsafe: a malformed YAML file would
// flow into `evaluateTool` and only fail at the .deny array iteration. Zod
// validates the structure at load time and produces a precise error path.
const PolicySectionSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  require_approval: z.array(z.string()).default([]),
});

const PolicyConfigSchema = z.object({
  version: z.string().min(1, "version must be a non-empty string"),
  name: z.string().min(1, "name must be a non-empty string"),
  description: z.string().optional(),
  tools: PolicySectionSchema,
  mcp: PolicySectionSchema.optional(),
});

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
 * Convert a glob-style policy pattern into an anchored RegExp.
 *
 * Escapes every regex metacharacter in the source pattern, then re-introduces
 * the asterisk as a `.*` wildcard. This matters because a policy author who
 * writes a literal `[`, `(`, `?`, `{`, `|`, etc. in a tool name expects it to
 * match that literal character, not act as regex syntax. Without full
 * escaping, `tool(name)?` becomes `/^tool(name)?$/` and the `?` makes the
 * group optional — surprising the policy author and potentially matching
 * tool names they intended to reject.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Re-introduce the asterisk as a wildcard now that all metacharacters,
  // including the asterisk itself, have been neutralised.
  const withGlob = escaped.replace(/\\\*/g, ".*");
  return new RegExp("^" + withGlob + "$");
}

/**
 * Match a tool name against a pattern. Supports:
 * - exact match: "read_file"
 * - wildcard suffix: "*.readonly"        (string endsWith — no regex)
 * - wildcard prefix: "mcp.*"             (string startsWith — no regex)
 * - mid-pattern wildcard: "tool.*.read"  (regex, with full escaping)
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
    return globToRegex(pattern).test(toolName);
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
    const parsed = yaml.load(raw);
    const result = PolicyConfigSchema.safeParse(parsed);
    if (!result.success) {
      // zod includes the exact field path; surface it so a policy author can
      // see where their YAML drifted from the schema instead of getting a
      // generic "missing required fields" message.
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid policy file ${path}: ${issues}`);
    }
    return new PolicyEngine(result.data, raw);
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
