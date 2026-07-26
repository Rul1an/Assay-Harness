import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Agent, Usage, tool } from "@openai/agents";
import { z } from "zod";

import { runHarness } from "../dist/harness.js";
import { PolicyEngine } from "../dist/policy.js";

const emptyUsage = () => new Usage();

const finalMessage = (text) => ({
  usage: emptyUsage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

class ScriptedModel {
  constructor(responses) {
    this.responses = [...responses];
  }

  async getResponse() {
    const response = this.responses.shift();
    assert.ok(response, "scripted model received an unexpected request");
    return response;
  }

  async *getStreamedResponse() {
    throw new Error("streaming is outside this compatibility smoke");
  }
}

const approvalTool = (executions) =>
  tool({
    name: "write_file",
    description: "Hermetic approval-required compatibility tool.",
    parameters: z.object({
      path: z.string(),
      content: z.string(),
    }),
    needsApproval: true,
    execute: async ({ path, content }) => {
      executions.count += 1;
      return `wrote ${content.length} bytes to ${path}`;
    },
  });

const policy = (requireApproval = []) =>
  new PolicyEngine({
    version: "1.0",
    name: "runtime-compat",
    tools: {
      allow: [],
      deny: [],
      require_approval: requireApproval,
    },
  });

test("runHarness completes a hermetic normal execution", async () => {
  const agent = new Agent({
    name: "normal-runtime-smoke",
    instructions: "Return the scripted response.",
    model: new ScriptedModel([finalMessage("normal-complete")]),
  });

  const result = await runHarness(
    { agent, policy: policy(), runId: "runtime-normal" },
    "normal"
  );

  assert.equal(result.finalOutput, "normal-complete");
  assert.equal(result.interrupted, false);
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.rejected, []);
});

test("runHarness approves and resumes an interrupted tool call", async () => {
  const executions = { count: 0 };
  const agent = new Agent({
    name: "approval-runtime-smoke",
    instructions: "Use the scripted approval-required tool.",
    model: new ScriptedModel([
      {
        usage: emptyUsage(),
        output: [
          {
            type: "function_call",
            callId: "call-runtime-approval",
            name: "write_file",
            arguments: JSON.stringify({ path: "/tmp/out", content: "ok" }),
          },
        ],
      },
      finalMessage("approval-resumed"),
    ]),
    tools: [approvalTool(executions)],
  });

  const result = await runHarness(
    {
      agent,
      policy: policy(["write_file"]),
      runId: "runtime-approval",
      autoApprove: true,
    },
    "write"
  );

  assert.equal(result.finalOutput, "approval-resumed");
  assert.equal(result.interrupted, true);
  assert.deepEqual(result.approved, ["write_file"]);
  assert.deepEqual(result.rejected, []);
  assert.equal(executions.count, 1);
});

test("runHarness resumes a rejected tool call without executing it", async () => {
  const executions = { count: 0 };
  const agent = new Agent({
    name: "rejection-runtime-smoke",
    instructions: "Use the scripted approval-required tool.",
    model: new ScriptedModel([
      {
        usage: emptyUsage(),
        output: [
          {
            type: "function_call",
            callId: "call-runtime-rejection",
            name: "write_file",
            arguments: JSON.stringify({ path: "/tmp/out", content: "no" }),
          },
        ],
      },
      finalMessage("rejection-resumed"),
    ]),
    tools: [approvalTool(executions)],
  });

  const result = await runHarness(
    {
      agent,
      policy: policy(["write_file"]),
      runId: "runtime-rejection",
      autoDeny: true,
    },
    "write"
  );

  assert.equal(result.finalOutput, "rejection-resumed");
  assert.equal(result.interrupted, true);
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.rejected, ["write_file"]);
  assert.equal(executions.count, 0);
  assert.equal(
    result.evidence.events.filter(
      (event) => event.type === "assay.harness.resumed-run"
    ).length,
    1
  );
});
