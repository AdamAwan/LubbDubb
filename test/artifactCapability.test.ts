import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mintArtifactCapability, verifyArtifactCapability } from '../src/server/artifactCapability.js';

const KEY = randomBytes(32);
const NOW = 1_700_000_000_000;
const TTL = 5 * 60_000;

test('a freshly minted capability verifies for its own flag id', () => {
  const cap = mintArtifactCapability(KEY, 'flag_1', NOW + TTL);
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_1', NOW), true);
});

test('a capability is scoped to one flag id — it cannot open another artifact', () => {
  const cap = mintArtifactCapability(KEY, 'flag_1', NOW + TTL);
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_2', NOW), false);
});

test('a capability expires — it is dead at and after its embedded expiry', () => {
  const cap = mintArtifactCapability(KEY, 'flag_1', NOW + TTL);
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_1', NOW + TTL - 1), true);
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_1', NOW + TTL), false, 'expiry is exclusive');
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_1', NOW + TTL + 1), false);
});

test('a capability signed with a different key does not verify', () => {
  const cap = mintArtifactCapability(randomBytes(32), 'flag_1', NOW + TTL);
  assert.equal(verifyArtifactCapability(KEY, cap, 'flag_1', NOW), false);
});

test('malformed capabilities are refused, never thrown on', () => {
  for (const bad of ['', '.', 'nodot', 'abc.def', `${NOW + TTL}.`, `${NOW + TTL}.short`, 'x.y.z']) {
    assert.equal(verifyArtifactCapability(KEY, bad, 'flag_1', NOW), false, `"${bad}" should be refused`);
  }
});

test('the capability is not usable as a general credential — its shape is not a bearer token', () => {
  // A capability is `<expiry>.<sig>` and carries an id-bound signature; it is
  // meaningless to any route that expects the cockpit token, and to any flag id
  // other than the one it was minted for. This is the property #129 requires:
  // whatever grants artifact access must not be replayable against /api.
  const cap = mintArtifactCapability(KEY, 'flag_1', NOW + TTL);
  assert.match(cap, /^\d+\.[A-Za-z0-9_-]+$/);
  // Tampering with the expiry to extend it invalidates the signature.
  const [, sig] = cap.split('.');
  assert.equal(verifyArtifactCapability(KEY, `${NOW + TTL * 100}.${sig}`, 'flag_1', NOW), false);
});
