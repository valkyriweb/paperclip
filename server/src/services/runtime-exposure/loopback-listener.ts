/**
 * Server-side loopback listener diagnosis for the `tailscale_https` mode
 * (PAP-17256).
 *
 * The broker already refuses to expose a port whose listener is not
 * loopback-only, and it must keep doing that check itself — it cannot trust the
 * caller. But the broker only answers with a stable machine code, so when a
 * managed lane bound `0.0.0.0` the operator saw a bare
 * `listener_ownership_mismatch` with no port, no address, and no hint about
 * which side was wrong. That opacity, not the denial, is what turned one bug
 * into three diagnostic cycles.
 *
 * So the server runs the same read *before* it calls the broker, purely to
 * produce a sentence a human can act on. This is deliberately a duplicate of
 * the broker's `proc-listener` logic rather than a shared import: the broker is
 * host-privileged and its gate must stay independent of anything the server
 * says. If the two ever disagree, the broker still wins — this one only
 * explains.
 *
 * Parsing helpers are exported pure so they can be tested without /proc.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One listening row from `/proc/net/tcp` or `/proc/net/tcp6`. */
export interface ProcListenerRow {
  localAddressHex: string;
  localPortHex: string;
  state: string;
}

export interface ListenerBindFacts {
  present: boolean;
  loopbackOnly: boolean;
  /** Bound addresses in human-readable form, for the diagnosis message. */
  addresses: string[];
}

const TCP_STATE_LISTEN = "0A";

/** Parse one `/proc/net/tcp{,6}` table into its listening rows. */
export function parseProcNetListeners(content: string): ProcListenerRow[] {
  const rows: ProcListenerRow[] = [];
  for (const line of content.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [addr, port] = cols[1].split(":");
    if (!addr || !port) continue;
    rows.push({ localAddressHex: addr, localPortHex: port, state: cols[3] });
  }
  return rows;
}

/** True for a wildcard bind (`0.0.0.0` / `::`), reachable off-loopback. */
function isWildcardHex(addrHex: string): boolean {
  return /^0+$/.test(addrHex);
}

/**
 * Render a `/proc` address for humans. Both tables store 32-bit words in host
 * (little-endian) byte order, so each 8-hex-digit word is byte-swapped.
 */
export function formatProcAddressHex(addrHex: string): string {
  if (addrHex.length === 8) {
    const octets = [6, 4, 2, 0].map((offset) => parseInt(addrHex.slice(offset, offset + 2), 16));
    return octets.join(".");
  }
  if (addrHex.length === 32) {
    const bytes: number[] = [];
    for (let word = 0; word < 4; word += 1) {
      const hex = addrHex.slice(word * 8, word * 8 + 8);
      for (let offset = 6; offset >= 0; offset -= 2) {
        bytes.push(parseInt(hex.slice(offset, offset + 2), 16));
      }
    }
    if (bytes.every((byte) => byte === 0)) return "::";
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1";
    const groups: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
    }
    return groups.join(":");
  }
  return `0x${addrHex}`;
}

/** True when a `/proc` IPv4 hex address is in 127.0.0.0/8. */
function isLoopbackIpv4Hex(addrHex: string): boolean {
  if (addrHex.length !== 8) return false;
  return parseInt(addrHex.slice(6, 8), 16) === 127;
}

/** `::1` as `/proc/net/tcp6` stores it — final word byte-swapped. */
const LOOPBACK_IPV6_PROC_HEX = "00000000000000000000000001000000";

function isLoopbackIpv6Hex(addrHex: string): boolean {
  return addrHex.toUpperCase() === LOOPBACK_IPV6_PROC_HEX;
}

/** Reduce both `/proc` tables to bind facts for one port. */
export function listenerBindFactsForPort(
  tcp: ProcListenerRow[],
  tcp6: ProcListenerRow[],
  port: number,
): ListenerBindFacts {
  const wantHex = port.toString(16).toUpperCase().padStart(4, "0");
  const addresses: string[] = [];
  let present = false;
  let loopbackOnly = true;
  const scan = (rows: ProcListenerRow[], isLoopback: (hex: string) => boolean) => {
    for (const row of rows) {
      if (row.localPortHex.toUpperCase() !== wantHex || row.state !== TCP_STATE_LISTEN) continue;
      present = true;
      addresses.push(formatProcAddressHex(row.localAddressHex));
      if (isWildcardHex(row.localAddressHex) || !isLoopback(row.localAddressHex)) {
        loopbackOnly = false;
      }
    }
  };
  scan(tcp, isLoopbackIpv4Hex);
  scan(tcp6, isLoopbackIpv6Hex);
  return { present, loopbackOnly, addresses: [...new Set(addresses)] };
}

/**
 * Read the bind address from macOS/BSD `lsof` output. `/proc` is preferable on
 * Linux because it also lets the caller inspect ownership, but macOS has no
 * procfs and silently returning null there made the same listener-ownership
 * regression impossible to diagnose in the primary development environment.
 */
async function readListenerBindFactsWithLsof(port: number): Promise<ListenerBindFacts | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    }));
  } catch {
    // `lsof` is not guaranteed to be installed, and an absent executable is
    // still an unknown verdict rather than evidence of a safe listener.
    return null;
  }

  const addresses: string[] = [];
  let loopbackOnly = true;
  for (const line of stdout.split("\n").slice(1)) {
    const name = line.trim().split(/\s+/).at(-2);
    if (!name) continue;
    const endpoint = name.replace(/\s+\(LISTEN\)$/, "");
    const separator = endpoint.lastIndexOf(":");
    if (separator < 0) continue;
    const address = endpoint.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
    if (!address) continue;
    const normalized = address.toLowerCase();
    addresses.push(normalized === "*" ? "0.0.0.0" : address);
    const isLoopback = normalized === "localhost"
      || normalized === "127.0.0.1"
      || normalized === "::1"
      || normalized === "::ffff:127.0.0.1";
    const isWildcard = normalized === "*"
      || normalized === "0.0.0.0"
      || normalized === "::";
    if (!isLoopback || isWildcard) loopbackOnly = false;
  }

  return {
    present: addresses.length > 0,
    loopbackOnly,
    addresses: [...new Set(addresses)],
  };
}

/** Read live bind facts for one port. Unreadable `/proc` falls back to `lsof`. */
export async function readListenerBindFacts(port: number): Promise<ListenerBindFacts | null> {
  let tcp: ProcListenerRow[];
  try {
    tcp = parseProcNetListeners(await readFile("/proc/net/tcp", "utf8"));
  } catch {
    return readListenerBindFactsWithLsof(port);
  }
  let tcp6: ProcListenerRow[] = [];
  try {
    tcp6 = parseProcNetListeners(await readFile("/proc/net/tcp6", "utf8"));
  } catch {
    /* optional table */
  }
  return listenerBindFactsForPort(tcp, tcp6, port);
}

/**
 * Build the operator-facing diagnosis for a set of ports about to be exposed, or
 * null when nothing is provably wrong.
 *
 * Only a *proven* violation is reported. A missing listener is not treated as a
 * violation here: readiness already gates on the bind, and guessing would turn a
 * benign race into a misleading error.
 */
export async function diagnoseRuntimeListenerBinds(ports: number[]): Promise<string | null> {
  const violations: string[] = [];
  for (const port of ports) {
    const facts = await readListenerBindFacts(port);
    if (!facts || !facts.present || facts.loopbackOnly) continue;
    violations.push(`port ${port} is bound to ${facts.addresses.join(", ")}`);
  }
  if (violations.length === 0) return null;
  return (
    `${violations.join("; ")} instead of loopback only. The broker will not expose a listener `
    + "reachable off-loopback. This means the workspace checkout's dev server ignored the managed "
    + "loopback bind — a checkout that predates managed HTTPS exposure overwrites PAPERCLIP_BIND "
    + "from its own --bind argv, so the start command must pass --bind loopback."
  );
}
