import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchVerdict, DEFAULT_COOLDOWN, type CooldownPolicy } from '../src/dispatcher/dispatchCooldown.js';
import type { Decision } from '../src/types.js';

const POLICY: CooldownPolicy = { maxAttempts: 3, cooldownMs: 60_000 };

/** A dispatch decision for `origin`, executed at `createdAt`. */
function dispatched(origin: string, createdAt: string): Decision {
  return {
    id: `d_${createdAt}`,
    cycleId: 'c',
    outcome: 'executed',
    detail: '',
    rule: null,
    createdAt,
    action: { type: 'dispatch_code_agent', reason: 'r', originRef: origin },
  };
}

test('no prior attempts -> dispatch', () => {
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T00:00:00Z', [], POLICY);
  assert.equal(v.kind, 'dispatch');
});

test('a dispatch within the cooldown window -> cooldown', () => {
  const decisions = [dispatched('pr:1:mergeable', '2026-07-21T00:00:30Z')];
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T00:00:45Z', decisions, POLICY);
  assert.equal(v.kind, 'cooldown', '15s after a dispatch, still cooling down');
});

test('a dispatch older than the cooldown window -> dispatch again', () => {
  const decisions = [dispatched('pr:1:mergeable', '2026-07-21T00:00:00Z')];
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T00:02:00Z', decisions, POLICY);
  assert.equal(v.kind, 'dispatch', '2min later the cooldown has lapsed');
});

test('the attempt cap escalates instead of dispatching', () => {
  const decisions = [
    dispatched('pr:1:mergeable', '2026-07-21T00:00:00Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:20:00Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:40:00Z'),
  ];
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T01:00:00Z', decisions, POLICY);
  assert.equal(v.kind, 'escalate');
  assert.equal((v as { attempts: number }).attempts, 3);
});

test('once escalated for an origin, the cap holds silently (no re-escalation)', () => {
  const decisions: Decision[] = [
    dispatched('pr:1:mergeable', '2026-07-21T00:00:00Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:20:00Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:40:00Z'),
    {
      id: 'e1',
      cycleId: 'c',
      outcome: 'executed',
      detail: '',
      rule: null,
      createdAt: '2026-07-21T00:41:00Z',
      action: { type: 'escalate_to_human', reason: 'r', context: { originRef: 'pr:1:mergeable' } },
    },
  ];
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T01:00:00Z', decisions, POLICY);
  assert.equal(v.kind, 'hold');
});

test('deferred dispatches are not attempts (they never ran)', () => {
  const deferred: Decision = {
    id: 'd1',
    cycleId: 'c',
    outcome: 'deferred',
    detail: '',
    rule: null,
    createdAt: '2026-07-21T00:00:30Z',
    action: { type: 'dispatch_code_agent', reason: 'r', originRef: 'pr:1:mergeable' },
  };
  const v = dispatchVerdict('pr:1:mergeable', '2026-07-21T00:00:45Z', [deferred], POLICY);
  assert.equal(v.kind, 'dispatch', 'a deferred dispatch neither counts nor cools down');
});

test('cooldown and attempts are scoped to one origin', () => {
  const decisions = [
    dispatched('pr:1:mergeable', '2026-07-21T00:00:30Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:00:31Z'),
    dispatched('pr:1:mergeable', '2026-07-21T00:00:32Z'),
  ];
  // A different origin is unaffected by pr:1's spent attempts.
  const v = dispatchVerdict('pr:2:ci', '2026-07-21T00:00:45Z', decisions, POLICY);
  assert.equal(v.kind, 'dispatch');
});

test('defaults are bounded (three attempts, non-zero cooldown)', () => {
  assert.equal(DEFAULT_COOLDOWN.maxAttempts, 3);
  assert.ok(DEFAULT_COOLDOWN.cooldownMs > 0);
});
