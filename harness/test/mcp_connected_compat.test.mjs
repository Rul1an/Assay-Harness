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
const mark = (event, params) => appendFileSync(log, JSON.stringify({event, pid: process.pid, generation, params}) + '\n');
mark('start');
process.on('exit', () => mark('exit'));
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => mode === 'wait-init' ? setTimeout(() => process.exit(0), 200) : process.exit(0));
const lines = createInterface({input: process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line);
  mark(request.method, request.params);
  if (mode === 'wait-init' && request.method === 'initialize') return;
  if (mode === 'fail' && request.method === 'initialize') process.exit(3);
  if (request.method === 'tools/list' && mode === 'page-error' && request.params?.cursor) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32603,message:'page refused'}})+'\n'); return;
  }
  if (request.method === 'tools/call' && mode === 'wait') return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: {tools: {}, resources: {}}, serverInfo: {name: 'compat-peer', version: '1.0.0'}
  };
  else if (request.method === 'notifications/initialized') return;
  else if (request.method === 'tools/list') result = {tools: [{
    name: 'compat_echo_' + generation, description: 'Inert compatibility tool',
    inputSchema: {type: 'object', properties: {value: {type: 'string'}}, required: ['value']}
  }]};
  else if (request.method === 'tools/call') result = {content: [{type: 'text', text: 'echo:' + request.params.arguments.value}]};
  else if (request.method === 'resources/list') result = {resources:[{uri:'fixture:one',name:'one'}],nextCursor:'next'};
  else if (request.method === 'resources/templates/list') result = {resourceTemplates:[]};
  else if (request.method === 'resources/read') result = {contents:[{uri:request.params.uri,text:'inert'}]};
  else if (request.method === 'ping') result = {};
  else {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'unsupported'}})+'\n');
    return;
  }
  if (request.method === 'tools/list') {
    if (['pages', 'repeat', 'page-error'].includes(mode)) {
      if (!request.params?.cursor || mode === 'repeat') result.nextCursor = 'page2';
      if (request.params?.cursor) result.tools[0].name += '_page2';
    }
    if (mode === 'task-required') result.tools[0].execution = {taskSupport:'required'};
    if (['structured', 'invalid-output', 'tool-error'].includes(mode)) result.tools[0].outputSchema = {type:'object',properties:{answer:{type:'number'}},required:['answer']};
  }
  if (request.method === 'tools/call' && ['structured', 'invalid-output', 'tool-error'].includes(mode)) {
    result.structuredContent = {answer: mode === 'invalid-output' ? 'wrong' : 42};
    result._meta = {fixture: 'retained'};
    result.isError = mode === 'tool-error';
  }
  const respond = () => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\n');
  if ((request.method === 'tools/list' && mode === 'slow-list') || (request.method === 'initialize' && mode === 'slow-init')) setTimeout(respond, 150); else respond();
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

// Physical startup is the contract, independently of tool naming.
test("stdio_startup_count: one connect starts exactly one physical peer", {timeout: 10000}, async () => {
  await withPeer("normal", async (server, events) => {
    await server.connect();
    await server.listTools();
    await server.close();
    assert.equal((await events()).filter(x => x.event === "start").length, 1);
    assert.equal((await events()).filter(x => x.event === "server/discover").length, 0);
  });
});

for (const mode of ["pages", "repeat", "page-error"]) {
  test(`MCP pagination preserves ${mode}`, {timeout: 10000}, async () => {
    await withPeer(mode, async (server) => {
      await server.connect();
      if (mode === "pages") assert.equal((await server.listTools()).length, 2);
      else await assert.rejects(server.listTools(), mode === "repeat" ? /repeated cursor/ : /continuation page/);
    });
  });
}
for (const mode of ["structured", "invalid-output", "tool-error"]) {
  test(`MCP result parity ${mode}`, {timeout: 10000}, async () => {
    await withPeer(mode, async (server, events) => {
      await server.connect();
      const [tool] = await server.listTools();
      if (mode === "invalid-output") {
        await assert.rejects(server.callToolResult(tool.name, {value:"literal"}), /output|schema|validation/i);
        return;
      }
      const result = await server.callToolResult(tool.name, {value:"literal"}, {fixture_request:"retained"});
      assert.deepEqual(result.structuredContent, {answer:42});
      assert.deepEqual(result._meta, {fixture:"retained"});
      assert.equal(result.isError, mode === "tool-error");
      assert.deepEqual(result.content, [{type:"text", text:"echo:literal"}]);
      assert.equal((await events()).find(x => x.event === "tools/call").params._meta.fixture_request, "retained");
      const content = await server.callTool(tool.name, {value:"literal"});
      assert.deepEqual(content.structuredContent, {answer:42});
      assert.equal(content.isError, mode === "tool-error");
      assert.deepEqual(content._meta, {fixture:"retained"});
    });
  });
}
test("MCP call signal cancels an in-flight request", {timeout:10000}, async () => {
  await withPeer("wait", async (server, events) => {
    await server.connect();
    const [tool] = await server.listTools();
    const abort = new AbortController();
    const pending = server.callTool(tool.name, {value:"literal"}, null, {signal:abort.signal});
    for (let i=0;i<100 && !(await events()).some(x => x.event === "tools/call");i++) await delay(10);
    assert.ok((await events()).some(x => x.event === "tools/call"));
    abort.abort(new Error("fixture cancellation"));
    await assert.rejects(pending, /fixture cancellation|abort|cancel/i);
  });
});

test("MCP invalidation refuses an already pending listing", {timeout:10000}, async () => {
  await withPeer("slow-list", async (server, events) => {
    await server.connect();
    const pending = server.listTools();
    for (let i=0;i<100 && !(await events()).some(x => x.event === "tools/list");i++) await delay(10);
    assert.ok((await events()).some(x => x.event === "tools/list"));
    await server.invalidateToolsCache();
    await assert.rejects(pending, /changed|stale|invalidat/i);
  });
});
test("MCP listed tool mutation cannot disable output validation", {timeout:10000}, async () => {
  await withPeer("invalid-output", async server => {
    await server.connect();
    const [tool] = await server.listTools();
    delete tool.outputSchema;
    await assert.rejects(server.callToolResult(tool.name, {value:"literal"}), /output|schema|validation/i);
  });
});

test("MCP task-required tool refuses before a tools/call request", {timeout:10000}, async () => {
  await withPeer("task-required", async (server, events) => {
    await server.connect();
    const [tool] = await server.listTools();
    await assert.rejects(server.callTool(tool.name, {value:"literal"}), /task-based execution/);
    assert.equal((await events()).filter(x => x.event === "tools/call").length, 0);
  });
});
test("MCP public resource methods retain per-page results", {timeout:10000}, async () => {
  await withPeer("normal", async server => {
    await server.connect();
    assert.deepEqual(await server.listResources(), {resources:[{uri:"fixture:one",name:"one"}],nextCursor:"next"});
    assert.deepEqual(await server.listResourceTemplates(), {resourceTemplates:[]});
    assert.deepEqual(await server.readResource("fixture:one"), {contents:[{uri:"fixture:one",text:"inert"}]});
  });
});

test("MCP listing refuses while initialization is pending", {timeout:10000}, async () => {
  await withPeer("slow-init", async server => {
    const connecting = server.connect();
    await delay(50);
    const listing = server.listTools().then(() => null, error => error);
    await connecting;
    assert.match((await listing)?.message ?? "listing unexpectedly succeeded", /initialized|lifecycle/);
  });
});

// Regression: the public client starts shutdown itself on initialize timeout.
test("MCP initialization timeout joins physical child exit", {timeout: 10000}, async () => {
  await withPeer("wait-init", async (server) => {
    await assert.rejects(server.connect(), /timed out|timeout/i);
    await assert.rejects(server.listTools(), /initialized/);
  });
});

// Both calls enter before either initialization can settle.
test("MCP concurrent connect refuses the second owner without leaking children", {timeout:10000}, async () => {
  await withPeer("slow-init", async (server, events) => {
    const results = await Promise.allSettled([server.connect(), server.connect()]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.match(results[1].reason.message, /connect.*progress|lifecycle/i);
    assert.equal((await events()).filter(x => x.event === "start").length, 1);
    assert.equal((await server.listTools())[0].name, "compat_echo_1");
  });
});
