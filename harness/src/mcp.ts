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
 * - arguments_hash (content-addressed, not raw args)
 *
 * NOT captured: full MCP payloads, server state, transport details.
 */

import { Agent, invalidateServerToolsCache, type MCPServer, type MCPCallToolOptions,
  type CallToolResult, type MCPServerWithResources } from "@openai/agents";
import { Client, DEFAULT_REQUEST_TIMEOUT_MSEC, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
 * adapter retains the existing fullCommand splitting contract. Reject inputs
 * that could change the resulting command line; changing argv admission is a
 * separate compatibility decision.
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

/** Join SDK-initiated shutdown through the public transport lifecycle. */
class JoiningStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>;
  private readonly physicalClose: Promise<void>;

  constructor(params: ConstructorParameters<typeof StdioClientTransport>[0]) {
    super(params);
    // Client.connect preserves this callback when attaching its own onclose.
    this.physicalClose = new Promise(resolve => { this.onclose = resolve; });
  }

  override close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    const hadChild = this.pid !== null;
    await super.close();
    // The public implementation can finish its SIGKILL path before the child
    // close event; returning from our close always joins the actual event.
    if (hadChild) await this.physicalClose;
  }
}

/**
 * Operator-declared stdio servers retain the legacy initialize handshake: one
 * physical startup per connect, without the Agents 0.17 auto-negotiation probe.
 * This does not add support for modern-era negotiation. Each reconnect creates
 * a fresh client; no list cache crosses sessions.
 */
class SingleStartMcpServer implements MCPServerWithResources {
  readonly cacheToolsList = false;
  private client?: Client;
  private initialized = false;
  private connecting = false;
  private closing?: Promise<void>;
  private listingGeneration = 0;
  private transport?: StdioClientTransport;
  private tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  constructor(readonly name: string, private readonly fullCommand: string) {}

  async connect(): Promise<void> {
    // Acquire before the first await: a second caller must not replace the
    // transport owned by an initialization that has not settled yet.
    if (this.connecting) throw new Error("MCP connect already in progress.");
    this.connecting = true;
    try { await this.connectOnce(); }
    finally { this.connecting = false; }
  }

  private async connectOnce(): Promise<void> {
    await this.close();
    // Keep the established fullCommand splitting and validation contract.
    const [command, ...args] = this.fullCommand.split(" ");
    const transport = new JoiningStdioTransport({command, args});
    const client = new Client({name: this.name, version: "1.0.0"}, {
      versionNegotiation: {mode: "legacy"}, listMaxPages: 0,
    });
    this.transport = transport;
    this.client = client;
    try {
      await client.connect(transport, {timeout: 5000});
      if (client !== this.client) throw new Error("MCP session changed during initialization.");
      this.initialized = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private connected(): Client {
    if (!this.client || !this.initialized) throw new Error("Server not initialized. Make sure you call connect() first.");
    return this.client;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.closeSession().finally(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    return closing;
  }

  private async closeSession(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.transport = undefined;
    this.client = undefined;
    this.initialized = false;
    await this.invalidateToolsCache();
    try { await transport?.close(); }
    finally { await client?.close(); }
  }

  async invalidateToolsCache(): Promise<void> {
    this.listingGeneration++;
    this.tools = [];
    await invalidateServerToolsCache(this.name);
  }

  async listTools(): Promise<Awaited<ReturnType<MCPServer["listTools"]>>> {
    const client = this.connected();
    const generation = this.listingGeneration;
    const tools: typeof this.tools = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    // Client.listTools aggregates but silently terminates a repeated cursor.
    // Use its validated public per-request API to preserve Agents' refusal.
    while (true) {
      let page;
      try {
        page = await client.request({method: "tools/list",
          ...(cursor === undefined ? {} : {params: {cursor}})}, {timeout: 5000});
      } catch (error) {
        if (cursor === undefined) throw error;
        throw new Error("MCP tool listing failed while fetching a continuation page.");
      }
      tools.push(...page.tools);
      if (page.nextCursor === undefined) break;
      if (seen.has(page.nextCursor)) throw new Error("MCP server returned a repeated cursor while listing tools.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (client !== this.client || generation !== this.listingGeneration) throw new Error("MCP session changed while listing tools.");
    this.tools = tools;
    // The Agents public minimum-tool type overstates optional schema keys;
    // preserve the validated wire schema (as its stdio shim does), and isolate
    // caller mutation from the definitions used for output validation.
    return structuredClone(tools) as unknown as Awaited<ReturnType<MCPServer["listTools"]>>;
  }

  async callToolResult(name: string, args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null, options?: MCPCallToolOptions): Promise<CallToolResult> {
    const toolDefinition = this.tools.find(tool => tool.name === name);
    // The Agents integration uses ordinary tools/call, not the task protocol.
    if (toolDefinition?.execution?.taskSupport === "required") {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest,
        `Tool "${name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`);
    }
    // The public client validates structured output against the listed tool.
    const result = await this.connected().callTool({name, arguments: args ?? {},
      ...(meta == null ? {} : {_meta: meta})}, {
      timeout: DEFAULT_REQUEST_TIMEOUT_MSEC, signal: options?.signal,
      toolDefinition,
    });
    // Agents' interface is narrower than the client's JSON result type; keep
    // the validated result bytes/fields rather than projecting away metadata.
    return result as CallToolResult;
  }

  async callTool(name: string, args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null, options?: MCPCallToolOptions) {
    const result = await this.callToolResult(name, args, meta, options);
    // Preserve the Agents content-array compatibility surface, including
    // non-enumerable metadata, while callToolResult retains the full object.
    for (const key of ["_meta", "structuredContent", "isError"] as const) {
      if (result[key] !== undefined) Object.defineProperty(result.content, key, {
        value: result[key], enumerable: false, configurable: true,
      });
    }
    return result.content;
  }

  async listResources(params?: Parameters<MCPServerWithResources["listResources"]>[0]) {
    return this.connected().request({method: "resources/list", ...(params === undefined ? {} : {params})}, {timeout: 5000});
  }
  async listResourceTemplates(params?: Parameters<MCPServerWithResources["listResourceTemplates"]>[0]) {
    return this.connected().request({method: "resources/templates/list", ...(params === undefined ? {} : {params})}, {timeout: 5000});
  }
  async readResource(uri: string) {
    return this.connected().readResource({uri}, {timeout: 5000, cacheMode: "refresh"});
  }
}

/**
 * Create an MCP server connection via stdio transport.
 * This implements the public Agents MCPServer interface with a legacy client.
 *
 * Hardening: `command` and every element of `args` are validated against a
 * shell-metacharacter denylist before being concatenated into `fullCommand`.
 * This preserves the existing command admission policy while changing the
 * transport implementation.
 */
export function createMcpServer(config: {
  name: string;
  command: string;
  args: string[];
  /**
   * Opt-in escape hatch: skip the shell-metacharacter denylist.
   *
   * Caller takes responsibility for ensuring `command` and every element
   * of `args` are safe to concatenate into a shell-interpreted string.
   * Use only when `command`/`args` come from a trusted, pre-validated
   * source (config schema, hard-coded path table, allowlist).
   *
   * Named `allowUnsafeFullCommand` rather than `trustedCommand` so the
   * risk surface is visible at the call site: code review sees the word
   * "unsafe" in the option name, not a euphemism that reads as blessed.
   *
   * Typical legitimate use: a path with spaces such as
   * `/Users/me/Application Support/foo/bin` that the default denylist
   * (which rejects whitespace) would otherwise refuse.
   *
   * This compatibility option and fullCommand splitting remain unchanged;
   * the adapter does not widen command admission during the SDK migration.
   */
  allowUnsafeFullCommand?: boolean;
}): MCPServerWithResources {
  if (!Array.isArray(config.args)) {
    throw new Error("createMcpServer: args must be an array of strings");
  }
  if (config.allowUnsafeFullCommand !== true) {
    validateCommandPart(config.command, "createMcpServer: command");
    config.args.forEach((arg, i) =>
      validateCommandPart(arg, `createMcpServer: args[${i}]`),
    );
  }
  return new SingleStartMcpServer(config.name, `${config.command} ${config.args.join(" ")}`);
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
    mcpArtifact.arguments_hash = hashArguments(args);
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
  mcpServers: MCPServer[]
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
