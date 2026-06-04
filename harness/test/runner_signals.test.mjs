import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatKernelCaptureSignals,
  parseKernelCaptureSignals,
  signalsEmpty,
} from "../dist/runner_signals.js";

const NOTE_FULL =
  "s2_kernel_capture: monitor_events=12 ringbuf_drops=0 " +
  "network_protocol_coverage=connect_and_datagram_peer_observed " +
  "network_endpoint_claim_scope=diagnostic_only " +
  "send_no_recoverable_peer=sendto:2 sendmsg:1 " +
  "send_non_ip_family=sendto:4 sendmsg:2";

const NOTE_PLAIN =
  "s2_kernel_capture: monitor_events=3 ringbuf_drops=0 " +
  "network_protocol_coverage=connect_only network_endpoint_claim_scope=diagnostic_only";

test("parses all network signals from a full note", () => {
  const s = parseKernelCaptureSignals([NOTE_FULL]);
  assert.equal(s.network_protocol_coverage, "connect_and_datagram_peer_observed");
  assert.equal(s.network_endpoint_claim_scope, "diagnostic_only");
  assert.deepEqual(s.send_no_recoverable_peer, { sendto: 2, sendmsg: 1 });
  assert.deepEqual(s.send_non_ip_family, { sendto: 4, sendmsg: 2 });
  assert.equal(signalsEmpty(s), false);
});

test("a plain note has protocol coverage but no send counters", () => {
  const s = parseKernelCaptureSignals([NOTE_PLAIN]);
  assert.equal(s.network_protocol_coverage, "connect_only");
  assert.equal(s.send_no_recoverable_peer, undefined);
  assert.equal(s.send_non_ip_family, undefined);
});

test("no kernel-capture note -> empty signals", () => {
  const s = parseKernelCaptureSignals(["some unrelated note", "another"]);
  assert.equal(signalsEmpty(s), true);
  assert.deepEqual(formatKernelCaptureSignals(s), []);
});

test("undefined/empty notes -> empty signals", () => {
  assert.equal(signalsEmpty(parseKernelCaptureSignals(undefined)), true);
  assert.equal(signalsEmpty(parseKernelCaptureSignals([])), true);
});

test("markdown lists the signals only when present", () => {
  const md = formatKernelCaptureSignals(parseKernelCaptureSignals([NOTE_FULL])).join("\n");
  assert.match(md, /Network capture signals/);
  assert.match(md, /send_no_recoverable_peer: sendto=2, sendmsg=1/);
  assert.match(md, /send_non_ip_family: sendto=4, sendmsg=2/);
  assert.match(md, /visibility only/);
});
