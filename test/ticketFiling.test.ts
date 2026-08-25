import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketFiler } from '../src/tickets/filing.js';
import { dedupeCandidates, renderCandidates } from '../src/tickets/candidates.js';
import type { ActionSink, IssueCreateInput, SendResult } from '../src/sink/actionSink.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import type { Config } from '../src/config.js';

/**
 * The harness filing a tracker item itself (issue #394).
 *
 * What is asserted here is the half a model used to be responsible for: which
 * type the item is created as, who it belongs to, and whether it is linked back to
 * anything. Each of those was a sentence in a prompt, and each could be dropped
 * without a single thing going red.
 */

function sinkRecording(created: IssueCreateInput[], ref: string | null = 'issue:314'): ActionSink {
  const unused = (): never => {
    throw new Error('not scripted in this test');
  };
  return {
    async createIssue(input): Promise<SendResult> {
      created.push(input);
      return ref === null ? { ok: true } : { ok: true, ref };
    },
    // A predicate rather than an act, so `unused` is the wrong shape: this test's
    // subject cannot reach it, and a throw would be a stub failing on a question.
    canCloseIssue: () => false,
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    requeueCiCheck: unused,
    postPrReply: unused,
    mergePr: unused,
    setPrLabel: unused,
    setIssueLabel: unused,
    setWorkItemState: unused,
    upsertIssueComment: unused,
    linkWorkItem: unused,
    createPullRequest: unused,
    setPullTitle: unused,
    setPullBase: unused,
    updatePrBranch: unused,
    deleteBranch: unused,
  };
}

function azure(extra: Partial<Config> = {}): Config {
  return {
    integrations: { issues: 'azure', sourceControl: 'azure' },
    azureDevOps: { organization: 'contoso', project: 'Platform', repository: 'api' },
    ...extra,
  } as unknown as Config;
}

test('the filer resolves the type, the assignee and the relation from config and the call', async () => {
  const created: IssueCreateInput[] = [];
  const file = ticketFiler(
    azure({ userId: 'adam@contoso.com', issueFilingTypes: ['Product Backlog Item', 'Bug'] }),
    sinkRecording(created),
  );

  assert.equal(await file({ title: 'Record the linter bump', body: 'It ran as job:j7.' }), 'issue:314');
  assert.deepEqual(created[0], {
    title: 'Record the linter bump',
    body: 'It ran as job:j7.',
    labels: [],
    type: 'Product Backlog Item',
    assignee: 'adam@contoso.com',
    relatedTo: null,
  });

  // A bug files at its own type and carries the link back to the story. Both are
  // facts about the *route the operator clicked*, which is why neither is an
  // argument an agent supplies.
  await file({ title: 'CSV export 404s', body: 'The symptom.', bug: true, relatedTo: 12 });
  assert.equal(created[1]!.type, 'Bug');
  assert.equal(created[1]!.relatedTo, 12);
});

test('a blueprint’s watch label rides on the create, and an empty one is not a label', async () => {
  const created: IssueCreateInput[] = [];
  const file = ticketFiler(azure(), sinkRecording(created));
  await file({ title: 'Build X', body: 'the request', labels: ['lubbdubb-watch'] });
  await file({ title: 'Build Y', body: 'the request', labels: [] });
  // The whole reason this arm stopped being an agent: a ticket without the watch
  // label is created, linked, shown complete — and never dispatched for.
  assert.deepEqual(created[0]!.labels, ['lubbdubb-watch']);
  assert.deepEqual(created[1]!.labels, []);
});

test('a create that says nothing about what it made is a failure, not an empty ref', async () => {
  const file = ticketFiler(azure(), sinkRecording([], null));
  // The one failure the seam cannot express as a throw. Returning `''` would write
  // an empty ref onto a filing row and read as a ticket forever after.
  await assert.rejects(() => file({ title: 't', body: 'b' }), /did not say what it created/);
});

// -- the dedupe shortlist -----------------------------------------------------

function ticket(number: number, title: string, state: 'open' | 'closed' = 'open'): MirroredTicket {
  return {
    number,
    title,
    labels: [],
    state,
    workItemState: null,
    url: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    changedAt: '2026-01-01T00:00:00.000Z',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    tracking: state === 'open' ? 'live' : 'frozen',
    issueType: null,
    parent: null,
    lastReadAt: null,
  };
}

test('candidates are ranked by shared terms, and an item sharing nothing is dropped', () => {
  const items = [
    ticket(1, 'The ingest API buffers the whole body before rejecting it'),
    ticket(2, 'Ingest buffering'),
    ticket(3, 'Rename the settings panel'),
  ];
  const found = dedupeCandidates(items, 'The ingest API buffers a 200MB body before rejecting it');
  assert.deepEqual(
    found.map((c) => c.number),
    [1, 2],
    'best overlap first; the unrelated one is not padded in',
  );

  // Stopwords separate nothing, so a subject made only of them shortlists nothing
  // rather than everything.
  assert.deepEqual(dedupeCandidates(items, 'the and for with'), []);
  assert.equal(dedupeCandidates(items, 'ingest', 1).length, 1, 'the limit is honoured');
});

test('a closed item is still a candidate — the mirror is the only place one is visible', () => {
  const found = dedupeCandidates([ticket(9, 'Ingest buffering', 'closed')], 'ingest buffering');
  assert.deepEqual(
    found.map((c) => c.state),
    ['closed'],
  );
  const block = renderCandidates(found)!;
  assert.match(block, /issue:9 \(closed\)/);
  // Never a verdict: title overlap finds items worth reading, and deciding two
  // reports are the same thing needs both bodies.
  assert.match(block, /neither exhaustive nor a verdict/);
});

test('nothing adjacent renders nothing, rather than an empty heading to interpret', () => {
  assert.equal(renderCandidates([]), null);
});
