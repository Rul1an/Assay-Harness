import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpServer } from "../dist/mcp.js";

// Literal stdio protocol peer: no SDK dependency, sockets or provider calls.
const fixture = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [log, mode] = process.argv.slice(2);
const prior = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const generation = prior.filter(x => x.event === 'start').length + 1;
const mark = (event) => appendFileSync(log, JSON.stringify({event, pid: process.pid, generation}) + '\n');
mark('start');
process.on('exit', () => mark('exit'));
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
const lines = createInterface({input: process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  mark(request.method);
  if (mode === 'fail' && request.method === 'initialize') process.exit(3);
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: {tools: {}}, serverInfo: {name: 'compat-peer', version: '1.0.0'}
  };
  else if (request.method === 'notifications/initialized') return;
  else if (request.method === 'tools/list') result = {tools: [{
    name: 'compat_echo_' + generation, description: 'Inert compatibility tool',
    inputSchema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value']}
  }]};
  else if (request.method === 'tools/call') result = {content: [{type: 'text', text: 'echo:' + request.params.arguments.value}]};
  else if (request.method === 'ping') result = {};
  else {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'unsupported'}})+'\n');
    return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\n');
});
`;

async function withPeer(mode, body) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-compat-"));
  const script = join(dir, "peer.mjs");
  const log = join(dir, "events.jsonl");
  await writeFile(script, fixture);
  const server = createMcpServer({name: "compat-peer", command: process.execPath, args: [script, log, mode]});
  const events = async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  try {
    await body(server, events);
  } finally {
    await server.close();
    // Observe cleanup before emergency fixture cleanup, including mutant failures.
    const leaked = [];
    for (const event of (await events()).filter(x => x.event === "start")) {
      try { process.kill(event.pid, 0); } catch (error) {
        assert.equal(error.code, "ESRCH");
        continue;
      }
      leaked.push(event.pid);
      process.kill(event.pid, "SIGTERM");
      for (let attempt = 0; attempt < 100; attempt++) {
        await delay(10);
        try { process.kill(event.pid, 0); } catch { break; }
      }
    }
    await rm(dir, {recursive: true, force: true});
    assert.deepEqual(leaked, [], "close must terminate every fixture child");
  }
}

test("MCP wrapper connects, invokes, closes and reconnects a real stdio peer", {timeout: 15000}, async () => {
  await withPeer("normal", async (server, events) => {
    await assert.rejects(server.listTools());
    for (const generation of [1, 2]) {
      await server.connect();
      const tools = await server.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, `compat_echo_${generation}`);
      assert.deepEqual(tools[0].inputSchema.required, ["value"]);
      assert.deepEqual(await server.callTool(tools[0].name, {value: "literal"}), [{type: "text", text: "echo:literal"}]);
      const reached = (await events()).filter(x => x.generation === generation).map(x => x.event);
      assert.ok(reached.includes("initialize"));
      assert.ok(reached.includes("notifications/initialized"));
      assert.ok(reached.includes("tools/list"));
      assert.ok(reached.includes("tools/call"));
      await server.close();
      await assert.rejects(server.listTools());
    }
  });
});

test("MCP initialization failure rejects and cleans up its child", {timeout: 10000}, async () => {
  await withPeer("fail", async (server, events) => {
    await assert.rejects(server.connect());
    assert.ok((await events()).some(x => x.event === "initialize"));
  });
});
