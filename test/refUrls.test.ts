import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRefUrl } from '../src/integrations/github/refUrl.js';
import { buildRefUrls, decisionSubjectRef, issueCommentRef } from '../src/server/refUrls.js';

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

test('githubRefUrl: suffixed issue refs from the funnel resolve to the same issue page', () => {
  // `issue:13:plan` is both a planning agent's origin and a plan proposal's ref;
  // `issue:13:part:<slug>` is a part's. All three name one issue, like the PR shapes.
  assert.equal(githubRefUrl(O, R, 'issue:13:plan'), `${BASE}/issues/13`);
  assert.equal(githubRefUrl(O, R, 'issue:13:part:schema'), `${BASE}/issues/13`);
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
  assert.equal(githubRefUrl(O, R, 'epic:e1:groom'), null);
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

// --------------------------------------------------------------------------
// issueCommentRef — the wire shape for a comment the harness maintains (#171)
// --------------------------------------------------------------------------

test('issueCommentRef: pairs a provider comment id with the issue it lives on', () => {
  assert.equal(issueCommentRef('issue:12', '456'), 'issue:12:comment:456');
});

test('issueCommentRef: nothing written, nothing to link', () => {
  assert.equal(issueCommentRef('issue:12', null), null);
  assert.equal(issueCommentRef('issue:12', ''), null);
});

test('issueCommentRef: refuses an origin that is not an issue', () => {
  // Every caller has a plain `issue:<n>` origin; a suffixed or absent one would
  // name the wrong thing, and guessing is what turns a link into a wrong link.
  assert.equal(issueCommentRef('issue:12:plan', '456'), null);
  assert.equal(issueCommentRef('pr:12', '456'), null);
  assert.equal(issueCommentRef(null, '456'), null);
});

test('issueCommentRef: the ref it builds is the one githubRefUrl resolves', () => {
  // The pair is the whole point: the id alone reads as an *issue number* to the
  // resolver, so shipping one would key a confident link to an unrelated ticket.
  const ref = issueCommentRef('issue:12', '456')!;
  assert.equal(githubRefUrl(O, R, ref), `${BASE}/issues/12#issuecomment-456`);
  assert.equal(githubRefUrl(O, R, '456'), `${BASE}/issues/456`);
});

test('githubRefUrl: an issue comment resolves to its anchor on the issue page', () => {
  assert.equal(githubRefUrl(O, R, 'issue:13:comment:9001'), `${BASE}/issues/13#issuecomment-9001`);
});

test('githubRefUrl: a non-numeric comment id falls through to the issue page', () => {
  // Another provider's id, or the fake connector's `comment_1`: GitHub's anchor is
  // `#issuecomment-<numeric id>`, so an anchor built from one would scroll nowhere.
  assert.equal(githubRefUrl(O, R, 'issue:13:comment:comment_1'), `${BASE}/issues/13`);
});

test('buildRefUrls: keys a comment ref by itself, and omits it when unresolvable', () => {
  const resolve = (ref: string) => (ref === 'issue:12:comment:456' ? 'https://gh/issues/12#issuecomment-456' : null);
  const map = buildRefUrls({
    pullRequests: [],
    issues: [],
    taskBranches: [],
    refs: ['issue:12:comment:456', 'issue:99:comment:1', null],
    resolve,
  });
  assert.equal(map['issue:12:comment:456'], 'https://gh/issues/12#issuecomment-456');
  assert.equal(map['issue:99:comment:1'], undefined);
});

// --------------------------------------------------------------------------
// decisionSubjectRef — what an audited act is *about*
// --------------------------------------------------------------------------

test('decisionSubjectRef: each action names its subject in the vocabulary refUrls answers', () => {
  const ref = (action: Record<string, unknown>) => decisionSubjectRef(action as { type: string });

  assert.equal(ref({ type: 'dispatch_code_agent', originRef: 'issue:13:part:schema' }), 'issue:13:part:schema');
  assert.equal(ref({ type: 'dispatch_desk_agent', originRef: 'issue:13:plan' }), 'issue:13:plan');
  assert.equal(ref({ type: 'propose_plan', originRef: 'issue:13' }), 'issue:13');
  assert.equal(ref({ type: 'propose_shortfall', originRef: 'issue:13' }), 'issue:13');
  // A PR-numbered act is translated into the colon form rather than shipped as a
  // number: `#42` is the *other* key family, and `refUrls` keys both — but the
  // column reads a structured ref, so this is the one it can look up.
  assert.equal(ref({ type: 'reply_on_pr', prNumber: 42 }), 'pr:42');
  assert.equal(ref({ type: 'merge_pr', prNumber: 42 }), 'pr:42');
  assert.equal(ref({ type: 'set_work_item_state', number: 13 }), 'issue:13');
  assert.equal(ref({ type: 'respond_to_agent', originRefs: ['pr:42:comment:c1', 'pr:42:ci'] }), 'pr:42:comment:c1');
});

test('decisionSubjectRef: an act about nothing external has no ref, and never guesses one', () => {
  const ref = (action: Record<string, unknown>) => decisionSubjectRef(action as { type: string });

  assert.equal(ref({ type: 'escalate_to_human', agentId: 'agent-1' }), null);
  assert.equal(ref({ type: 'no_op' }), null);
  assert.equal(ref({ type: 'respond_to_agent', agentId: 'agent-1' }), null);
  // A dispatch composed outside a rule carries no origin — `originRef` defaults to
  // null in the schema, so this is the ordinary shape and not a malformed one.
  assert.equal(ref({ type: 'dispatch_code_agent', originRef: null }), null);
  // `number` is a work item on exactly one action type. The switch is what stops
  // it being read as one the day some other action grows a field by that name.
  assert.equal(ref({ type: 'merge_pr', number: 13 }), null);
  // An unknown type from an older or newer row: no ref, rather than a scan for
  // likely-looking fields that would key a confident link to the wrong thing.
  assert.equal(ref({ type: 'something_new', originRef: 'issue:13' }), null);
});
