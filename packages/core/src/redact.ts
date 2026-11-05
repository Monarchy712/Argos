/**
 * The Arkiv SDK puts the access key in the RPC URL path (…/ark_live_<key>), and viem error
 * messages include the full request URL. Run every logged error through this so a key never
 * lands in a log file, a test report or a screenshot.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/ark_live_[A-Za-z0-9_-]+/g, "ark_live_[REDACTED]")
    .replace(/0x[0-9a-fA-F]{64}(?=\b)/g, (m, offset: number, all: string) =>
      // private keys look like 32-byte hex; only redact when labelled as a key nearby
      /private|secret|key\s*[:=]/i.test(all.slice(Math.max(0, offset - 24), offset)) ? "0x[REDACTED]" : m,
    );
}

/** One-line, redacted description of an error (status + short message, no stack, no body). */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let c = err as { shortMessage?: string; message?: string; status?: number; cause?: unknown } | undefined, depth = 0; c && depth < 6; c = c.cause as typeof c, depth++) {
    if (typeof c.status === "number") parts.push(`HTTP ${c.status}`);
    const m = c.shortMessage ?? (depth === 0 ? c.message?.split("\n")[0] : undefined);
    if (m && !parts.includes(m)) parts.push(m);
  }
  return redactSecrets(parts.join(" · ") || String(err).split("\n")[0]!);
}
