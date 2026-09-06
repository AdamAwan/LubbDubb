import { createHmac, timingSafeEqual } from 'node:crypto';

// → docs/spec/30-ingress.md

export function verifyGitHubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return constantTimeEquals(expected, header);
}

export function verifyBasicCredential(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const space = header.indexOf(' ');
  // TECHDEBT: parsed by hand rather than with a regex, for `auth.ts`'s reason: this header is
  // unauthenticated attacker input, and a quantifier pair over a run of spaces
  // backtracks polynomially.
  if (space <= 0 || header.slice(0, space).toLowerCase() !== 'basic') return false;
  const value = header.slice(space + 1).trim();
  if (!value) return false;
  return constantTimeEquals(Buffer.from(expected, 'utf8').toString('base64'), value);
}

function constantTimeEquals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
