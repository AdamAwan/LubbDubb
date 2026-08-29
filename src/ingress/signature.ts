import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What an inbound delivery's credential actually proves — and, on one of the two
 * providers, how little.
 *
 * The ingress endpoint is the only unauthenticated, internet-facing surface this
 * product has (`src/server/routes/ingress.ts`), so the honest statement of each
 * scheme's guarantee lives beside its implementation rather than in prose
 * somewhere else. → `docs/spec/30-ingress.md#what-verification-guarantees`
 */

/**
 * GitHub's `X-Hub-Signature-256`: HMAC-SHA256 of the **raw request body** under a
 * secret the operator shares with the webhook, hex-encoded behind a `sha256=`
 * prefix.
 *
 * **What it proves.** The bytes were produced by somebody holding the secret and
 * arrived unmodified. That is a real guarantee and it is the whole of one: nothing
 * in the signed material is a timestamp or a nonce, so a delivery captured off the
 * wire (or replayed out of GitHub's own redelivery UI) verifies again, forever.
 * Freshness is not signed and cannot be recovered from the signature — the replay
 * ledger in `src/ingress/ingress.ts` is a mitigation, not a proof.
 *
 * **The raw body, never the re-serialised one.** `JSON.stringify(JSON.parse(x))`
 * is not `x` for any payload with non-ASCII text, a float, or key order the
 * provider chose — so a signature checked against a round-tripped body is one that
 * fails on exactly the deliveries that carry an emoji in a comment.
 *
 * Constant-time, and length-checked first because `timingSafeEqual` throws on
 * buffers of different lengths.
 */
export function verifyGitHubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return constantTimeEquals(expected, header);
}

/**
 * Azure DevOps' story, which is a different and weaker thing.
 *
 * A service-hook subscription can be given HTTP **basic** credentials, which Azure
 * then sends on every POST. So what arrives is a shared secret in a header:
 *
 * - It authenticates the **caller**, not the body. Nothing in the request is
 *   bound to its contents, so anyone who obtains the credential can post any
 *   payload at all.
 * - It is a bearer credential, replayed verbatim on every delivery, so it is worth
 *   exactly what the transport is worth. Over plain HTTP it is base64 on the wire
 *   — recoverable by anyone on the path, which is every hop between Azure and the
 *   endpoint. The operator must terminate TLS in front of this endpoint; nothing
 *   here can check that they did.
 *
 * That is the honest guarantee, and it is why the harness treats a delivery as a
 * request to *look again* and never as a fact about the world
 * (`docs/spec/30-ingress.md#what-the-endpoint-trusts`). Naming it `verify` while
 * it proves so much less than GitHub's would be the sort of thing that reads as
 * security and is not.
 */
export function verifyBasicCredential(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const space = header.indexOf(' ');
  // Parsed by hand rather than with a regex, for `auth.ts`'s reason: this header is
  // unauthenticated attacker input, and a quantifier pair over a run of spaces
  // backtracks polynomially.
  if (space <= 0 || header.slice(0, space).toLowerCase() !== 'basic') return false;
  const value = header.slice(space + 1).trim();
  if (!value) return false;
  return constantTimeEquals(Buffer.from(expected, 'utf8').toString('base64'), value);
}

/**
 * Constant-time string comparison. The length check leaks the length of the
 * expected value, which is a property of the scheme rather than of the secret —
 * a hex HMAC is always 71 characters, and an operator's basic credential's length
 * is not what makes it hard to guess.
 */
function constantTimeEquals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
