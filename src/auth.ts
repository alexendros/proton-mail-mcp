/**
 * Timing-safe bearer token comparison.
 * Returns false immediately when lengths differ to avoid revealing length via timing;
 * otherwise compares byte-by-byte in constant time regardless of where the first
 * differing byte lies.
 */
export function compareTokens(received: string, expected: string): boolean {
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < received.length; i++) {
    diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Extracts the bearer token from an Authorization header, or "" if malformed. */
export function extractBearer(authHeader: string | undefined): string {
  if (!authHeader) return "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}
