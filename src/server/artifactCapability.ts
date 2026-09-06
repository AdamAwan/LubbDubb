import { createHmac, timingSafeEqual } from 'node:crypto';

// → docs/spec/12-artifacts-and-files.md

function sign(secret: Buffer, flagId: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${flagId}.${expiresAt}`).digest('base64url');
}

export function mintArtifactCapability(secret: Buffer, flagId: string, expiresAt: number): string {
  return `${expiresAt}.${sign(secret, flagId, expiresAt)}`;
}

export function verifyArtifactCapability(secret: Buffer, token: string, flagId: string, now: number): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return false;
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, flagId, expiresAt));
  // TECHDEBT: length is checked first: timingSafeEqual throws on unequal-length buffers, and
  // a base64url signature of the wrong length is not this signature regardless.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
