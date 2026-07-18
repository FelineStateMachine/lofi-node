// Pairing tickets are upstream iroh EndpointTicket strings (produced and
// parsed by the addon). This module is the FFI-free shape check for paste
// paths (CLI pair) — real validation happens when the addon parses the
// ticket at connect/start time.

/** Cheap sanity check for a pasted ticket: single token, plausible length.
 * Never throws; never a guarantee — the addon's parser is authoritative. */
export function looksLikeTicket(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 32 && !/\s/.test(trimmed);
}
