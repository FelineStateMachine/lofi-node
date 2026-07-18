// Pairing ticket codec — pure string/bytes framing, no FFI in the import
// graph (same separation doorbearer's ticket.ts proved out). A ticket carries
// exactly one thing in v1: the node's postcard-encoded EndpointAddr.

const TICKET_PREFIX = "LFN1.";

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeTicket(nodeAddr: Uint8Array): string {
  return TICKET_PREFIX + toBase64(nodeAddr);
}

/** Returns null on any malformed input — never throws (paste-from-user path). */
export function decodeTicket(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TICKET_PREFIX)) return null;
  try {
    const addr = fromBase64(trimmed.slice(TICKET_PREFIX.length));
    return addr.length > 0 ? addr : null;
  } catch {
    return null;
  }
}
