import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromText, loadConfig, projectConfigLayer } from '../src/config.js';

function fileWith(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-own-'));
  const path = join(dir, 'lubbdubb.config.json');
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test('a config file written before the split still means what it meant', () => {
  const before = loadConfigFromText(
    JSON.stringify({ userId: 'adamawan', integrations: { sourceControl: 'github', issues: 'github' } }),
    fileWith({}),
  );
  assert.equal(before.userId, 'adamawan');
  assert.equal(before.ownWorkOnly, true, 'an absent key must keep the gates it used to imply');

  const anonymous = loadConfigFromText(JSON.stringify({}), fileWith({}));
  assert.equal(anonymous.userId, undefined);
  assert.equal(anonymous.ownWorkOnly, true);
});

test('the two halves are read together, so neither alone filters anything', () => {
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
