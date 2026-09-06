import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getDefaultModel } from "@openai/agents";
import { createHarnessAgent } from "../dist/agent.js";

// Serial cases restore the caller's environment; constructing an Agent makes no request.
for (const { label, override, expected } of [
  { label: "unset", override: undefined, expected: "gpt-5.4-mini" },
  { label: "set", override: "gpt-4.1", expected: "gpt-4.1" },
  { label: "mixed case", override: "GpT-4.1-MiNi", expected: "gpt-4.1-mini" },
  { label: "empty", override: "", expected: "" },
  { label: "untrimmed", override: " GpT-4.1 ", expected: " gpt-4.1 " },
]) {
  test(`createHarnessAgent preserves model selection with ${label} override`, () => {
    const original = process.env.OPENAI_DEFAULT_MODEL;
    try {
      if (override === undefined) delete process.env.OPENAI_DEFAULT_MODEL;
      else process.env.OPENAI_DEFAULT_MODEL = override;

      const agent = createHarnessAgent();
      assert.equal(agent.model, expected);
      // Pin the observable SDK override rule while keeping Harness's absent-value
      // fallback independent of future SDK default changes.
      if (override !== undefined) assert.equal(agent.model, getDefaultModel());
      assert.equal(process.env.OPENAI_DEFAULT_MODEL, override);
    } finally {
      if (original === undefined) delete process.env.OPENAI_DEFAULT_MODEL;
      else process.env.OPENAI_DEFAULT_MODEL = original;
    }
  });
}
