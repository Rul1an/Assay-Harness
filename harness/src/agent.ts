/**
 * Agent definition and tool set for the Assay Harness MVP.
 *
 * Defines one agent with a mix of allowed, denied, and approval-required tools.
 * The needsApproval flag on tools triggers the Agents SDK's built-in
 * interruption + resumable state flow.
 */

import { Agent, tool } from "@openai/agents";
import { z } from "zod";

// --- Tools ---

export const readFileTool = tool({
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative file path to read"),
  }),
  execute: async (input) => {
    // Simulated for MVP — in production this would read actual files
    return `[simulated] Contents of ${input.path}: Hello, world!`;
  },
});

export const listDirectoryTool = tool({
  name: "list_directory",
  description: "List files in a directory.",
  parameters: z.object({
    path: z.string().describe("Directory path to list"),
  }),
  execute: async (input) => {
    return `[simulated] Files in ${input.path}: file1.txt, file2.txt, readme.md`;
  },
});

export const writeFileTool = tool({
  name: "write_file",
  description: "Write content to a file. Requires human approval.",
  parameters: z.object({
    path: z.string().describe("File path to write to"),
    content: z.string().describe("Content to write"),
  }),
  needsApproval: true,
  execute: async (input) => {
    return `[simulated] Wrote ${input.content.length} bytes to ${input.path}`;
  },
});

export const shellExecTool = tool({
  name: "shell_exec",
  description: "Execute a shell command. Requires human approval.",
  parameters: z.object({
    command: z.string().describe("Shell command to execute"),
  }),
  needsApproval: true,
  execute: async (input) => {
    return `[simulated] Executed: ${input.command} → exit code 0`;
  },
});

export const networkEgressTool = tool({
  name: "network_egress",
  description: "Make an outbound network request.",
  parameters: z.object({
    url: z.string().describe("URL to request"),
  }),
  execute: async (input) => {
    return `[simulated] Fetched ${input.url}`;
  },
});

// --- Agent ---

export const allTools = [
  readFileTool,
  listDirectoryTool,
  writeFileTool,
  shellExecTool,
  networkEgressTool,
];

export function createHarnessAgent(): Agent {
  return new Agent({
    name: "harness-mvp-agent",
    instructions: `You are a file management assistant. You can read files, list directories,
write files (requires approval), and execute shell commands (requires approval).
When asked to perform a task, use the appropriate tool.
Always explain what you're about to do before using a tool.`,
    tools: allTools,
  });
}
