import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromText, loadConfig, projectConfigLayer } from '../src/config.js';

/**
 * The identity split, and the promise that it needs no migration.
 *
 * `userId` used to be both halves at once: who the harness is *and* whether the
 * world is narrowed to them. Splitting the second half out as `ownWorkOnly` is the
 * kind of change that silently re-points a fleet on the boot somebody takes the
 * build — a deployment that quietly stops filtering starts surfacing everyone's
 * pull requests and picking up anyone's tags, and nothing anywhere goes red.
 *
 * The migration is the **default**, not a rewrite: `ownWorkOnly` defaults to
 * `true`, so a file that never mentions it means exactly what it meant before, and
 * no operator's config is edited to say so. These tests are that claim, held
 * against the old file rather than asserted in a comment — because "we chose a
 * default that makes this a no-op" is only true while the default says so.
 */

function fileWith(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-own-'));
  const path = join(dir, 'lubbdubb.config.json');
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test('a config file written before the split still means what it meant', () => {
  // Exactly what an existing operator has: an identity, and no opinion about
  // filtering because there was nothing to have an opinion with.
  const before = loadConfigFromText(
    JSON.stringify({ userId: 'adamawan', integrations: { sourceControl: 'github', issues: 'github' } }),
    fileWith({}),
  );
  assert.equal(before.userId, 'adamawan');
  assert.equal(before.ownWorkOnly, true, 'an absent key must keep the gates it used to imply');

  // And the other existing shape: no identity at all, which used to mean the
  // gates were off. It still does — a filter needs somebody to filter to.
  const anonymous = loadConfigFromText(JSON.stringify({}), fileWith({}));
  assert.equal(anonymous.userId, undefined);
  assert.equal(anonymous.ownWorkOnly, true);
});

test('the two halves are read together, so neither alone filters anything', () => {
  // The composite the providers and the dispatcher both read. Stated here as the
  // truth table rather than reached through `buildSystem`, so a change to either
  // key's meaning fails on the rule rather than on a provider's wiring.
  const narrows = (over: Parameters<typeof loadConfig>[0]) => {
    const config = loadConfig({ dbPath: ':memory:', ...over });
    return config.ownWorkOnly && config.userId !== undefined;
  };
  assert.equal(narrows({ userId: 'adamawan' }), true, 'the pre-split posture');
  assert.equal(narrows({}), false, 'no identity, nothing to narrow to');
  assert.equal(narrows({ userId: 'adamawan', ownWorkOnly: false }), false, 'the new escape hatch');
  assert.equal(narrows({ ownWorkOnly: false }), false);
});

test('the policy belongs to the project layer and the identity to the operator’s', () => {
  // The whole point of the split: a team states whether the project filters by
  // owner without knowing any member's login, and each member states who they are
  // without being asked to restate the policy.
  const repoRoot = mkdtempSync(join(tmpdir(), 'lubbdubb-project-'));
  writeFileSync(join(repoRoot, 'lubbdubb.project.json'), JSON.stringify({ ownWorkOnly: false, labelPrefix: 'acme' }));

  const layer = projectConfigLayer(join(repoRoot, 'lubbdubb.project.json'));
  assert.equal(layer.ownWorkOnly, false);
  assert.equal(layer.userId, undefined, 'a shared file must never carry one person’s identity');

  const merged = loadConfigFromText(
    JSON.stringify({ repoRoot, userId: 'adamawan' }),
    join(repoRoot, 'lubbdubb.config.json'),
  );
  assert.equal(merged.userId, 'adamawan', 'the operator’s own file says who they are');
  assert.equal(merged.ownWorkOnly, false, 'and the team’s file says whether that narrows anything');
  assert.equal(merged.labelPrefix, 'acme');
});
