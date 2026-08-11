import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateParents,
  containerPickupReason,
  isContainerIssue,
  isOrphanIssue,
  relatedWorkNote,
  DEFAULT_CONTAINER_TYPES,
} from '../src/issueRelations.js';
import { isIssuePickupEligible, issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import type { IssuePickupContext, IssuePickupPolicy } from '../src/dispatcher/issuePickup.js';
import { hierarchyIds } from '../src/integrations/azure/restAzureDevOpsApi.js';
import { AzureDevOpsWorkItemsIntegration } from '../src/integrations/azure/workItems.js';
import type { AzWorkItem, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { Issue, IssueRelative } from '../src/types.js';

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i', number: 1, title: 'X', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
}

function relative(over: Partial<IssueRelative> = {}): IssueRelative {
  return { number: 9, title: 'R', issueType: 'User Story', workItemState: 'Active', state: 'open', ...over };
}

const POLICY: IssuePickupPolicy = {
  priorityLabels: {},
  defaultPriority: 0,
  containerTypes: [...DEFAULT_CONTAINER_TYPES],
};

// --------------------------------------------------------------------------
// Container types
// --------------------------------------------------------------------------

test('isContainerIssue matches the configured types case-insensitively', () => {
  assert.equal(isContainerIssue(issue({ issueType: 'Feature' }), ['Feature']), true);
  assert.equal(isContainerIssue(issue({ issueType: 'feature' }), ['Feature']), true);
  assert.equal(isContainerIssue(issue({ issueType: 'Epic' }), DEFAULT_CONTAINER_TYPES), true);
  assert.equal(isContainerIssue(issue({ issueType: 'Bug' }), DEFAULT_CONTAINER_TYPES), false);
});

/** The whole GitHub path: no item type means no type gate, whatever the config says. */
test('an issue with no type is never a container', () => {
  assert.equal(isContainerIssue(issue(), DEFAULT_CONTAINER_TYPES), false);
  assert.equal(containerPickupReason(issue(), DEFAULT_CONTAINER_TYPES), null);
});

test('an empty container list turns the gate off', () => {
  assert.equal(isContainerIssue(issue({ issueType: 'Feature' }), []), false);
});

test('containerPickupReason names the children as the work instead', () => {
  const feature = issue({
    issueType: 'Feature',
    children: [relative({ number: 2 }), relative({ number: 3, state: 'closed', workItemState: 'Closed' })],
  });
  assert.equal(
    containerPickupReason(feature, DEFAULT_CONTAINER_TYPES),
    'Feature is a container — work its 2 child items (1 still open)',
  );
});

test('containerPickupReason says so when a container has nothing under it', () => {
  assert.equal(
    containerPickupReason(issue({ issueType: 'Feature', children: [] }), DEFAULT_CONTAINER_TYPES),
    'Feature is a container — it has no children to work',
  );
});

// --------------------------------------------------------------------------
// The pickup gate
// --------------------------------------------------------------------------

test('a Feature is never eligible for pickup, whatever its tags and state say', () => {
  const policy: IssuePickupPolicy = { ...POLICY, watchLabel: 'lubbdubb-watch', pickupStates: ['Active'] };
  const feature = issue({
    issueType: 'Feature',
    workItemState: 'Active',
    labels: ['lubbdubb-watch'],
    children: [relative()],
  });
  assert.deepEqual(isIssuePickupEligible(feature, policy), {
    eligible: false,
    reasons: ['Feature is a container — work its 1 child item (1 still open)'],
  });
});

test('a story under the same policy is unaffected by the type gate', () => {
  const policy: IssuePickupPolicy = { ...POLICY, watchLabel: 'lubbdubb-watch', pickupStates: ['Active'] };
  const story = issue({
    issueType: 'User Story',
    workItemState: 'Active',
    labels: ['lubbdubb-watch'],
    parent: relative({ number: 7, issueType: 'Feature' }),
  });
  assert.equal(isIssuePickupEligible(story, policy).eligible, true);
});

/**
 * The chip has its own arm because tagging a Feature is not the fix — reporting
 * it as `unwatched` would point the operator at the one control that can't help.
 */
test('issuePickupStatus reports a container as `container`, not `unwatched`', () => {
  const ctx: IssuePickupContext = {
    policy: { ...POLICY, watchLabel: 'lubbdubb-watch' },
    cooldown: { cooldownMs: 0, maxAttempts: 3 },
    now: '2026-01-01T00:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    openPrs: [],
    headroom: 1,
    paused: false,
  };
  const verdict = issuePickupStatus(issue({ issueType: 'Feature', children: [relative()] }), ctx);
  assert.equal(verdict.status, 'container');
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reasons[0] ?? '', /container/);
});

// --------------------------------------------------------------------------
// Orphans
// --------------------------------------------------------------------------

test('a parentless story is an orphan; one with a parent is not', () => {
  assert.equal(isOrphanIssue(issue({ issueType: 'User Story', parent: null }), DEFAULT_CONTAINER_TYPES), true);
  assert.equal(isOrphanIssue(issue({ issueType: 'Bug', parent: null }), DEFAULT_CONTAINER_TYPES), true);
  assert.equal(isOrphanIssue(issue({ issueType: 'User Story', parent: relative() }), DEFAULT_CONTAINER_TYPES), false);
});

/** `undefined` is "the tracker has no hierarchy", which is every GitHub issue. */
test('an issue from a tracker without hierarchy is never an orphan', () => {
  assert.equal(isOrphanIssue(issue(), DEFAULT_CONTAINER_TYPES), false);
  assert.equal(isOrphanIssue(issue({ issueType: 'Bug' }), DEFAULT_CONTAINER_TYPES), false);
});

test('a Feature at the top of the tree is not an orphan, and nor is a Task', () => {
  assert.equal(isOrphanIssue(issue({ issueType: 'Feature', parent: null }), DEFAULT_CONTAINER_TYPES), false);
  assert.equal(isOrphanIssue(issue({ issueType: 'Task', parent: null }), DEFAULT_CONTAINER_TYPES), false);
});

// --------------------------------------------------------------------------
// The appended note
// --------------------------------------------------------------------------

test('relatedWorkNote is empty for an issue with no relations at all', () => {
  assert.equal(relatedWorkNote(issue()), '');
  assert.equal(relatedWorkNote(issue({ issueType: 'Bug' })), '');
});

test('the note carries the parent feature and its description as the goal', () => {
  const note = relatedWorkNote(
    issue({
      issueType: 'User Story',
      parent: relative({ number: 12, title: 'Checkout revamp', issueType: 'Feature', body: 'One-page checkout.' }),
    }),
  );
  assert.match(note, /belongs to Feature #12 "Checkout revamp" \(Active\)/);
  assert.match(note, /One-page checkout\./);
});

test('a parent with no description is reported as such rather than passed over', () => {
  const note = relatedWorkNote(issue({ issueType: 'Bug', parent: relative({ issueType: 'Feature', body: '  ' }) }));
  assert.match(note, /carries no description/);
});

test('siblings are listed with their states and marked as other scope', () => {
  const note = relatedWorkNote(
    issue({
      issueType: 'User Story',
      parent: relative({ number: 12, issueType: 'Feature' }),
      siblings: [relative({ number: 13, title: 'Address form', workItemState: 'Closed', state: 'closed' })],
    }),
  );
  assert.match(note, /- User Story #13 "Address form" \(Closed\)/);
  assert.match(note, /other people's scope/);
});

test('an orphan is told so, and told not to invent a parent', () => {
  const note = relatedWorkNote(issue({ issueType: 'Bug', parent: null }), DEFAULT_CONTAINER_TYPES);
  assert.match(note, /no parent feature/);
  assert.match(note, /Do not invent a parent/);
});

test('an orphan is offered the open features it might belong to, as a suggestion only', () => {
  const candidates = [
    relative({ number: 12, title: 'Checkout revamp', issueType: 'Feature' }),
    relative({ number: 20, title: 'Billing', issueType: 'Feature' }),
  ];
  const note = relatedWorkNote(issue({ issueType: 'Bug', parent: null }), DEFAULT_CONTAINER_TYPES, candidates);
  assert.match(note, /Open features it might belong to:/);
  assert.match(note, /- Feature #12 "Checkout revamp"/);
  assert.match(note, /- Feature #20 "Billing"/);
  // The harness reads the hierarchy and never writes it.
  assert.match(note, /do not link, re-parent or edit any work item yourself/);
});

/** The suggestion is the orphan's alone — beside a parented item it invites re-filing. */
test('an item that already has a parent is offered no candidates', () => {
  const note = relatedWorkNote(
    issue({ issueType: 'Bug', parent: relative({ number: 12, issueType: 'Feature' }) }),
    DEFAULT_CONTAINER_TYPES,
    [relative({ number: 20, issueType: 'Feature' })],
  );
  assert.doesNotMatch(note, /might belong to/);
});

test('candidateParents collects containers in the world and the parents of other items', () => {
  const world = [
    issue({ number: 12, title: 'Checkout revamp', issueType: 'Feature', workItemState: 'Active', children: [] }),
    issue({ number: 30, issueType: 'Bug', parent: relative({ number: 20, title: 'Billing', issueType: 'Feature' }) }),
    issue({ number: 31, issueType: 'Bug', parent: null }),
  ];
  assert.deepEqual(
    candidateParents(world, DEFAULT_CONTAINER_TYPES).map((c) => c.number),
    [12, 20],
  );
});

test('candidateParents drops closed features and de-duplicates', () => {
  const shared = relative({ number: 20, issueType: 'Feature' });
  const world = [
    issue({ number: 13, issueType: 'Feature', state: 'closed' }),
    issue({ number: 30, issueType: 'Bug', parent: shared }),
    issue({ number: 31, issueType: 'Bug', parent: shared }),
    issue({
      number: 32,
      issueType: 'Bug',
      parent: relative({ number: 21, issueType: 'Feature', state: 'closed', workItemState: 'Closed' }),
    }),
  ];
  assert.deepEqual(
    candidateParents(world, DEFAULT_CONTAINER_TYPES).map((c) => c.number),
    [20],
  );
});

/** A flat tracker offers nothing, so the orphan branch never draws on the GitHub path. */
test('candidateParents is empty for a world with no hierarchy', () => {
  assert.deepEqual(candidateParents([issue({ number: 1 }), issue({ number: 2 })], DEFAULT_CONTAINER_TYPES), []);
});

test('a candidate feature never carries its description into the list', () => {
  const world = [issue({ number: 30, issueType: 'Bug', parent: relative({ number: 20, body: 'long goal text' }) })];
  assert.equal(candidateParents(world, DEFAULT_CONTAINER_TYPES)[0]?.body, undefined);
});

test('a long parent description is truncated rather than shipped whole', () => {
  const note = relatedWorkNote(issue({ issueType: 'Bug', parent: relative({ body: 'x'.repeat(9000) }) }));
  assert.match(note, /…\(truncated\)/);
  assert.ok(note.length < 6000, 'the note must not carry a whole feature document');
});

// --------------------------------------------------------------------------
// Reading the hierarchy off Azure DevOps
// --------------------------------------------------------------------------

test('hierarchyIds reads the related work-item ids out of relation urls', () => {
  const relations = [
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/o/_apis/wit/workItems/12' },
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/o/_apis/wit/workItems/13' },
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/o/_apis/wit/workItems/14' },
    { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p%2Fr%2F55' },
  ];
  assert.deepEqual(hierarchyIds(relations, 'System.LinkTypes.Hierarchy-Reverse'), [12]);
  assert.deepEqual(hierarchyIds(relations, 'System.LinkTypes.Hierarchy-Forward'), [13, 14]);
  assert.deepEqual(hierarchyIds(undefined, 'System.LinkTypes.Hierarchy-Reverse'), []);
});

function workItem(over: Partial<AzWorkItem> = {}): AzWorkItem {
  return {
    id: 101,
    title: 'W',
    body: '',
    state: 'Active',
    workItemType: 'User Story',
    tags: [],
    relationUrls: [],
    parentId: null,
    childIds: [],
    url: 'https://dev.azure.com/o/p/_workitems/edit/101',
    ...over,
  };
}

/** A minimal `AzureDevOpsApi` — only the two reads the work-items snapshot makes. */
function relationApi(
  listed: AzWorkItem[],
  pool: AzWorkItem[],
  reads: number[][],
  opts: { failReads?: boolean } = {},
): AzureDevOpsApi {
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  return {
    async listOpenWorkItems() {
      return listed;
    },
    async getWorkItems(ids) {
      reads.push([...ids]);
      if (opts.failReads) throw new Error('batch read exploded');
      const all = [...listed, ...pool];
      return ids.map((id) => all.find((w) => w.id === id)).filter((w): w is AzWorkItem => w !== undefined);
    },
    viewerUniqueName: unused,
    listActivePullRequests: unused,
    listRecentlyClosedPullRequests: unused,
    listPullThreads: unused,
    listPolicyEvaluations: unused,
    listPullLabels: unused,
    listWorkItemUpdates: unused,
    createThreadReply: unused,
    createThread: unused,
    completePullRequest: unused,
    setPullLabel: unused,
    setWorkItemState: unused,
    createWorkItemComment: unused,
    updateWorkItemComment: unused,
    setWorkItemTag: unused,
    createPull: unused,
    setPullTitle: unused,
    setPullBase: unused,
    deleteBranch: unused,
  };
}

test('the work-items snapshot hydrates parent, children and siblings', async () => {
  const reads: number[][] = [];
  const story = workItem({ id: 101, title: 'Cart totals', parentId: 12 });
  const feature = workItem({
    id: 12,
    title: 'Checkout revamp',
    workItemType: 'Feature',
    body: 'One-page checkout.',
    childIds: [101, 102],
  });
  const sibling = workItem({ id: 102, title: 'Address form', state: 'Closed' });
  const api = relationApi([story], [feature, sibling], reads);
  const { issues = [] } = await new AzureDevOpsWorkItemsIntegration({ api }).snapshot();

  assert.equal(issues.length, 1);
  const [i] = issues;
  assert.equal(i?.issueType, 'User Story');
  assert.equal(i?.parent?.number, 12);
  // The parent's description rides along — it is the goal the story serves.
  assert.equal(i?.parent?.body, 'One-page checkout.');
  assert.deepEqual(
    i?.siblings?.map((s) => [s.number, s.state]),
    [[102, 'closed']],
  );
  assert.deepEqual(i?.children, []);
  // Two rounds: the parent first, then the parent's other children.
  assert.deepEqual(reads, [[12], [102]]);
});

test('a parentless work item reports `null` — the orphan the note reports on', async () => {
  const reads: number[][] = [];
  const api = relationApi([workItem({ id: 101, workItemType: 'Bug' })], [], reads);
  const { issues = [] } = await new AzureDevOpsWorkItemsIntegration({ api }).snapshot();
  assert.equal(issues[0]?.parent, null);
  assert.equal(isOrphanIssue(issues[0]!, DEFAULT_CONTAINER_TYPES), true);
  // Nothing to fetch, so no request was made at all.
  assert.deepEqual(reads, []);
});

/**
 * A link the identity cannot read must not be reported as *no* link: that would
 * make an unreadable parent indistinguishable from a missing one, and the note
 * would tell the agent to work an orphan that isn't one.
 */
test('an unreadable parent leaves the relation unknown rather than claiming there is none', async () => {
  const reads: number[][] = [];
  const api = relationApi([workItem({ id: 101, workItemType: 'Bug', parentId: 999 })], [], reads);
  const { issues = [] } = await new AzureDevOpsWorkItemsIntegration({ api }).snapshot();
  assert.equal(issues[0]?.parent, undefined);
  assert.equal(isOrphanIssue(issues[0]!, DEFAULT_CONTAINER_TYPES), false);
});

test('a hydration failure is recorded and costs the relations, not the snapshot', async () => {
  const recorded: string[] = [];
  const api = relationApi([workItem({ id: 101, parentId: 12 })], [], [], { failReads: true });
  const integration = new AzureDevOpsWorkItemsIntegration({
    api,
    errors: {
      record: (e) => {
        recorded.push(e.message);
        return { id: 'e', createdAt: '', source: e.source, message: e.message, detail: null };
      },
    },
  });
  const { issues = [] } = await integration.snapshot();
  assert.equal(issues.length, 1, 'the world still has its issue');
  assert.equal(issues[0]?.parent, undefined);
  assert.equal(issues[0]?.issueType, 'User Story');
  assert.match(recorded[0] ?? '', /relation hydration failed/);
});

test('a Feature in the snapshot carries its stories as children', async () => {
  const reads: number[][] = [];
  const feature = workItem({ id: 12, workItemType: 'Feature', childIds: [101] });
  const story = workItem({ id: 101, title: 'Cart totals', parentId: 12 });
  const api = relationApi([feature], [story], reads);
  const { issues = [] } = await new AzureDevOpsWorkItemsIntegration({ api }).snapshot();
  assert.deepEqual(
    issues[0]?.children?.map((c) => c.number),
    [101],
  );
  assert.equal(containerPickupReason(issues[0]!, DEFAULT_CONTAINER_TYPES) !== null, true);
});
