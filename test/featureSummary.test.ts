import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import {
  featureStandingKey,
  featureSummaryOrigin,
  featureSummarySubmitOrigin,
  validateFeatureSummary,
  type FeatureChildStandingFacts,
} from '../src/summaries/featureSummary.js';
import { buildFeatureBoard } from '../src/features/featureBoard.js';
import type { FeatureSummary, Task } from '../src/types.js';
import { TICKET_COLUMNS, type MirroredTicket } from '../src/store/tickets.js';
import { Store } from '../src/store/store.js';
import { summarySection } from '../web/src/view/summarySection.js';
import { repoText } from './support/paths.js';
import { BRIEFS_AT_MOST, drawsRows } from '../web/src/components/FeatureBoard.js';

const NOW = '2026-08-27T12:00:00.000Z';

function child(over: Partial<FeatureChildStandingFacts> = {}): FeatureChildStandingFacts {
  return {
    number: 1,
    state: 'open',
    workItemState: 'Doing',
    deliveredAt: null,
    shortfallAt: null,
    runningSince: null,
    landedAt: null,
    ...over,
  };
}

test('the standing key moves when an item moves and not when its text does', () => {
  const before = [child({ number: 1 }), child({ number: 2 })];
  assert.equal(featureStandingKey(before), featureStandingKey([child({ number: 2 }), child({ number: 1 })]));
  for (const moved of [
    child({ number: 2, state: 'closed' }),
    child({ number: 2, workItemState: 'In Review' }),
    child({ number: 2, deliveredAt: NOW }),
    child({ number: 2, shortfallAt: NOW }),
    child({ number: 2, runningSince: NOW }),
    child({ number: 2, landedAt: NOW }),
  ]) {
    assert.notEqual(featureStandingKey(before), featureStandingKey([child({ number: 1 }), moved]), 'a movement shows');
  }
  assert.notEqual(featureStandingKey(before), featureStandingKey([...before, child({ number: 3 })]));
});

test('only the agent dispatched to summarise a Feature may write one', () => {
  const ok = featureSummarySubmitOrigin(featureSummaryOrigin(29857));
  assert.equal(ok.ok && ok.featureOrigin, 'issue:29857');
  assert.equal(ok.ok && ok.featureNumber, 29857);
  for (const origin of ['issue:29857', 'issue:29857:retro', 'pr:31827:ci', null]) {
    const refused = featureSummarySubmitOrigin(origin);
    assert.equal(refused.ok, false, `${String(origin)} is refused`);
    assert.match(refused.ok === false ? refused.error : '', /retro_submit|conclude_work/);
  }
});

test('a summary needs a lede and nothing else', () => {
  const empty = validateFeatureSummary({ usable: 'lots', blocked: 'nothing' });
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.error : '', /standing is required/);

  const lean = validateFeatureSummary({ standing: 'Not started.' });
  assert.equal(lean.ok, true);
  assert.deepEqual(lean.ok && lean.input, {
    headline: null,
    standing: 'Not started.',
    usable: null,
    blocked: null,
    remaining: null,
  });
  const blank = validateFeatureSummary({ standing: 'Going.', usable: '   ' });
  assert.equal(blank.ok && blank.input.usable, null);

  const long = validateFeatureSummary({ standing: 'Going.', remaining: 'x'.repeat(5_000) });
  assert.equal(long.ok, true);
  assert.equal(long.ok && long.trimmed, true);
  assert.ok(long.ok && (long.input.remaining?.length ?? 0) < 5_000);

  const shouted = validateFeatureSummary({ standing: 'x'.repeat(5_000) });
  assert.equal(shouted.ok, false);
  assert.match(shouted.ok === false ? shouted.error : '', /too long/);
});

test('the card is capped at a glance, and a cut section keeps whole bullets', () => {
  const essay = validateFeatureSummary({ standing: 'Where it is. '.repeat(40) });
  assert.equal(essay.ok, false, 'four paragraphs of lede is the thing a reader skips');
  assert.match(essay.ok === false ? essay.error : '', /max 360/);

  const bullets = [...Array(20)].map((_, i) => `- bullet ${i} ${'y'.repeat(40)}`).join('\n');
  const cut = validateFeatureSummary({ standing: 'Going.', usable: bullets });
  assert.equal(cut.ok, true);
  assert.equal(cut.ok && cut.trimmed, true);
  const kept = (cut.ok && cut.input.usable) || '';
  assert.ok(kept.length <= 600);
  for (const line of kept.split('\n')) {
    assert.match(line, /^- bullet \d+ y+$/, 'cut at a line boundary, never mid-bullet');
  }
});

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [] },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    agentHeadroom: 3,
    featureStandings: [{ number: 29857, title: 'Wider matching', key: 'abc123' }],
    ...over,
  };
}

test('a Feature is summarised when it has moved, and never again until it does', async () => {
  const dispatcher = new RuleDispatcher();

  const first = await dispatcher.decide(ctx());
  const dispatch = first.actions.find((a) => a.rule === 'feature-summary');
  assert.ok(dispatch, 'a Feature nobody has summarised gets one');
  assert.equal(dispatch.type, 'dispatch_desk_agent');
  assert.equal(dispatch.originRef, 'issue:29857:summary');
  assert.equal('branch' in dispatch ? dispatch.branch : null, null);

  const settled = await dispatcher.decide(
    ctx({ featureSummaryKeys: [{ originRef: 'issue:29857', standingKey: 'abc123' }] }),
  );
  assert.equal(
    settled.actions.some((a) => a.rule === 'feature-summary'),
    false,
  );

  const moved = await dispatcher.decide(
    ctx({ featureSummaryKeys: [{ originRef: 'issue:29857', standingKey: 'older' }] }),
  );
  assert.ok(moved.actions.some((a) => a.rule === 'feature-summary'));
});

test('a summariser already on the Feature is not joined by a second', async () => {
  const live: Task = {
    id: 't1',
    kind: 'desk',
    title: 'Summarise feature #29857',
    prompt: 'say where it is',
    branch: null,
    originRef: 'issue:29857:summary',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const plan = await new RuleDispatcher().decide(ctx({ tasks: [live] }));
  assert.equal(
    plan.actions.some((a) => a.rule === 'feature-summary'),
    false,
    'the one in flight will read the standing again when it submits',
  );
});

test('nothing is summarised where the deployment has no feature board', async () => {
  const plan = await new RuleDispatcher().decide(ctx({ featureStandings: undefined }));
  assert.equal(
    plan.actions.some((a) => a.rule === 'feature-summary'),
    false,
  );
});

function ticket(over: Partial<MirroredTicket> = {}): MirroredTicket {
  return {
    number: 35916,
    title: 'Turn a match bucket on or off per ORC',
    labels: [],
    state: 'open',
    url: null,
    createdAt: NOW,
    changedAt: NOW,
    firstSeenAt: NOW,
    tracking: 'live',
    workItemState: null,
    issueType: 'User Story',
    parent: { number: 29857, title: 'Wider matching' },
    lastReadAt: null,
    ...over,
  };
}

test('the board quotes the summary whole and composes nothing', () => {
  const summary: FeatureSummary = {
    originRef: 'issue:29857',
    headline: 'Most of the way there',
    standing: 'The main thing works and is on hallway. The per-ORC switch is stuck on a decision.',
    usable: 'On hallway, switching a customer over keeps their candidate pairs.',
    blocked: null,
    remaining: 'The bucket switch, and four items nobody is watching.',
    standingKey: 'abc123',
    agentId: 'a1',
    taskId: 't1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const board = buildFeatureBoard({
    items: [ticket()],
    outcomes: new Map(),
    costs: new Map(),
    featureSlots: new Map(),
    running: new Map(),
    deliveries: [],
    shortfalls: [],
    escalations: [],
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature'],
    watchLabel: 'lubbdubb-watch',
    summaries: new Map([['issue:29857', summary]]),
    sequences: new Map(),
    standingKeys: new Map(),
  });
  assert.deepEqual(board.features[0]?.summary, summary, 'quoted, never re-worded or re-derived');
  const bare = buildFeatureBoard({
    items: [ticket()],
    outcomes: new Map(),
    costs: new Map(),
    featureSlots: new Map(),
    running: new Map(),
    deliveries: [],
    shortfalls: [],
    escalations: [],
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature'],
    watchLabel: 'lubbdubb-watch',
    summaries: new Map(),
    sequences: new Map(),
    standingKeys: new Map(),
  });
  assert.equal(bare.features[0]?.summary, null);
});

test('a second submission revises one row and keeps the date it was first written', () => {
  const store = new Store(':memory:');
  const first = store.tickets.recordFeatureSummary({
    originRef: 'issue:29857',
    headline: null,
    standing: 'Not started.',
    usable: null,
    blocked: null,
    remaining: null,
    standingKey: 'k1',
    agentId: 'a1',
    taskId: 't1',
  });
  const second = store.tickets.recordFeatureSummary({
    originRef: 'issue:29857',
    headline: 'On hallway',
    standing: 'On hallway now.',
    usable: 'Switch a customer over and their pairs survive.',
    blocked: null,
    remaining: null,
    standingKey: 'k2',
    agentId: 'a2',
    taskId: 't2',
  });
  assert.equal(
    store.tickets.listFeatureSummaries().length,
    1,
    'a revision is one row, not two accounts of one Feature',
  );
  assert.equal(second.createdAt, first.createdAt, 'still dates the first time anybody said where this was');
  assert.equal(store.tickets.getFeatureSummary('issue:29857')?.standing, 'On hallway now.');
  assert.equal(store.tickets.getFeatureSummary('issue:29857')?.standingKey, 'k2');
});

test('a section is drawn as bullets where it was written as bullets, and as prose where it was not', () => {
  assert.deepEqual(summarySection('- New blank customers — live\n- Maintenance job — hallway'), {
    kind: 'bullets',
    items: ['New blank customers — live', 'Maintenance job — hallway'],
  });
  for (const mark of ['*', '•', '–']) {
    assert.deepEqual(summarySection(`${mark} one`), { kind: 'bullets', items: ['one'] });
  }
  assert.deepEqual(summarySection('Switching a customer over keeps their pairs.'), {
    kind: 'prose',
    text: 'Switching a customer over keeps their pairs.',
  });
  assert.deepEqual(summarySection('One thing.\n\nAnd another.'), {
    kind: 'prose',
    text: 'One thing. And another.',
  });
  assert.deepEqual(summarySection('-   '), { kind: 'prose', text: '-' }, 'a bullet with nothing in it is not a list');
});

test('the account is on the brief, so a folded card answers “how is this going”', () => {
  const board = repoText('web', 'src', 'components', 'featureCards.tsx');
  const account = repoText('web', 'src', 'components', 'featureAccount.tsx');
  const focus = repoText('web', 'src', 'components', 'FeatureFocus.tsx');

  assert.match(
    board,
    /account=\{<FeatureAccount summary=\{feature\.summary\} \/>\}/,
    'the three fields are the brief’s, drawn whether or not the card is open',
  );

  const opened = board.slice(board.indexOf('className="cn-fb-detail'));
  assert.doesNotMatch(
    opened,
    /<FeatureAccount\b/,
    'and are not drawn a second time inside the open card — one account, one place',
  );

  for (const field of ['summary.usable', 'summary.blocked', 'summary.remaining']) {
    assert.match(
      account,
      new RegExp(`<AccountBlock title="[^"]+" body=\\{${field.replace('.', '\\.')}\\}`),
      `${field} is a peer block with its own heading, not a footnote under the other two`,
    );
  }
  assert.doesNotMatch(account, /cn-fb-sum-foot/, 'left-to-do is no longer a footnote');

  // One account, rendered by one component. While the board and focus mode each had
  // their own, focus — the mode for one Feature at a time — drew the three fields
  // unlabelled and left the lede out, and nothing could see that they disagreed.
  for (const [name, source] of [
    ['the board', board],
    ['focus mode', focus],
  ] as const) {
    assert.match(source, /<FeatureAccount summary=/, `${name} draws the shared account`);
    assert.doesNotMatch(source, /function AccountBlock\b/, `${name} does not keep a second copy of it`);
  }
  assert.match(
    focus,
    /className="cn-ff-lede">\{rollup\.summary\.standing\}/,
    'focus draws the lede too, which it used to omit',
  );
  // `cn-ff-standing` is already the per-child lamp in the lanes below, and a second
  // meaning for it drew the paragraph four pixels wide.
  assert.doesNotMatch(
    focus.slice(0, focus.indexOf('cn-ff-lane')),
    /cn-ff-standing/,
    'the lede does not borrow a class name the lanes already own',
  );

  const css = repoText('web', 'src', 'styles.css');
  const at = css.indexOf('\n.cn-fb-summary {');
  assert.notEqual(at, -1, '.cn-fb-summary must still be a rule in styles.css');
  assert.match(
    css.slice(at, css.indexOf('}', at)),
    /grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\)/,
    'auto-fit, because any of the three can be absent and a missing one must leave no dead column',
  );
});

test('the open card draws no heading over an empty column', () => {
  const source = repoText('web', 'src', 'components', 'featureCards.tsx');
  assert.match(
    source,
    /const told = feature\.sequence !== null \|\| feature\.briefing\.delivered\.length > 0;/,
    'the column is drawn on whether either half of it has anything to say',
  );
  assert.match(
    source,
    /cn-fb-detail\$\{told \? '' : ' cn-fb-detail-2'\}/,
    'and the card falls back to the two-column shape without it, rather than leaving a dead track',
  );
});

test('the headline is the agent’s own clause, refused when it stops being one', () => {
  const base = { standing: 'It works and is on staging. The rest is waiting on a merge.' };

  const none = validateFeatureSummary({ ...base });
  assert.ok(none.ok && none.input.headline === null, 'leaving it out is an ordinary answer, not a refusal');

  const said = validateFeatureSummary({ ...base, headline: 'Most of the way there — nothing on live yet' });
  assert.ok(said.ok && said.input.headline === 'Most of the way there — nothing on live yet');

  const long = validateFeatureSummary({ ...base, headline: 'x'.repeat(91) });
  assert.ok(!long.ok, 'a headline over the cap is refused, never clipped — half of one is a different claim');
  assert.match(long.ok ? '' : long.error, /90/, 'and the refusal says what the cap is');

  assert.ok(validateFeatureSummary({ ...base, headline: 'x'.repeat(90) }).ok, 'the cap itself is allowed');
});

test('the headline survives a round trip, and a database from before it reads as absent', () => {
  const store = new Store(':memory:');
  const written = store.tickets.recordFeatureSummary({
    originRef: 'issue:900',
    headline: 'Done bar the deploy',
    standing: 'Everything is merged.',
    usable: null,
    blocked: null,
    remaining: null,
    standingKey: 'k1',
    agentId: 'a1',
    taskId: 't1',
  });
  assert.equal(written.headline, 'Done bar the deploy');
  assert.equal(store.tickets.getFeatureSummary('issue:900')?.headline, 'Done bar the deploy');

  // The column is additive on a table that already exists everywhere, so the row a
  // deployment already holds has to read back as "not written yet" rather than break.
  // Null means exactly that, which is why it wants no backfill: the next time anything
  // under the Feature moves, rule `feature-summary` rewrites the row and fills it in.
  store.tickets.recordFeatureSummary({
    originRef: 'issue:901',
    headline: null,
    standing: 'Written before the field existed.',
    usable: null,
    blocked: null,
    remaining: null,
    standingKey: 'k2',
    agentId: 'a1',
    taskId: 't1',
  });
  assert.equal(store.tickets.getFeatureSummary('issue:901')?.headline, null);
});

test('the column is declared as a migration, because the table predates it', () => {
  assert.equal(
    TICKET_COLUMNS.feature_summaries?.headline,
    'TEXT',
    'CREATE TABLE IF NOT EXISTS never alters a table that already exists — without this entry the ' +
      'column is invisible on every database from before it, and every write to it throws',
  );
  const schema = repoText('src', 'store', 'schema', 'validationAndTracker.ts');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS feature_summaries \([^)]*headline\s+TEXT/, 'and on a fresh one');
});

test('the card leads with the headline, and says nothing where there is none', () => {
  const board = repoText('web', 'src', 'components', 'featureCards.tsx');
  const brief = repoText('web', 'src', 'components', 'featureBrief.tsx');
  assert.match(board, /headline=\{feature\.summary\?\.headline \?\? null\}/, 'the brief is handed it');
  assert.match(
    brief,
    /\{headline !== null && headline !== undefined && <p className="cn-fb-headline">/,
    'an absent headline draws nothing at all, never an empty line',
  );
  const focus = repoText('web', 'src', 'components', 'FeatureFocus.tsx');
  assert.match(focus, /cn-ff-headline/, 'and focus mode leads with it too');
});

test('the board draws briefs while it is short and rows once it is not', () => {
  // `auto` is a property of the board, not a preference: an operator should not have
  // to find a setting to be shown a page they can read.
  assert.equal(drawsRows('auto', BRIEFS_AT_MOST), false, 'a board of eight still reads down');
  assert.equal(drawsRows('auto', BRIEFS_AT_MOST + 1), true, 'one more and it does not');
  assert.equal(drawsRows('auto', 0), false, 'an empty board is not a long one');

  // And the operator outranks it in both directions, which is the whole reason the
  // value is on `Place` rather than computed at the call site.
  assert.equal(drawsRows('brief', 400), false, 'asked for full, they get full however long it is');
  assert.equal(drawsRows('rows', 1), true, 'asked for rows, they get rows however short it is');
});

test('a row says the one thing a scan needs, and an opened card is a page of its own', () => {
  const board = repoText('web', 'src', 'components', 'FeatureBoard.tsx');
  const cards = repoText('web', 'src', 'components', 'featureCards.tsx');

  assert.match(cards, /rows \? \(\s*<FeatureRow/, 'in rows every Feature is a row');
  assert.match(cards, /rows \? \(\s*<GoalRow/, 'promoted goals collapse too');
  assert.match(
    board,
    /view\.featureMode === 'board' && view\.featureCard !== null\) \{\s*return \(\s*<FeatureDetail/,
    'a card opened on `?card=` is the Feature’s page, not a card unfolded in the list',
  );
  assert.match(
    cards,
    /\{page && \(\s*<div className=\{`cn-fb-detail/,
    'the detail is drawn on the page and nowhere else',
  );

  const root = repoText('web', 'src', 'console', 'ConsoleRoot.tsx');
  assert.match(
    root,
    /isContainerType\(view\.goalPage\.issue, view\.state\.config\.containerTypes\) \? \([\s\S]*?<FeaturePage/,
    'a container’s goal page is its Feature page — the fleet never works a container, so the goal page is empty',
  );

  const row = cards.slice(cards.indexOf('function FeatureRow('), cards.indexOf('function FeatureCard('));
  assert.match(row, /cn-fb-row-said/, 'a row carries the headline, which is what makes it an answer');
  assert.match(row, /<Courts holds=\{holds\} yoursOnly \/>/, 'only your own court survives the line');
  assert.doesNotMatch(row, /<Reach\b/, 'reach does not — it is detail about a Feature nobody has chosen yet');
});
