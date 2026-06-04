/**
 * Parse the structured signals the Runner embeds in its kernel-capture note
 * (`observation_health.notes[]`) into first-class fields for reviewer output.
 *
 * Consumer-only: the Runner (`Rul1an/assay`) owns the note format. Harness
 * reads the published `s2_kernel_capture:` line and surfaces the network
 * signals it carries so a reviewer does not have to eyeball a note string:
 *
 *   - `network_protocol_coverage=<status>` — connect_only / datagram_peer_observed
 *     / connect_and_datagram_peer_observed / absent / unknown.
 *   - `send_no_recoverable_peer=sendto:<n> sendmsg:<m>` — address-less sends
 *     (R1); present only when non-zero.
 *   - `send_non_ip_family=sendto:<n> sendmsg:<m>` — sends to a non-IP family
 *     (R2); present only when non-zero.
 *
 * These are visibility signals: the Runner never raises the coverage descriptor
 * on them, and Harness must not treat them as a regression by themselves.
 */

export interface SendCounter {
  sendto: number;
  sendmsg: number;
}

export interface KernelCaptureSignals {
  network_protocol_coverage?: string;
  network_endpoint_claim_scope?: string;
  send_no_recoverable_peer?: SendCounter;
  send_non_ip_family?: SendCounter;
}

const PROTOCOL_RE = /network_protocol_coverage=([a-z_]+)/;
const CLAIM_SCOPE_RE = /network_endpoint_claim_scope=([a-z_]+)/;
const NO_PEER_RE = /send_no_recoverable_peer=sendto:(\d+) sendmsg:(\d+)/;
const NON_IP_RE = /send_non_ip_family=sendto:(\d+) sendmsg:(\d+)/;

/**
 * Extract the network capture signals from a set of observation-health notes.
 * Returns an empty object when no `s2_kernel_capture:` signals are present, so
 * callers can omit the block for runs that carry none (additive, opt-in).
 */
export function parseKernelCaptureSignals(notes: string[] | undefined): KernelCaptureSignals {
  const out: KernelCaptureSignals = {};
  if (!Array.isArray(notes)) return out;
  for (const note of notes) {
    if (typeof note !== "string") continue;
    const proto = PROTOCOL_RE.exec(note);
    if (proto && out.network_protocol_coverage === undefined) {
      out.network_protocol_coverage = proto[1];
    }
    const scope = CLAIM_SCOPE_RE.exec(note);
    if (scope && out.network_endpoint_claim_scope === undefined) {
      out.network_endpoint_claim_scope = scope[1];
    }
    const noPeer = NO_PEER_RE.exec(note);
    if (noPeer && out.send_no_recoverable_peer === undefined) {
      out.send_no_recoverable_peer = {
        sendto: Number(noPeer[1]),
        sendmsg: Number(noPeer[2]),
      };
    }
    const nonIp = NON_IP_RE.exec(note);
    if (nonIp && out.send_non_ip_family === undefined) {
      out.send_non_ip_family = { sendto: Number(nonIp[1]), sendmsg: Number(nonIp[2]) };
    }
  }
  return out;
}

/** True when no signal at all was parsed. */
export function signalsEmpty(s: KernelCaptureSignals): boolean {
  return (
    s.network_protocol_coverage === undefined &&
    s.network_endpoint_claim_scope === undefined &&
    s.send_no_recoverable_peer === undefined &&
    s.send_non_ip_family === undefined
  );
}

/** Markdown lines for the verify-runner projection; empty array when no signals. */
export function formatKernelCaptureSignals(s: KernelCaptureSignals): string[] {
  if (signalsEmpty(s)) return [];
  const lines: string[] = ["## Network capture signals", ""];
  if (s.network_protocol_coverage !== undefined) {
    lines.push(`- network_protocol_coverage: \`${s.network_protocol_coverage}\``);
  }
  if (s.network_endpoint_claim_scope !== undefined) {
    lines.push(`- network_endpoint_claim_scope: \`${s.network_endpoint_claim_scope}\``);
  }
  if (s.send_no_recoverable_peer) {
    lines.push(
      `- send_no_recoverable_peer: sendto=${s.send_no_recoverable_peer.sendto}, sendmsg=${s.send_no_recoverable_peer.sendmsg} (address-less sends; visibility only)`,
    );
  }
  if (s.send_non_ip_family) {
    lines.push(
      `- send_non_ip_family: sendto=${s.send_non_ip_family.sendto}, sendmsg=${s.send_non_ip_family.sendmsg} (non-IP family sends; visibility only)`,
    );
  }
  lines.push("");
  return lines;
}
