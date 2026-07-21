import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { buildRefUrls } from '../src/server/refUrls.js';

// --------------------------------------------------------------------------
// githubRefUrl — the provider's canonical ref → URL mapping (pure)
// --------------------------------------------------------------------------

const O = 'octo';
const R = 'repo';
const BASE = `https://github.com/${O}/${R}`;

test('githubRefUrl: pr origin refs resolve to the PR page', () => {
  assert.equal(githubRefUrl(O, R, 'pr:42'), `${BASE}/pull/42`);
  assert.equal(githubRefUrl(O, R, 'pr:42:ci'), `${BASE}/pull/42`);
  assert.equal(githubRefUrl(O, R, 'pr:42:comment:c_abc'), `${BASE}/pull/42`);
});

test('githubRefUrl: issue origin ref resolves to the issue page', () => {
  assert.equal(githubRefUrl(O, R, 'issue:13'), `${BASE}/issues/13`);
});

test('githubRefUrl: a bare or #-prefixed number resolves to /issues (GitHub redirects PRs)', () => {
  assert.equal(githubRefUrl(O, R, '#7'), `${BASE}/issues/7`);
  assert.equal(githubRefUrl(O, R, '7'), `${BASE}/issues/7`);
});

test('githubRefUrl: a commit ref resolves to the commit page', () => {
  assert.equal(githubRefUrl(O, R, 'commit:deadbeef'), `${BASE}/commit/deadbeef`);
});

test('githubRefUrl: a branch name resolves to the branch tree', () => {
  assert.equal(githubRefUrl(O, R, 'issue/13'), `${BASE}/tree/issue/13`);
  assert.equal(githubRefUrl(O, R, 'feat/widget'), `${BASE}/tree/feat/widget`);
});

test('githubRefUrl: non-source-control origin refs are not links', () => {
  assert.equal(githubRefUrl(O, R, 'story:s1:groom'), null);
  assert.equal(githubRefUrl(O, R, 'meeting:m1:prep'), null);
  assert.equal(githubRefUrl(O, R, ''), null);
  assert.equal(githubRefUrl(O, R, '   '), null);
});

// --------------------------------------------------------------------------
// buildRefUrls — the snapshot's ref → URL map shipped to the cockpit (pure)
// --------------------------------------------------------------------------

test('buildRefUrls: keys each PR/issue number and prefers the item url over the resolver', () => {
  const map = buildRefUrls({
    pullRequests: [{ number: 42, branch: 'feat/x', url: 'https://item/pr/42' }],
    issues: [{ number: 13, url: 'https://item/issue/13', linkedPrNumber: null }],
    taskBranches: [],
    resolve: () => 'https://resolver/should-not-win',
  });
  assert.equal(map['#42'], 'https://item/pr/42');
  assert.equal(map['#13'], 'https://item/issue/13');
});

test('buildRefUrls: falls back to the resolver when an item carries no url', () => {
  const map = buildRefUrls({
    pullRequests: [{ number: 42, branch: 'feat/x' }],
    issues: [],
    taskBranches: [],
    resolve: (ref) => (ref === 'pr:42' ? 'https://resolved/pr/42' : null),
  });
  assert.equal(map['#42'], 'https://resolved/pr/42');
});

test('buildRefUrls: resolves PR and task branches to their own urls', () => {
  const map = buildRefUrls({
    pullRequests: [{ number: 42, branch: 'feat/x', url: 'u' }],
    issues: [],
    taskBranches: ['issue/13', null],
    resolve: (ref) => `https://branch/${ref}`,
  });
  assert.equal(map['feat/x'], 'https://branch/feat/x');
  assert.equal(map['issue/13'], 'https://branch/issue/13');
});

test('buildRefUrls: resolves an issue’s linked PR number', () => {
  const map = buildRefUrls({
    pullRequests: [],
    issues: [{ number: 13, url: 'u', linkedPrNumber: 55 }],
    taskBranches: [],
    resolve: (ref) => (ref === 'pr:55' ? 'https://resolved/pr/55' : null),
  });
  assert.equal(map['#55'], 'https://resolved/pr/55');
});

test('buildRefUrls: omits refs the resolver cannot map (e.g. the fake provider)', () => {
  const map = buildRefUrls({
    pullRequests: [{ number: 42, branch: 'feat/x' }],
    issues: [{ number: 13, linkedPrNumber: null }],
    taskBranches: ['issue/13'],
    resolve: () => null,
  });
  assert.deepEqual(map, {});
});
