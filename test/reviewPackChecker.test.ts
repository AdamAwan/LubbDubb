import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { applyCheck } from '../src/reviewPacks/check.js';
import { checkLeaseHead, checkLeaseKey, checkOrigin, checkTargetPr, packOrigin } from '../src/reviewPacks/origins.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import type { Agent, ReviewPack } from '../src/types.js';
import type { ReviewPackPayload } from '../src/wire.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { findTask } from './support/tasks.js';

/**
 * Review packs, stage 4: the checker — follows the author onto the pack it
 * wrote, on a read-only checkout of the same head, handed the skeleton and not
 * the story, and merges verdicts back through `review_pack_check`, which can
 * reach nothing else in the document. → docs/spec/31-review-packs.md#the-check
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' import x from "x";',
  '+import y from "y";',
  ' ',
  ' export const a = 1;',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 3333333..4444444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +9,0 @@ const gone = 1;',
  '-const old = 2;',
  '',
].join('\n');

interface ToolResultText {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function build(): { system: System; worktrees: FakeWorktreeManager; reaps: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-check-'));
  const worktrees = new FakeWorktreeManager();
  const reaps: number[] = [];
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    {
      worktrees,
      gitObserver: new FakeGitObserver().setDiff('main', HEAD, DIFF),
      backend: new FakePtyBackend(),
      errorMirror: () => {},
      reapProcessTree: async (pid) => {
        reaps.push(pid);
      },
    },
  );
  return { system, worktrees, reaps };
}

async function call(system: System, agent: Agent, tool: string, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call(tool, args)) as ToolResultText;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

function agentOn(system: System, originRef: string): Agent | undefined {
  const task = findTask(system.store, (t) => t.originRef === originRef);
  return task ? system.store.listAgents().find((a) => a.taskId === task.id) : undefined;
}

/** Ask for a pack, have the author submit one — h1 with two claims, plumbing with one — and finish the author. */
async function authored(system: System): Promise<{ author: Agent; pack: ReviewPack }> {
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(res.statusCode, 202, res.body);
  await app.close();
  await system.reviewPacks.whenIdle();
  const author = agentOn(system, packOrigin(7));
  assert.ok(author, 'the author was spawned');
  mkdirSync(join(author!.cwd, 'src'), { recursive: true });
  writeFileSync(join(author!.cwd, 'src/unchanged.ts'), 'line one\nline two\nline three\n');
  const submitted = await call(system, author!, 'review_pack_submit', {
    headline: 'The module imports y.',
    summary: '**The import is the point.**',
    estimatedMinutes: 2,
    ideas: [
      {
        claim: 'a.ts gains a dependency on y and nothing else reads it.',
        title: 'One new import',
        anchors: [
          { kind: 'hunk', hunk: 'h1', gist: 'The import lands here.', mark: 'key', caption: 'new import' },
          {
            kind: 'region',
            path: 'src/unchanged.ts',
            start: 1,
            end: 2,
            gist: 'Should this have changed? No.',
            note: { by: 'author', text: 'Checked every importer.' },
          },
        ],
        claims: [
          { text: 'src/unchanged.ts does not import y.', provenance: { kind: 'inferred' } },
          { text: 'y is what the team would have chosen.', provenance: { kind: 'inferred' } },
        ],
      },
      {
        id: 'plumbing',
        claim: 'The deletion carries nothing to review.',
        title: 'Dead code goes',
        anchors: [{ kind: 'hunk', hunk: 'h2', gist: 'An unused constant.' }],
        claims: [{ text: 'Nothing read old.', provenance: { kind: 'inferred' } }],
      },
    ],
  });
  assert.equal(submitted.isError, false, submitted.text);
  return { author: author!, pack: system.store.getCurrentReviewPack(7)!.pack };
}

/** Every idea labelled, every claim answered, the second claim undecidable, the plumbing claim false. */
function fullCheck(pack: ReviewPack, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const [idea, plumbing] = pack.ideas;
  return {
    ideas: [
      {
        id: idea!.id,
        attention: 'read',
        cue: 'One import, but it is the whole change.',
        claims: [
          { claim: 1, verdict: 'true', evidence: 'grep -n "from \\"y\\"" src/ finds only src/a.ts.' },
          { claim: 2, verdict: 'cant_tell', evidence: 'A judgement about the team, not the tree.' },
        ],
      },
      {
        id: plumbing!.id,
        attention: 'skim',
        cue: 'A deletion nothing depended on — except one thing did.',
        claims: [
          {
            claim: 1,
            verdict: 'false',
            evidence: 'src/unchanged.ts:2 still reads old.',
            finding: {
              headline: 'The deleted constant is still read.',
              body: 'src/unchanged.ts reads `old` on line 2, so the build breaks. **Blocking; the author’s call.**',
              step: 1,
              counter: { path: 'src/unchanged.ts', start: 2, end: 2, caption: 'the surviving reader' },
            },
          },
        ],
      },
    ],
    order: [plumbing!.id, idea!.id],
    ...extra,
  };
}

// -- the origins, purely ------------------------------------------------------------

test("the checker's origin and lease key are its own, and nothing else parses as them", () => {
  assert.equal(checkOrigin(7), 'pr:7:check');
  assert.equal(checkTargetPr('pr:7:check'), 7);
  assert.equal(checkTargetPr('pr:7:pack'), null);
  assert.equal(checkLeaseKey(7, HEAD), `review-pack-check/pr-7/${HEAD}`);
  assert.equal(checkLeaseHead(checkLeaseKey(7, HEAD)), HEAD);
  assert.equal(checkLeaseHead(`review-pack/pr-7/${HEAD}`), null, "the author's key is not the checker's");
});

// -- the merge, purely ------------------------------------------------------------------

test('the merge reaches only the checker’s fields, and refuses an incomplete check by name', () => {
  const pack: ReviewPack = {
    schema: 1,
    prNumber: 7,
    headSha: HEAD,
    headline: 'h',
    summary: 's',
    estimatedMinutes: 1,
    order: [],
    witnessed: false,
    fake: 'nothing',
    ideas: [
      {
        id: 'idea_1',
        claim: 'c',
        title: 't',
        cue: null,
        attention: null,
        anchors: [
          {
            kind: 'hunk',
            range: { path: 'src/a.ts', start: 1, end: 4 },
            code: ['+x'],
            gist: 'g',
            note: null,
            caption: null,
            mark: 'key',
          },
        ],
        claims: [{ text: 'one', provenance: { kind: 'inferred' }, verdict: null, evidence: null, finding: null }],
      },
    ],
  };
  const commission = { pack, readRegion: () => ['line'] };
  const refuse = (args: Record<string, unknown>) => {
    const r = applyCheck(commission, args);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error;
  };
  const good = {
    ideas: [{ id: 'idea_1', attention: 'read', cue: 'why', claims: [{ claim: 1, verdict: 'true', evidence: 'ran' }] }],
    order: ['idea_1'],
  };
  assert.match(refuse({ ...good, ideas: [] }), /every idea gets a label, and these have none: idea_1/);
  assert.match(
    refuse({ ...good, ideas: [{ ...good.ideas[0], claims: [] }] }),
    /every claim gets a verdict, and these on idea_1 have none: 1/,
  );
  assert.match(refuse({ ...good, ideas: [{ ...good.ideas[0], id: 'idea_9' }] }), /no such idea idea_9/);
  assert.match(refuse({ ...good, ideas: [{ ...good.ideas[0], attention: 'urgent' }] }), /attention must be one of/);
  assert.match(
    refuse({ ...good, ideas: [{ ...good.ideas[0], claims: [{ claim: 1, verdict: 'maybe', evidence: 'x' }] }] }),
    /verdict must be true, false or cant_tell/,
  );
  assert.match(
    refuse({ ...good, ideas: [{ ...good.ideas[0], claims: [{ claim: 1, verdict: 'true' }] }] }),
    /evidence is required/,
  );
  assert.match(
    refuse({ ...good, ideas: [{ ...good.ideas[0], claims: [{ claim: 1, verdict: 'false', evidence: 'x' }] }] }),
    /finding is required on a false claim/,
  );
  assert.match(
    refuse({
      ...good,
      ideas: [
        {
          ...good.ideas[0],
          claims: [{ claim: 1, verdict: 'true', evidence: 'x', finding: { headline: 'h', body: 'b' } }],
        },
      ],
    }),
    /finding belongs on a false claim only/,
  );
  assert.match(
    refuse({
      ...good,
      ideas: [
        {
          ...good.ideas[0],
          claims: [{ claim: 1, verdict: 'false', evidence: 'x', finding: { headline: 'h', body: 'b', step: 3 } }],
        },
      ],
    }),
    /step must be a step of this idea's walk \(1–1\)/,
  );
  assert.match(refuse({ ...good, order: [] }), /order must name every idea once, and leaves out: idea_1/);
  assert.match(refuse({ ...good, order: ['idea_1', 'idea_1'] }), /order: idea_1 is listed twice/);

  // Nothing in the arguments reaches the author's fields: a merge that tries to
  // reword the claim, retitle the idea or re-mark the anchor lands the verdict
  // and leaves the rest exactly as stored.
  const merged = applyCheck(commission, {
    ...good,
    headline: 'rewritten',
    ideas: [{ ...good.ideas[0], claim: 'reworded', title: 'retitled', anchors: [], mark: 'disputed' }],
  });
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.pack.headline, 'h');
  assert.equal(merged.pack.ideas[0]!.claim, 'c');
  assert.equal(merged.pack.ideas[0]!.title, 't');
  assert.equal(merged.pack.ideas[0]!.anchors.length, 1);
  assert.equal(merged.pack.ideas[0]!.anchors[0]!.mark, 'key');
  assert.equal(merged.pack.ideas[0]!.attention, 'read');
  assert.equal(merged.pack.ideas[0]!.claims[0]!.verdict, 'true');
  assert.deepEqual(merged.pack.order, ['idea_1']);
  // ...and the stored document was not touched.
  assert.equal(pack.ideas[0]!.attention, null);
});

// -- following the author, at the seam -------------------------------------------------

test('the checker follows the author onto the pack, on its own read-only slot, handed the skeleton and not the story', async () => {
  const { system, worktrees } = build();
  const { author, pack } = await authored(system);
  // The author is still alive: nothing follows a submit, only a run ending.
  assert.equal(agentOn(system, checkOrigin(7)), undefined);
  assert.equal(system.reviewPackChecker.checking(7), false);

  system.agents.complete(author.id);
  await system.reviewPackChecker.whenIdle();
  const task = findTask(system.store, (t) => t.originRef === checkOrigin(7));
  assert.ok(task, 'the checker task exists');
  assert.equal(task!.kind, 'code');
  assert.equal(task!.rule, null, 'no rule dispatched this');
  assert.equal(task!.branch, checkLeaseKey(7, HEAD));
  assert.ok(agentOn(system, checkOrigin(7)), 'the checker was spawned');
  assert.equal(system.reviewPackChecker.checking(7), true);
  // Its own key, the same read-only shape, the same head — and the author's slot went back first.
  assert.deepEqual(worktrees.ensured.at(-1), { branch: checkLeaseKey(7, HEAD), base: HEAD, readOnly: true });
  assert.deepEqual(worktrees.removed, [`review-pack/pr-7/${HEAD}`]);

  const prompt = task!.prompt;
  assert.match(
    prompt,
    /Check the review pack for PR #7 \("Add y"\) — branch feature-7, targeting main, at head a1b2c3d4/,
  );
  // The skeleton: ids, claims, bare ranges, numbered claims.
  assert.ok(prompt.includes(`### ${pack.ideas[0]!.id}`));
  assert.ok(prompt.includes('### plumbing'));
  assert.ok(prompt.includes('Claim: a.ts gains a dependency on y and nothing else reads it.'));
  assert.ok(prompt.includes('1. src/a.ts:1-4 (changed)'));
  assert.ok(prompt.includes('2. src/unchanged.ts:1-2 (not in the diff)'));
  assert.ok(prompt.includes('- claim 1: src/unchanged.ts does not import y.'));
  assert.ok(prompt.includes('- claim 2: y is what the team would have chosen.'));
  assert.match(prompt, /git diff main\.\.\.HEAD/);
  assert.match(prompt, /review_pack_check/);
  // Not the story: no title, no gist, no note, no caption, no headline, no summary, no log.
  for (const withheld of [
    'One new import',
    'The import lands here.',
    'Checked every importer.',
    'new import',
    'The module imports y.',
    'The import is the point',
    'witness',
  ]) {
    assert.equal(prompt.includes(withheld), false, `the checker is not shown "${withheld}"`);
  }
  assert.ok(prompt.indexOf('## The diff') < prompt.indexOf('## The ideas'));
  assert.ok(prompt.indexOf('## The ideas') < prompt.indexOf('## Handing the verdicts back'));

  // While the checker is on it, a second ask is refused: the pack it is checking must not be replaced under it.
  const { app } = await buildApp(system);
  const again = await app.inject({ method: 'POST', url: '/api/prs/7/review-pack' });
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /being checked/);
  const read = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.equal(read.checking, true);
  await app.close();
  system.store.close();
});

test('an author that wrote nothing is not followed, and neither is one the operator killed', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add y', branch: 'feature-7', headSha: HEAD });
  await system.harness.runCycle('manual');
  assert.equal(system.reviewPacks.request(7).ok, true);
  await system.reviewPacks.whenIdle();
  const author = agentOn(system, packOrigin(7))!;
  system.agents.complete(author.id);
  await system.reviewPackChecker.whenIdle();
  assert.equal(
    findTask(system.store, (t) => t.originRef === checkOrigin(7)),
    undefined,
    'no pack, nothing to check',
  );

  // A second author, which submits and is then killed: the pack is there, and it stays unchecked.
  const { author: second } = await authored(system);
  system.agents.kill(second.id);
  await system.reviewPackChecker.whenIdle();
  assert.equal(
    findTask(system.store, (t) => t.originRef === checkOrigin(7)),
    undefined,
    'a killed run is not followed',
  );
  system.store.close();
});

test('a pause between the two runs leaves the pack unchecked, and says so', async () => {
  const { system } = build();
  const { author } = await authored(system);
  system.runtimeControl.apply({ paused: true });
  system.agents.complete(author.id);
  await system.reviewPackChecker.whenIdle();
  assert.equal(
    findTask(system.store, (t) => t.originRef === checkOrigin(7)),
    undefined,
  );
  assert.ok(system.store.listErrors().some((e) => /PR #7 was not checked: dispatch is paused/.test(e.message)));
  system.store.close();
});

// -- the verdicts ------------------------------------------------------------------------------

test('the checker’s verdicts land on the stored document and nothing else in it moves; the read ships them', async () => {
  const { system, worktrees, reaps } = build();
  const { author, pack: before } = await authored(system);
  system.agents.complete(author.id);
  await system.reviewPackChecker.whenIdle();
  const checker = agentOn(system, checkOrigin(7))!;
  mkdirSync(join(checker.cwd, 'src'), { recursive: true });
  writeFileSync(join(checker.cwd, 'src/unchanged.ts'), 'line one\nconst z = old;\nline three\n');

  const checked: number[] = [];
  system.reviewPackChecker.on('checked', ({ record }) => checked.push(record.pack.prNumber));
  const res = await call(system, checker, 'review_pack_check', fullCheck(before));
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(checked, [7]);
  assert.match(res.text, /"true": 1/);
  assert.match(res.text, /"false": 1/);
  assert.match(res.text, /"cant_tell": 1/);

  const record = system.store.getCurrentReviewPack(7)!;
  const after = record.pack;
  assert.equal(after.headSha, HEAD);
  assert.equal(system.store.listReviewPacks(7).length, 1, 'the same row, re-recorded');
  const [idea, plumbing] = after.ideas;
  assert.equal(idea!.attention, 'read');
  assert.equal(idea!.cue, 'One import, but it is the whole change.');
  assert.deepEqual(
    idea!.claims.map((c) => [c.verdict, c.evidence, c.finding]),
    [
      ['true', 'grep -n "from \\"y\\"" src/ finds only src/a.ts.', null],
      ['cant_tell', 'A judgement about the team, not the tree.', null],
    ],
  );
  assert.equal(plumbing!.attention, 'skim');
  assert.equal(plumbing!.claims[0]!.verdict, 'false');
  // The finding lives on the claim; its counter's code was read off the tree at the head.
  assert.deepEqual(plumbing!.claims[0]!.finding, {
    headline: 'The deleted constant is still read.',
    body: 'src/unchanged.ts reads `old` on line 2, so the build breaks. **Blocking; the author’s call.**',
    step: 1,
    counter: {
      range: { path: 'src/unchanged.ts', start: 2, end: 2 },
      code: ['const z = old;'],
      caption: 'the surviving reader',
    },
  });
  // ...and the step it names carries the checker's one mark.
  assert.equal(plumbing!.anchors[0]!.mark, 'false');
  assert.deepEqual(after.order, [plumbing!.id, idea!.id]);
  // Everything the author wrote is as it was: ids, claims, titles, anchors, ranges, code, key mark, note, provenance.
  assert.equal(idea!.id, before.ideas[0]!.id);
  assert.deepEqual(
    after.ideas.map((i) => ({
      id: i.id,
      claim: i.claim,
      title: i.title,
      anchors: i.anchors.map((a) => ({ ...a, mark: a.mark === 'false' ? null : a.mark })),
    })),
    before.ideas.map((i) => ({ id: i.id, claim: i.claim, title: i.title, anchors: i.anchors })),
  );
  assert.equal(idea!.anchors[0]!.mark, 'key');
  assert.deepEqual(
    after.ideas.flatMap((i) => i.claims.map((c) => [c.text, c.provenance])),
    before.ideas.flatMap((i) => i.claims.map((c) => [c.text, c.provenance])),
  );
  assert.equal(after.headline, before.headline);
  assert.equal(after.witnessed, before.witnessed);

  const { app } = await buildApp(system);
  const got = (await app.inject({ method: 'GET', url: '/api/prs/7/review-pack' })).json() as ReviewPackPayload;
  assert.deepEqual(got.pack, after);
  assert.equal(got.writtenAt, record.writtenAt);
  assert.equal(got.checking, true, 'the checker is still alive after its call');
  await app.close();

  // The checker is an agent like any other: the kill reaps its subtree and the reap hands its slot back.
  const pid = system.store.getAgent(checker.id)?.pid;
  system.agents.kill(checker.id);
  assert.ok(reaps.includes(pid!), 'the subtree is reaped through session.kill()');
  assert.ok(worktrees.removed.includes(checkLeaseKey(7, HEAD)));
  assert.equal(system.reviewPackChecker.checking(7), false);
  system.store.close();
});

test('a check is refused by field name and lands once fixed; the tool is refused to any agent that is not a checker', async () => {
  const { system } = build();
  const { author, pack } = await authored(system);
  // The author cannot cast the checker's tool, by name.
  const wrong = await call(system, author, 'review_pack_check', fullCheck(pack));
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /dispatched for pr:7:pack\. Nothing was recorded/);

  system.agents.complete(author.id);
  await system.reviewPackChecker.whenIdle();
  const checker = agentOn(system, checkOrigin(7))!;
  mkdirSync(join(checker.cwd, 'src'), { recursive: true });
  writeFileSync(join(checker.cwd, 'src/unchanged.ts'), 'line one\nconst z = old;\nline three\n');
  const good = fullCheck(pack);
  const ideas = good.ideas as Record<string, unknown>[];

  const missing = await call(system, checker, 'review_pack_check', { ...good, ideas: [ideas[0]] });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /every idea gets a label, and these have none: plumbing/);

  const counterOutside = await call(system, checker, 'review_pack_check', {
    ...good,
    ideas: [
      ideas[0],
      {
        ...ideas[1],
        claims: [
          {
            claim: 1,
            verdict: 'false',
            evidence: 'x',
            finding: { headline: 'h', body: 'b', counter: { path: '../etc/passwd', start: 1, end: 1, caption: 'no' } },
          },
        ],
      },
    ],
  });
  assert.equal(counterOutside.isError, true);
  assert.match(counterOutside.text, /counter: \.\.\/etc\/passwd:1-1 is not in the tree at the head/);

  const unordered = await call(system, checker, 'review_pack_check', { ...good, order: [pack.ideas[0]!.id] });
  assert.equal(unordered.isError, true);
  assert.match(unordered.text, /order must name every idea once, and leaves out: plumbing/);

  assert.equal(system.store.getCurrentReviewPack(7)!.pack.order.length, 0, 'nothing landed');
  // The fixed check lands in the same turn, this time with no counter to read.
  const fixedIdeas = [
    ideas[0],
    {
      ...ideas[1],
      claims: [
        {
          claim: 1,
          verdict: 'false',
          evidence: 'x',
          finding: { headline: 'h', body: 'b', step: 1 },
        },
      ],
    },
  ];
  const fixed = await call(system, checker, 'review_pack_check', { ...good, ideas: fixedIdeas });
  assert.equal(fixed.isError, false, fixed.text);
  const landed = system.store.getCurrentReviewPack(7)!.pack;
  assert.deepEqual(landed.ideas[1]!.claims[0]!.finding, { headline: 'h', body: 'b', step: 1, counter: null });
  system.store.close();
});
