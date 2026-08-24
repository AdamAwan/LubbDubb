/**
 * The last control before a claim leaves the machine: a **refusal**, never a
 * rewrite.
 *
 * A scrub is refused, and the shape of this file is the argument. A customer name
 * is an English noun and no expression matches it, so a scrub that mostly works is
 * worse than none: its output *looks* sanitised, nobody reads it carefully again,
 * and the one it missed is now trusted — it fails in the direction where the claim
 * publishes looking clean. This is deliberately the opposite shape. It refuses, and
 * refusing is loud: the claim is not published and the row says why.
 *
 * An allowlist is refused for a plainer reason: a claim is a sentence, and there is
 * no structure to allow.
 *
 * Every pattern here is **high-confidence and structured** — a key, a token, a
 * private-key header. Nothing heuristic, because a false refusal is an operator
 * watching a claim they vouched for never appear in the pool with no way to tell
 * whether the pool is broken.
 *
 * → `docs/spec/28-cross-fleet-pool.md#data-classification`
 */

/** One structured shape a secret takes, and what to call it when a claim is refused for it. */
interface SecretPattern {
  label: string;
  pattern: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { label: 'a PEM private key header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'an OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // A key named in a URL's credentials is the one non-token shape here, and it is
  // structured enough to be certain about: a scheme, a colon, a secret, an at-sign.
  { label: 'credentials embedded in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
];

/**
 * Why this text may not be published, or null when nothing structured matched.
 *
 * The reason names the *shape* and never quotes the match: a refusal drawn on the
 * Knowledge page is read by whoever can act on it, and echoing the secret into the
 * cockpit — and into the error log beside it — would be this control creating the
 * exposure it exists to stop.
 */
export function secretRefusal(text: string): string | null {
  const found = PATTERNS.find((entry) => entry.pattern.test(text));
  return found ? `it looks like it contains ${found.label}` : null;
}
