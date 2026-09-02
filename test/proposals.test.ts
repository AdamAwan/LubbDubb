import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { replyToolNote, reviewRecheckNote, reviewThreadsNote } from '../src/dispatcher/reviewThreads.js';
import { remedyAskNote } from '../src/remedies/remedies.js';
import { WITNESS_INSTRUCTION } from '../src/scratch/pad.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { gitRepo } from './support/gitRepo.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/** A plan carrying a single merge_pr action — what rule `pr-merge-ready` emits for a settled PR. */
function mergePlan(prNumber = 42): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      { type: 'merge_pr', prNumber, method: 'squash', confidence: 0.9, reason: 'green, approved and mergeable' },
    ],
  } as unknown as DispatchResult;
}

/** A plan carrying a single reply_on_pr draft threaded on one comment. */
function draftPlan(prNumber: number, commentId: string): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber,
        commentId,
        draft: 'The current approach is deliberate.',
        confidence: 0.5,
        reason: 'reviewer asked a question',
      },
    ],
  } as unknown as DispatchResult;
}

/**
 * What rule `pr-review-comment` dispatches with before a rejection note is appended: the rendered
 * template, the threads themselves, and the re-check that follows them — all
 * appended rather than interpolated so an operator override cannot drop them.
 */
function reviewCommentPrompt(number: number, branch: string, comment: string, id = 'c1'): string {
  return (
    defaultPromptTemplates().render('pr-review-comment', { number, branch, author: 'reviewer', comment }) +
    reviewThreadsNote([{ id, author: 'reviewer', body: comment, handled: false }]) +
    reviewRecheckNote(number) +
    replyToolNote() +
    // Every append the rule makes, in its order — this fixture is only worth
    // anything while it mirrors that composition exactly. The prior-remedy note
    // is absent rather than forgotten: nothing has been accounted for in these
    // fixtures, and an empty record renders an empty string.
    remedyAskNote('review')
  );
}

/** A PR rule `pr-merge-ready` wants to merge: green, approved, mergeable, nothing else pending. */
function mergeReadyPr(system: ReturnType<typeof buildSystem>, number: number): void {
  system.connector.inject({
    kind: 'new_pr',
    number,
    title: 'Add the widget',
    branch: `feat/widget-${number}`,
    // Pull requests are opt-in: untagged, the harness never reaches these rules.
    labels: ['lubbdubb-watch'],
  });
  system.connector.inject({ kind: 'ci_passed', prNumber: number });
  system.connector.inject({ kind: 'pr_approved', prNumber: number });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: number, mergeable: true, mergeableState: 'clean' });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A sink that counts what actually went out, so "exactly once" is observable. */
function countingSink(fail = false): ActionSink & { merges: number[]; replies: number[] } {
  const merges: number[] = [];
  const replies: number[] = [];
  return {
    merges,
    replies,
    canCloseIssue: () => false,
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    async mergePr({ prNumber }) {
      merges.push(prNumber);
      if (fail) throw new Error('merge conflict');
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async postPrReply({ prNumber }) {
      replies.push(prNumber);
      if (fail) throw new Error('network down');
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async setPrLabel() {
      return { ok: true };
    },
    async setIssueLabel() {
      return { ok: true };
    },
    async setWorkItemState() {
      return { ok: true };
    },
    async linkWorkItem() {
      return { ok: true };
    },
    async createIssue() {
      return { ok: true as const, ref: 'issue:1' };
    },
    async upsertIssueComment() {
      return { ok: true };
    },
    async createPullRequest() {
      return { ok: true };
    },
    async setPullTitle() {
      return { ok: true };
    },
    async setPullBase() {
      return { ok: true };
    },
    async updatePrBranch() {
      return { ok: true };
    },
    async requeueCiCheck() {
      return { ok: true };
    },
    async deleteBranch() {
      return { ok: true };
    },
  };
}

test('a gated merge becomes a pending proposal, and accepting it merges — once', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  await system.executor.execute('cyc', mergePlan());

  const [proposal] = system.store.listProposals();
  assert.ok(proposal, 'the gated merge should be recorded as a proposal, not just an escalation');
  assert.equal(proposal.kind, 'merge');
  assert.equal(proposal.ref, 'pr:42:merge');
  assert.equal(proposal.status, 'pending');
  assert.equal(sink.merges.length, 0, 'nothing merges before a human says so');
  // It hangs off the inbox item rather than replacing it.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.type, 'approve_change');

  const accepted = await system.proposals.accept(proposal.id, 'looks good');
  assert.equal(accepted!.outcome, 'performed');
  assert.deepEqual(sink.merges, [42], 'accepting is what performs the act');
  assert.equal(system.store.getProposal(proposal.id)!.status, 'accepted');
  assert.equal(system.store.getProposal(proposal.id)!.decidedBy, 'human');
  // The inbox item is settled by the verdict, so "needs you" empties on the click.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.status, 'answered');
  // The human is named in the audit trail — the half of it that was missing.
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`);
  assert.match(audited!.detail, /Merged PR #42 via squash — authorized by you/);

  // Accepting twice posts once: the transition is one-way.
  assert.equal(await system.proposals.accept(proposal.id), null);
  assert.deepEqual(sink.merges, [42]);
  system.store.close();
});

test('a rejected proposal posts nothing and records the reason', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', mergePlan());
  const [proposal] = system.store.listProposals();

  const rejected = system.proposals.reject(proposal!.id, 'wait for the release branch');
  assert.equal(rejected!.outcome, 'none');
  assert.equal(sink.merges.length, 0, 'a rejection sends nothing');

  const stored = system.store.getProposal(proposal!.id)!;
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.note, 'wait for the release branch');
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal!.id}`);
  assert.match(audited!.detail, /Rejected by you: wait for the release branch/);
  assert.equal(system.store.getEscalation(proposal!.escalationId!)!.status, 'answered');
  // Rejecting twice is a no-op too — the transition is one-way in both directions.
  assert.equal(system.proposals.reject(proposal!.id), null);
  system.store.close();
});

test('an accepted act whose send fails re-escalates rather than dropping', async () => {
  const sink = countingSink(true);
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', mergePlan());
  const [proposal] = system.store.listProposals();

  const accepted = await system.proposals.accept(proposal!.id);
  assert.equal(accepted!.outcome, 'failed');
  assert.deepEqual(sink.merges, [42], 'it was attempted');

  // The original inbox item is answered (you did decide), and the failure is a
  // fresh one carrying the same fallback context the auto-send path uses.
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.context.autoMergeFailed, true);
  assert.match(open[0]!.prompt, /You approved merging PR #42, but the merge failed \(merge conflict\)/);
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal!.id}`);
  assert.equal(audited!.outcome, 'rejected');
  assert.match(audited!.detail, /escalated so it isn't dropped/);
  system.store.close();
});

test('a pending proposal suppresses re-proposal on the next cycle', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  // A PR rule `pr-merge-ready` wants to merge: green, approved, mergeable, nothing else pending.
  system.connector.inject({
    kind: 'new_pr',
    number: 7,
    title: 'Add the widget',
    branch: 'feat/widget',
    labels: ['lubbdubb-watch'],
  });
  system.connector.inject({ kind: 'ci_passed', prNumber: 7 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 7 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 7, mergeable: true, mergeableState: 'clean' });

  await system.harness.runCycle('manual');
  const first = system.store.listProposals();
  assert.equal(first.length, 1, 'rule `pr-merge-ready` should propose the merge once');
  assert.equal(first[0]!.ref, 'pr:7:merge');
  const escalationsAfterOne = system.store.listOpenEscalations().length;

  // The world has not changed and the human has not answered: asking again would
  // fill the inbox with copies of one question.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1, 'the pending verdict holds rule `pr-merge-ready` off that PR');
  assert.equal(system.store.listOpenEscalations().length, escalationsAfterOne);

  // A rejection is durable for the same reason: "no" must not mean "not this second".
  system.proposals.reject(first[0]!.id, 'not yet');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1);
  assert.equal(sink.merges.length, 0);
  system.store.close();
});

test('a rejection stands while nothing happens to the PR, and stops standing when something does', async () => {
  // Paused, so the CI signal below moves the world without also putting an agent
  // on the branch: this is about the verdict, not about dispatch. `merge_pr`
  // claims no headroom, so rule `pr-merge-ready` is unaffected by the pause.
  const sink = countingSink();
  const system = buildSystem(testConfig({ startPaused: true }), { backend: new FakePtyBackend(), sink });
  mergeReadyPr(system, 7);

  await system.harness.runCycle('manual');
  const proposal = system.store.listProposals()[0]!;
  assert.equal(proposal.ref, 'pr:7:merge');
  system.proposals.reject(proposal.id, 'needs one more commit');

  // Durable is still durable. Nothing has happened to PR #7, so the answer to the
  // question has not changed and the question is not asked again — for as many
  // pulses as you like.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1, 'a "no" is not re-asked every heartbeat');
  assert.equal(sink.merges.length, 0);

  // The world moves: CI goes red and then green again — the commit landed.
  // `world_events` timestamps to the millisecond, and the expiry is strictly
  // after the verdict, so the clock has to actually advance between the two.
  await sleep(5);
  system.connector.inject({ kind: 'ci_failed', prNumber: 7 });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1, 'a red PR is not merge-ready — the rule still says no');

  system.connector.inject({ kind: 'ci_passed', prNumber: 7 });
  await system.harness.runCycle('manual');
  const proposals = system.store.listProposals();
  assert.equal(proposals.length, 2, 'the verdict was about a PR that has since changed — so it is asked again');
  assert.equal(proposals[0]!.status, 'pending');
  assert.equal(proposals[1]!.id, proposal.id, 'the rejection is not retracted, only overtaken');
  // The re-ask says why it is being asked twice, or it reads as the harness
  // having forgotten the first answer.
  const esc = system.store.getEscalation(proposals[0]!.escalationId!)!;
  assert.match(esc.prompt, /You rejected this on .* — "needs one more commit"\. Since then: PR #7 CI passing\./);

  // Once, not once per pulse: the fresh pending verdict is what holds the rule
  // now, so the expiry cannot turn into the duplicate flood it was avoiding.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 2);
  assert.equal(sink.merges.length, 0, 'and still nothing has been merged without you');
  system.store.close();
});

test("a rejection reaches the next agent on that ref, in the operator's own words", async () => {
  const system = buildSystem(
    // Off, so a draft is put to the operator and there is something for them to
    // refuse — this test is about what a refusal carries, not about who authorized.
    testConfig({
      repoRoot: gitRepo(),
      agentMode: 'raw',
      maxConcurrentAgents: 4,
      sendPrRepliesWithoutApproval: false,
    }),
    {
      backend: new FakePtyBackend(),
      sink: countingSink(),
      errorMirror: () => {},
    },
  );
  const commented = async (number: number, branch: string, body: string): Promise<string> => {
    system.connector.inject({ kind: 'new_pr', number, title: `PR ${number}`, branch, labels: ['lubbdubb-watch'] });
    system.connector.inject({ kind: 'pr_comment', prNumber: number, author: 'reviewer', body });
    const world = await system.connector.getState();
    return world.pullRequests.find((p) => p.number === number)!.unresolvedComments[0]!.id;
  };
  // Two PRs with a review comment each. A draft is proposed for both and refused
  // for both — one with a reason, one with nothing typed.
  const withNote = await commented(1, 'feat/one', 'This looks over-engineered.');
  const withoutNote = await commented(2, 'feat/two', 'Same question here.');
  await system.executor.execute('cyc', draftPlan(1, withNote));
  await system.executor.execute('cyc', draftPlan(2, withoutNote));
  const [second, first] = system.store.listProposals();
  system.proposals.reject(first!.id, 'too defensive — just fix the lint');
  system.proposals.reject(second!.id, '   ');

  await system.harness.runCycle('manual');
  const tasks = new Map(system.store.listTasks().map((t) => [t.originRef, system.store.getTask(t.id)!]));

  // The reason a human typed reaches the agent that goes to work on that exact
  // comment — attributed to them, never as the harness's own instruction. The
  // dispatch origin names the PR's whole review, so the match is on the thread ref
  // the dispatch *carries*: still an exact ref, never the world item.
  const told = tasks.get('pr:1:comments')!;
  assert.match(told.prompt, /An operator refused a reply the harness proposed for this exact item/);
  assert.match(told.prompt, /operator's own words, quoted verbatim/);
  assert.match(told.prompt, /"too defensive — just fix the lint"/);
  // Appended to the rendered template rather than filled into it, so an operator
  // override that never heard of the feature cannot drop it.
  assert.ok(told.prompt.startsWith(reviewCommentPrompt(1, 'feat/one', 'This looks over-engineered.', withNote)));

  // An empty note changes the prompt not at all: there is nothing to pass on, and
  // a placeholder saying so would only invite the agent to speculate. What follows
  // the template is the witness log's standing instruction, which every code
  // dispatch carries whether or not anything was refused.
  const untold = tasks.get('pr:2:comments')!;
  assert.equal(
    untold.prompt,
    `${reviewCommentPrompt(2, 'feat/two', 'Same question here.', withoutNote)}\n\n${WITNESS_INSTRUCTION}`,
  );
  system.store.close();
});

test('the executor refuses a duplicate proposal even when the dispatcher gate is bypassed', async () => {
  // The executor is reached by acts a rule never proposed (an accepted proposal
  // re-running, an injected plan), so the rule-side gate cannot be the only one.
  // Two identical plans through the executor must ask once.
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  await system.executor.execute('cyc-1', mergePlan());
  await system.executor.execute('cyc-2', mergePlan());

  assert.equal(system.store.listProposals().length, 1);
  assert.equal(system.store.listOpenEscalations().length, 1);
  const skipped = system.store.listDecisions().find((d) => d.outcome === 'skipped' && d.action.type === 'merge_pr');
  assert.match(skipped!.detail, /Skipped merge of PR #42: awaiting your accept\/reject/);
  system.store.close();
});

test('a drafted reply is proposed, and accepting it sends that draft', async () => {
  const sink = countingSink();
  // Off, or the reply is authorized on the way through and there is no pending
  // proposal to accept — this test is about the accept, so it asks for the ask.
  const system = buildSystem(testConfig({ sendPrRepliesWithoutApproval: false }), {
    backend: new FakePtyBackend(),
    sink,
  });
  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber: 42,
        commentId: 'c-1',
        draft: 'Addressed in the latest commit.',
        confidence: 0.5,
        reason: 'reviewer asked a question',
      },
    ],
  } as unknown as DispatchResult;

  await system.executor.execute('cyc', plan);
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.kind, 'reply_draft');
  assert.equal(proposal!.ref, 'pr:42:comment:c-1', 'a threaded draft keys on the comment it answers');

  await system.proposals.accept(proposal!.id);
  assert.deepEqual(sink.replies, [42]);
  system.store.close();
});

test('a database created before proposals existed opens and works after them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-migrate-'));
  const dbPath = join(dir, 'old.db');
  // An older build's database: every table this one has except `proposals`.
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE escalations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
      context TEXT NOT NULL, agent_id TEXT, task_id TEXT, response TEXT,
      created_at TEXT NOT NULL, answered_at TEXT);
    INSERT INTO escalations VALUES ('esc_old','approve_change','open','merge?','{}',NULL,NULL,NULL,'2026-01-01T00:00:00Z',NULL);`);
  old.close();

  const store = new Store(dbPath);
  // The pre-existing row still reads, and the new table is there to write to.
  assert.equal(store.listOpenEscalations().length, 1);
  const proposal = store.createProposal({
    kind: 'merge',
    ref: 'pr:1:merge',
    action: { type: 'merge_pr', reason: 'test', prNumber: 1, method: 'squash' },
    escalationId: 'esc_old',
  });
  assert.equal(store.listProposals().length, 1);
  assert.equal(store.decideProposal(proposal.id, 'accepted', null, 'human')!.status, 'accepted');
  store.close();
});
