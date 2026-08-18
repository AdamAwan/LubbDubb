import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { GoalPartView } from '../web/src/view/goalPage.js';
import type { CockpitActions, ConsolePanel } from '../web/src/cockpit/actions.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../web/src/console/QueueRail.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Panel } = await import('../web/src/console/Panel.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');

function view(over: Partial<CockpitView> = {}): CockpitView {
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
      state,
      now: Date.now(),
      connected: true,
      demo: true,
      selected: null,
      liveOutput: new Map(),
      tails: new Map(),
      lastPulseAt: Date.now(),
      viewingPlan: null,
      viewingRetro: null,
      viewingScratchpad: null,
      settingsOpen: false,
      spendOpen: false,
      reliabilityOpen: false,
      selectedGoal: null,
      consolePanel: null,
      tab: 'overview',
    }),
    ...over,
  };
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

/**
 * The console as the shell mounts it — inside `RefLinks`, because every reference
 * it draws resolves against that and a `<Ref>` outside it throws rather than
 * quietly rendering a number with no link on it.
 */
const render = (v: CockpitView) =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

/** `renderToStaticMarkup` escapes text nodes, so an assertion on fixture prose must decode first. */
function decode(html: string): string {
  // &amp; must decode last — decoding it first would turn a literal `&amp;lt;`
  // into `<`, which is a different string than the page actually renders.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('nothing under console/ imports the api module', () => {
  const dir = new URL('../web/src/console/', import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/from '.*\/api\.js'/.test(src), `${file} reaches api.js — every mutation belongs on CockpitActions`);
  }
});

test('console.css never targets a shared component’s class', () => {
  const css = readFileSync(new URL('../web/src/console/console.css', import.meta.url).pathname, 'utf8');
  for (const cls of ['.escalation-card', '.recovery-panel', '.findings-panel', '.human-task-actions']) {
    assert.ok(!css.includes(cls), `console.css styles ${cls}; shared components restyle through tokens only`);
  }
});

test('a dropped socket draws no gauge, no rail and no situation area', () => {
  const html = render(view({ connected: false }));
  assert.ok(html.includes('Off the air'));
  assert.ok(!html.includes('cn-rail'), 'the rail must not render while offline');
  assert.ok(!html.includes('cn-sit'), 'the situation area must not render while offline');
});

test('the recovery banner sits outside the situation area', () => {
  const html = render(view({ crashed: [{ taskId: 't1' }] as CockpitView['crashed'] }));
  const banner = html.indexOf('cn-recovery');
  const sit = html.indexOf('cn-sit');
  assert.ok(banner !== -1, 'a held harness must draw its banner');
  assert.ok(banner < sit, 'the banner belongs above the situation area, not inside it');
});

test('decode reverses text-node escaping, and only in that order', () => {
  // &amp; last: decoding it first would turn a literal `&amp;lt;` into `<`,
  // which is not what the page rendered.
  assert.equal(decode('&amp;lt;'), '&lt;');
  assert.equal(decode('&#x27;'), "'");
});

test('a panel draws its backdrop and its close button, both of them ways out', () => {
  // The third way out is Escape, registered in an effect. `renderToStaticMarkup`
  // runs no effects, so the listener is out of reach here — the two exits that
  // are in the markup are the ones this pins.
  const html = renderToStaticMarkup(
    createElement(Panel, {
      title: 'Findings',
      onClose: () => undefined,
      children: createElement('p', null, 'body'),
    }),
  );

  assert.ok(html.includes('cn-backdrop'), 'the backdrop is an exit and must be drawn');
  assert.ok(html.includes('Close'), 'the button is an exit and must be drawn');
  assert.ok(html.includes('Findings'));
  assert.ok(html.includes('body'), 'a panel draws what it was handed');
});

test('the rail carries every blocking kind in one list', () => {
  const html = render(view());
  const v = view();
  assert.ok(v.needsYou.length > 0, 'the demo fixtures must carry at least one ask');
  const decoded = decode(html);
  for (const row of v.needsYou) assert.ok(decoded.includes(row.title), `the rail dropped ${row.kind}`);
});

test('a row states what it is holding, and a row holding nothing draws no count', () => {
  const rows = [
    {
      id: 'a',
      kind: 'escalation',
      group: 'blocking',
      title: 'Holds two',
      goalRef: 'issue:1',
      agentId: 'a1',
      holding: 2,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'b',
      kind: 'bench',
      group: 'yours',
      title: 'Holds nothing',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('holding 2 parts'));
  assert.ok(!html.includes('holding 0'), 'a zero is not a reading — draw no count');
});

test('one part is held, not "1 parts" — the count and the noun agree', () => {
  const rows = [
    {
      id: 'a',
      kind: 'bench',
      group: 'yours',
      title: 'Holds exactly one',
      goalRef: 'issue:1',
      agentId: null,
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('holding 1 part<'), 'a single held part reads in the singular');
  assert.ok(!html.includes('holding 1 parts'));
});

test('an empty queue collapses the rail rather than removing it', () => {
  const html = render(view({ needsYou: [] }));
  assert.ok(html.includes('cn-rail'), 'a surface that vanishes when quiet reads as one that broke');
  assert.ok(html.includes('cn-rail-empty'));
});

test('a group with no rows draws no heading; a group with rows draws its own', () => {
  const blockingOnly = [
    {
      id: 'a',
      kind: 'escalation',
      group: 'blocking',
      title: 'Only blocking',
      goalRef: 'issue:1',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];
  const bothGroups = [
    ...blockingOnly,
    {
      id: 'b',
      kind: 'bench',
      group: 'yours',
      title: 'Yours too',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const onlyHtml = render(view({ needsYou: blockingOnly }));
  assert.ok(onlyHtml.includes('Blocking'), 'the non-empty group must draw its heading');
  assert.ok(!onlyHtml.includes('Yours to do'), 'an empty group must draw no heading');

  const bothHtml = render(view({ needsYou: bothGroups }));
  assert.ok(bothHtml.includes('Blocking'));
  assert.ok(bothHtml.includes('Yours to do'), 'both groups present must draw both headings');
});

test('the rail renders array order within a group, never a re-sort', () => {
  // Deliberately out of canonical order: a `yours` row before `blocking`, and
  // the lower-holding blocking row before the higher-holding one — the rail
  // must not undo either choice.
  const rows = [
    {
      id: 'yours-1',
      kind: 'bench',
      group: 'yours',
      title: 'Yours first in the array',
      goalRef: 'issue:1',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'blocking-low',
      kind: 'escalation',
      group: 'blocking',
      title: 'Blocking low holder',
      goalRef: 'issue:2',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'blocking-high',
      kind: 'escalation',
      group: 'blocking',
      title: 'Blocking high holder',
      goalRef: 'issue:3',
      agentId: 'a2',
      holding: 5,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  const yoursPos = html.indexOf('Yours first in the array');
  const lowPos = html.indexOf('Blocking low holder');
  const highPos = html.indexOf('Blocking high holder');

  assert.ok(yoursPos !== -1 && lowPos !== -1 && highPos !== -1, 'every row must still render');
  // Within the blocking group, array order (low before high) is preserved —
  // a re-sort by holding would put the high-holder first.
  assert.ok(lowPos < highPos, 'the blocking group must keep array order, not re-sort by holding');
});

test('every row that opens something is a button; only the recovery hold is not', () => {
  const rows = [
    {
      id: 'clickable',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens a goal',
      goalRef: 'issue:9',
      opens: 'goal',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      // The escalation a pull request raised: no goal page to be answered on, so
      // it opens the ask panel. Before that destination existed it drew as a
      // `div` and a click on it did nothing at all.
      id: 'no-goal',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens the ask panel',
      goalRef: null,
      opens: 'ask',
      agentId: 'a3',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      opens: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));

  // The row wrapper is the element whose class starts `cn-q ` and is followed by
  // its tone and, when an agent is parked on it, its weight — anchoring on the
  // whole attribute rules out `cn-qin`/`cn-qkind`, which are unrelated inner
  // elements that happen to share the `cn-q` prefix.
  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    // Attribute order differs between the two tags (`<button type="button"
    // class="…">` vs `<div class="…">`), so match the whole opening tag and
    // check its attributes rather than assuming `class` comes first.
    const matches = [...before.matchAll(/<(button|div)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /class="cn-q cn-t-(?:red|amber|blue|green)(?: cn-parked)?(?: cn-dim)?"/.test(attrs ?? ''),
    );
    const last = matches.at(-1);
    assert.ok(last, `no cn-q wrapper found before "${title}"`);
    const tag = last[1];
    assert.ok(tag, `unmatched capture group for "${title}"`);
    return tag;
  };

  assert.equal(rowWrapper('Opens a goal'), 'button', 'a row that opens a goal is a button');
  assert.equal(
    rowWrapper('Opens the ask panel'),
    'button',
    'an ask with no goal page still has somewhere to go, so it is a button',
  );
  assert.equal(
    rowWrapper('Answered on the banner above'),
    'div',
    'the recovery row opens nothing and must not be wrapped in a button',
  );
});

/**
 * The rail's two readings, and the one thing that keeps them from collapsing back
 * into each other: **hue is the kind, weight is the group**. The palette used to
 * spend both on the group — red blocking, amber yours — which meant every ask
 * that ever landed on the bench arrived in an alarm colour, a delivered goal's
 * close-out included.
 *
 * Totality is the typechecker's, so what is left to assert is what a `Record`
 * cannot say: that no two kinds are told apart by the word alone, and that the
 * glyphs carry no emoji presentation — a codepoint with one renders as a
 * full-colour sticker inside a 10px monospace tag on some platforms and as
 * lettering on others, which is a difference no test on this machine would show.
 */
test('every kind of ask draws in its own tone, under its own glyph', () => {
  const kinds = Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[];

  const symbols = kinds.map((k) => KIND_SYMBOL[k]);
  assert.equal(new Set(symbols).size, symbols.length, 'two kinds sharing a glyph is a glyph that says nothing');
  for (const sym of symbols) {
    assert.equal([...sym].length, 1, `"${sym}" must be a single character`);
    const cp = sym.codePointAt(0) ?? 0;
    assert.ok(cp < 0x10000, `"${sym}" must be a BMP glyph, not an emoji codepoint`);
    // U+FE0F would force emoji presentation; U+FE0E would force text. Neither
    // belongs here — the set is chosen from codepoints that have no emoji variant
    // at all, so the platform has nothing to choose between.
    assert.ok(!/[\uFE0E\uFE0F]/.test(sym), `"${sym}" must carry no variation selector`);
  }

  const rows = kinds.map((kind, i) => ({
    id: `row-${i}`,
    kind,
    // Alternated on purpose: the group must not be what decides the tone, so a
    // sweep that held it constant would pass on a rail that had quietly gone back
    // to colouring by group.
    group: i % 2 === 0 ? 'blocking' : 'yours',
    title: `The ${kind} row`,
    goalRef: null,
    originRef: null,
    opens: kind === 'recovery' ? null : 'ask',
    agentId: null,
    holding: 0,
    raisedAt: '2026-01-01T00:00:00.000Z',
  })) as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  for (const kind of kinds) {
    const pos = html.indexOf(`The ${kind} row`);
    assert.ok(pos !== -1, `the ${kind} row must render`);
    const row = html.slice(html.lastIndexOf('<', html.lastIndexOf('cn-q cn-t-', pos)), pos);
    assert.ok(row.includes(`cn-q cn-t-${KIND_TONE[kind]}`), `the ${kind} row must wear its own tone, not the group's`);
    assert.ok(row.includes(KIND_SYMBOL[kind]), `the ${kind} row must draw its glyph beside the word`);
    assert.ok(row.includes(KIND_LABEL[kind]), `and the word beside the glyph — the symbol is a second reading`);
  }
});

/**
 * The other half: the group is still said, and it is said on the row rather than
 * only in the sub-heading above it. Two rows of one kind, one parked and one not,
 * must differ — a rail that dropped the weight when it took the hue would have
 * lost the bit it sorts by, silently, since both rows still render.
 */
test("the group is drawn as weight within the kind's own hue", () => {
  const rows = [
    {
      id: 'parked',
      kind: 'escalation',
      group: 'blocking',
      title: 'An agent is parked on this',
      goalRef: null,
      originRef: null,
      opens: 'ask',
      agentId: 'a1',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'unparked',
      kind: 'escalation',
      group: 'yours',
      title: 'Nothing is waiting on this',
      goalRef: null,
      originRef: null,
      opens: 'ask',
      agentId: null,
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('class="cn-q cn-t-red cn-parked"'), 'a blocking row carries the parked weight');
  assert.ok(html.includes('class="cn-q cn-t-red"'), 'and a row nothing is parked on carries the tone alone');
});

/**
 * The demo goal to open: the first ask that names one. Asserted rather than
 * defaulted to an arbitrary issue — a fixture set with no goal-scoped ask would
 * make every assertion below vacuous instead of failing.
 */
function goalRef(): string {
  const ref = view().needsYou.find((n) => n.goalRef !== null)?.goalRef;
  assert.ok(ref, 'the demo fixtures must carry at least one ask that names a goal');
  return ref;
}

function goalView(mutate: (state: CockpitView['state']) => void = () => {}, ref: string = goalRef()): CockpitView {
  const state = buildDemoState().state;
  mutate(state);
  return buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    viewingScratchpad: null,
    settingsOpen: false,
    spendOpen: false,
    reliabilityOpen: false,
    selectedGoal: ref,
    consolePanel: null,
    tab: 'overview',
  });
}

/**
 * "More work" is how an operator says what they want done next, in words — and
 * the verdict it writes is what puts the goal back in front of pickup once no PR
 * is open. Losing the control loses both, silently and with every type still
 * checking. The floor carried the verdict; this pins that the goal page carries
 * the way to write one.
 */
test('a goal can still be sent back for more work, not only marked done', () => {
  const html = render(goalView());
  assert.ok(html.includes('More work'), 'the goal page must offer the way to say what is left');

  // Offered *again* on a goal already sent back, unlike the verdict-only control
  // it replaced: a second thing the operator wants is a second instruction, and a
  // hidden button would be a goal they can no longer say anything about.
  const already = goalView((s) => {
    const issue = s.world.issues.find((i) => `issue:${i.number}` === goalRef());
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.conclusion = { ...issue.conclusion, verdict: 'more_work' };
    issue.instructions = [
      {
        id: 'ins_demo',
        originRef: `issue:${issue.number}`,
        text: 'change the button to primary',
        createdAt: new Date().toISOString(),
        settledAt: null,
      },
    ];
  });
  const standing = render(already);
  assert.ok(standing.includes('More work'), 'and it still is once one stands');
  assert.ok(standing.includes('change the button to primary'), 'what was asked for is drawn, not just counted');
  assert.ok(standing.includes('Withdraw'), 'and there is a way to take it back');
});

/**
 * The goal-profile gate (#342) reaches the rail, and it draws through the same
 * band on both surfaces.
 *
 * It holds every dispatch for its goal and expires on nothing but the answer, so
 * a gate legible only on the goal's own page is a goal stopped for good with
 * nobody told — the page is not one an operator opens for a goal that looks like
 * it merely has not come up yet.
 */
test('an unanswered profile proposal reaches the rail, not only the goal page', () => {
  const ref = goalRef();
  const gated = (state: CockpitView['state']) => {
    const issue = state.world.issues.find((i) => `issue:${i.number}` === ref);
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.assay = {
      verdict: 'workable',
      summary: 'Three subsystems and an auth guard between them.',
      by: 'assayer',
      decidedAt: new Date(Date.now() - 3600_000).toISOString(),
      commentRef: null,
      proposedProfile: 'deep',
      awaitingProfileAnswer: true,
    };
  };

  const html = decode(render(goalView(gated)));
  assert.ok(html.includes(KIND_LABEL.profile), 'the rail names the kind');
  assert.ok(html.includes('The goal assay wants this run on “deep”'), 'and says what is being asked');
  assert.ok(html.includes('Use “deep”'), 'the band offers the proposal');
  assert.ok(html.includes('Leave it unpinned') || /Keep “/.test(html), 'and the way to keep what is standing');

  // One band, not two: the page draws the gate through the rail's own component,
  // so a second copy here would be a second set of buttons to keep in step with
  // the write.
  assert.equal(html.split('Use “deep”').length - 1, 1, 'the gate is drawn once on the goal page');
});

/**
 * A row and the band it opens are one ask, and hue plus glyph is most of how an
 * operator recognises that they are. The band's own weight is deliberately *not*
 * carried over — it is a single ask already in front of them, with nothing to
 * rank it against — so tone and symbol are the whole of the agreement, and both
 * have to hold.
 */
test('the band on the goal page wears the tone and glyph its rail row does', () => {
  const ref = goalRef();
  const v = goalView();
  const row = v.needsYou.find((n) => n.goalRef === ref && n.opens === 'goal');
  assert.ok(row, 'the demo goal must carry an ask read on its own page');

  const html = render(v);
  assert.ok(html.includes(`cn-needs cn-t-${KIND_TONE[row.kind]}`), "the band takes the kind's tone");
  assert.ok(html.includes(`cn-q cn-t-${KIND_TONE[row.kind]}`), 'and the rail row it came from takes the same one');
  assert.ok(html.includes(KIND_SYMBOL[row.kind]), 'the glyph is drawn on both');
});

/**
 * The shared card is embedded rather than reimplemented compactly, and this is
 * what that buys: the options an agent offered through `escalate` stay one click
 * on the goal page, and a proposal arrives with its verdict buttons instead of a
 * reply box that cannot be branched on. A second implementation would be a second
 * set of refusal rules to keep right — the reason `EscalationCard` has one.
 */
test('the goal page answers with the shared card’s rules rather than its own', () => {
  const row = view().needsYou.find((n) => n.goalRef !== null && n.kind === 'escalation');
  assert.ok(row, 'the demo fixtures must carry a goal-scoped question an agent is parked on');
  const ref = row.goalRef!;

  const withOptions = render(
    goalView((s) => {
      const asked = s.escalations.find((e) => e.id === row.id)!;
      asked.context = { ...asked.context, options: ['Take ours', 'Take theirs'] };
    }, ref),
  );
  assert.match(withOptions, /class="esc-quick"/, 'offered choices stay one click in the band');
  assert.match(withOptions, />Take theirs</);

  // This question alone, turned into a decision — so the absence of a reply box
  // below is this card's, and not read off a second band on the same page.
  const proposal = render(
    goalView((s) => {
      s.escalations = s.escalations.filter((e) => e.id === row.id);
      s.proposals = [{ ...s.proposals![0]!, id: 'p-band', kind: 'merge', status: 'pending', escalationId: row.id }];
    }, ref),
  );
  assert.match(proposal, /needs your decision/, 'a decision must read as one in the band');
  assert.match(proposal, />Approve merge</);
  assert.doesNotMatch(proposal, /placeholder="Your answer…"/, 'a proposal is never answered with free text');
});

test('a selected goal draws its page instead of the overview', () => {
  const v = goalView();
  const html = render(v);
  assert.ok(html.includes('cn-goal'));
  assert.ok(v.goalPage !== null);
  assert.ok(decode(html).includes(String(v.goalPage!.issue.title)));
});

/**
 * The rail's rows and the page are one reading, so while a goal is open the rail
 * must say which of its asks are the ones on screen. Dimming rather than
 * filtering: the rail is the fleet's whole queue, and a blocker dropped from it
 * is a blocker nobody answers.
 */
test('the rail marks the open goal’s asks and mutes the rest', () => {
  const ref = goalRef();
  const rows = [
    {
      id: 'mine',
      kind: 'escalation',
      group: 'blocking',
      title: 'On the open goal',
      goalRef: ref,
      opens: 'goal',
      agentId: 'a1',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'other',
      kind: 'escalation',
      group: 'blocking',
      title: 'On some other goal',
      goalRef: 'issue:9999',
      opens: 'ask',
      agentId: 'a2',
      holding: 0,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      opens: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const opened = render({ ...goalView(), needsYou: rows });
  const wrapper = (title: string): string => {
    const before = opened.slice(0, opened.indexOf(title));
    // `class="cn-q…"` bounded by the closing quote or a space — `cn-qkind` and
    // `cn-qin` share the prefix and would otherwise match as row wrappers.
    const tag = [...before.matchAll(/<(?:button|div)\b[^>]*class="cn-q(?: [^"]*)?"[^>]*>/g)].at(-1);
    assert.ok(tag, `no cn-q wrapper found before "${title}"`);
    return tag[0];
  };

  assert.match(wrapper('On the open goal'), /aria-current="true"/, 'an ask on the open goal is the current row');
  assert.doesNotMatch(wrapper('On the open goal'), /cn-dim/, 'the current row is never the muted one');
  assert.match(wrapper('On some other goal'), /cn-dim/, 'another goal’s ask recedes while this one is open');
  assert.doesNotMatch(
    wrapper('Answered on the banner above'),
    /cn-dim/,
    'the recovery hold blocks every goal, so it is nobody else’s business to mute',
  );

  // With no goal on screen there is nothing to be current *against*: a rail that
  // dimmed here would mute every row it draws.
  const overview = render(view({ needsYou: rows }));
  assert.ok(!overview.includes('cn-dim'), 'the rail mutes nothing while the overview is drawn');
  assert.ok(!overview.includes('aria-current'), 'no row is current while no goal is open');
});

test('the ask is drawn above the plan, which is the whole point of the page', () => {
  const v = goalView();
  if ((v.goalPage?.needs.length ?? 0) === 0) return; // fixtures carry no ask on this goal
  const html = render(v);
  assert.ok(html.indexOf('cn-needs') < html.indexOf('cn-waves'));
});

test('a goal with no ask draws no band at all', () => {
  const v = goalView();
  const html = render({ ...v, goalPage: { ...v.goalPage!, needs: [] } });
  assert.ok(!html.includes('cn-needs'), 'a band with nothing in it is not a band');
});

test('a held part quotes the reconciler’s own reason rather than inventing one', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const first = page.parts[0];
  if (!first) return; // the fixture goal has no plan; the grouping tests cover this

  const parts: GoalPartView[] = [
    {
      part: { ...first.part, status: 'blocked', blockedReason: 'waits on staging credentials' },
      group: 'held',
      agentId: null,
    },
  ];

  const html = render({ ...v, goalPage: { ...page, parts } });
  assert.ok(html.includes('waits on staging credentials'));
});

test('a plan with no live parts draws what it proposed rather than only saying so', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const seed = page.parts[0]?.part ?? v.state.planParts?.[0];
  assert.ok(seed, 'the fixtures must carry a part to retire');

  const html = render({
    ...v,
    goalPage: {
      ...page,
      parts: [],
      retiredParts: [{ ...seed, status: 'retired', title: 'split the store in two' }],
    },
  });

  // The sentence alone left the operator told about a plan they could not read.
  assert.ok(decode(html).includes('Every part of this plan was retired'));
  assert.ok(decode(html).includes('split the store in two'));
  assert.ok(html.includes('cn-retired'));
});

test('the ticket is drawn as HTML when the tracker wrote HTML', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');

  const html = render({
    ...v,
    goalPage: { ...page, issue: { ...page.issue, body: '<div>Login is broken.<br>Twice.</div>' } },
  });

  assert.ok(html.includes('Login is broken.'));
  assert.ok(!html.includes('&lt;div&gt;'), 'the tags are structure, not text to print');
});

test('a held goal is a way into the goal it names', () => {
  // One way into a goal, from every surface that lists one — the queue row, the
  // overview row and this. It is the name rather than the whole row, because the
  // row carries controls of its own and a button cannot hold them.
  //
  // The tickets tab's rows come from its own route, which nothing fetches in a
  // static render; the intake call-out is drawn from the snapshot, so it is the
  // part of the tab this seam can see.
  const html = render(view({ tab: 'tickets' }));
  assert.ok(html.includes('tickets-intake-name'));
});

test('a goal with no measured spend draws no spend row rather than $0.00', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');

  const measured = render({
    ...v,
    goalPage: {
      ...page,
      issue: {
        ...page.issue,
        spend: {
          originRef: `issue:${page.issue.number}`,
          issueNumber: page.issue.number,
          costUsd: 6.4,
          inputTokens: 0,
          outputTokens: 0,
          agents: 7,
        },
      },
    },
  });
  assert.ok(measured.includes('$6.40'), 'a measured goal states what it cost');

  const unmeasured = render({ ...v, goalPage: { ...page, issue: { ...page.issue, spend: null } } });
  assert.ok(!unmeasured.includes('$0.00'), 'null is "never measured", not zero');
});

test('with no goal selected the overview draws its five cards', () => {
  const html = render(view());
  for (const title of ['Fleet', 'Goals in flight', 'Pull requests', 'Up next', 'World signals']) {
    assert.ok(html.includes(title), `the overview is missing ${title}`);
  }
});

test('a queued item states why it is held, in the queue’s own words', () => {
  const v = view();
  const held = v.state.upcoming?.items.filter((i) => i.reason !== '');
  if (!held?.length) return;
  // Decoded: a queue reason quotes a part slug, and React escapes the quotes in
  // the text node — the assertion is about the sentence, not its encoding. Tags
  // stripped too: a `#341` in the reason is drawn as a link, so the sentence is
  // several text nodes on the page and one string only once the markup is gone.
  const text = decode(render(v).replace(/<[^>]*>/g, ''));
  for (const item of held) assert.ok(text.includes(item.reason), `the queue dropped: ${item.reason}`);
});

test('an empty rack still draws — a surface that vanishes reads as one that broke', () => {
  const v = view();
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, pullRequests: [] } } });
  assert.ok(html.includes('Pull requests'));
});

test('an unwatched PR is drawn spent, not at the same weight as the ones being worked', () => {
  const v = view();
  const prs = v.state.world.pullRequests;
  const first = prs[0];
  assert.ok(first, 'the demo fixtures must carry an open PR');
  const ignored = {
    ...first,
    labels: [],
    attention: {
      status: 'unwatched' as const,
      reasons: [`not tagged "${v.state.config.watchLabel}" — the harness is leaving it alone`],
    },
  };
  const html = render({
    ...v,
    state: { ...v.state, world: { ...v.state.world, pullRequests: [ignored, ...prs.slice(1)] } },
  });
  // The row this PR is drawn in, not "some row on the page": the overview draws
  // several kinds of row and one of them being spent proves nothing.
  const row = html.split('<div class="cn-row').find((chunk) => chunk.includes(ignored.title));
  assert.ok(row, 'the unwatched PR is still listed — one that vanishes is the other bug');
  assert.ok(row.startsWith(' cn-spent'), 'the unwatched PR’s row carries the spent tone');
  // The court chip still names it, in the server's own word — the tone is the
  // second reading, never a replacement for the first.
  assert.ok(html.includes('>unwatched</i>'), 'the court chip says which arm it is');
});

test('a goal row is a way into its page', () => {
  const html = render(view());
  assert.ok(html.includes('cn-goal-row'));
});

/**
 * The backlog's four groups became the tickets tab's watch filter (#351), and its
 * intake group became the call-out above the list. What the group *argued* — that
 * an `unclear` assay is the one intake reading that stops dispatch, so it must be
 * pulled out rather than greyed inside the watched rows — is what these assert.
 *
 * The tab's rows arrive from its own route, which a static render does not fetch,
 * so the arrangement those groups used to cover is tested against `featureBlocks`
 * in `test/issueGroups.test.ts` instead.
 */
test('a goal the assay refused is pulled out of the list, quoted, with its override beside it', () => {
  const v = view({ tab: 'tickets' });
  const intake = v.state.world.issues.find((i) => i.assay?.verdict === 'unclear');
  assert.ok(intake, 'the demo fixtures must carry a goal the assay refused');
  const assay = intake.assay;
  assert.ok(assay);

  const decoded = decode(render(v));
  assert.ok(decoded.includes('held at intake'), 'the call-out names what is holding the work');
  assert.ok(decoded.includes(assay.summary), 'the assayer’s own words are quoted, never reworded');
  assert.ok(decoded.includes('Override → workable'), 'and the one button that unblocks it sits on the row');
});

test('nothing held at intake draws no call-out at all', () => {
  // Unlike the group it replaces, which was drawn empty because a group that
  // vanishes reads as one that broke: a call-out is an exception being raised, and
  // an exception nobody has is not a heading, it is silence.
  const v = view({ tab: 'tickets' });
  const issues = v.state.world.issues.map((i) => ({ ...i, assay: null }));
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues } } });
  assert.ok(!html.includes('tickets-intake'), 'no goal is held, so nothing claims one is');
});

test('the fault log keeps its clear even when it is empty', () => {
  const v = view({ consolePanel: 'faults' });
  const html = render({ ...v, state: { ...v.state, errors: [] } });
  assert.ok(html.includes('Clear'), 'the only route to clear must not depend on there being rows');

  const full = render(v);
  const first = v.state.errors[0];
  assert.ok(first, 'the demo fixtures must carry a recorded fault');
  assert.ok(
    full.indexOf('Clear') < full.indexOf(first.message),
    'one misclick between “leave” and “delete the only copy” is too few',
  );
});

test('a reading opens the panel behind it, in front of the console', () => {
  const panels: [ConsolePanel, string][] = [
    ['findings', 'Findings'],
    ['lessons', 'Lessons'],
    ['faults', 'Faults'],
    ['output', 'Output'],
    ['launch', 'Launch'],
  ];
  for (const [panel, title] of panels) {
    const html = render(view({ consolePanel: panel }));
    assert.ok(html.includes('cn-backdrop'), `${String(panel)} must draw in front of the console`);
    assert.ok(html.includes(`<h2>${title}</h2>`), `${String(panel)} must name itself`);
  }
});

test('the lessons panel draws the retired ones too', () => {
  // The load-bearing half of the prune surface (#355): a lesson that vanished on
  // being retired would leave no way to tell a list you have finished with from
  // one that lost rows, and "retired" would read as "deleted".
  const v = view({ consolePanel: 'lessons' });
  const retired = v.state.lessons.find((l) => l.status === 'retired');
  assert.ok(retired, 'the demo fixtures must carry a retired lesson to draw');
  // The first plain run of the fixture's text: markdown renders its inline code
  // into its own element, so a longer slice would be split across nodes.
  assert.ok(decode(render(v)).includes(retired.text.slice(0, 28)), 'a pruned lesson stays visible');
});

/**
 * The demo carries no goal-less ask on purpose — every fixture pull request has a
 * ticket that owns it — so the orphan is built here: the state the harness does
 * reach when it works a ticketless PR, which is the case the panel exists for.
 */
function orphanAsk(): { v: CockpitView; row: CockpitView['needsYou'][number] } {
  const base = view();
  const found = base.needsYou.find((n) => n.kind === 'escalation' || n.kind === 'proposal' || n.kind === 'permission');
  assert.ok(found, 'the demo fixtures must carry an escalation to build the orphan from');
  const row = { ...found, goalRef: null, originRef: 'pr:9999', opens: 'ask' as const };
  return { v: { ...base, needsYou: [row, ...base.needsYou.filter((n) => n.id !== row.id)] }, row };
}

test('an ask with no goal page is answered in the ask panel', () => {
  const { v, row } = orphanAsk();

  const html = render({ ...v, consolePanel: { ask: row.id } });
  assert.ok(html.includes('cn-backdrop'), 'the ask must draw in front of the console');
  assert.ok(
    html.includes(`<h2>${KIND_SYMBOL[row.kind]} Needs you · ${KIND_LABEL[row.kind]}</h2>`),
    'the panel names the ask the rail named, under the same glyph',
  );
  // The shared card, not a second wiring: its own controls are what answer the ask.
  assert.ok(html.includes('escalation-prompt'), 'the panel embeds the shared escalation card');
});

/**
 * The panel is the one surface with nothing drawn around the ask, so it has to
 * name the subject itself — and "no goal" has to read as a fact rather than as a
 * line that failed to load.
 */
test('the ask panel says what the ask is about, and says so when there is no goal', () => {
  const { v, row } = orphanAsk();
  const orphan = decode(render({ ...v, consolePanel: { ask: row.id } }));
  assert.match(orphan, /No linked goal/, 'an ask with no goal must say so in those words');
  assert.match(orphan, /#9999/, 'and still name the pull request it was raised on');

  // The same panel opened from a goal's band: the subject is that goal, and it is
  // a way back onto its page rather than a label.
  const onGoal = v.needsYou.find((n) => n.goalRef !== null);
  assert.ok(onGoal, 'the demo fixtures must carry an ask that names a goal');
  const linked = decode(render({ ...v, consolePanel: { ask: onGoal.id } }));
  assert.match(linked, /On goal/);
  assert.match(linked, new RegExp(`cn-goto[^<]*>\\s*${onGoal.goalRef!.replace('issue:', '#')}`));
});

test('the ask panel closes itself once the row it was drawing is settled', () => {
  const v = view();
  const row = v.needsYou[0];
  assert.ok(row, 'the demo fixtures must carry an ask');

  // What answering it looks like in the next snapshot: the row is gone from the
  // queue, so a panel still holding its id has nothing left to offer a verdict on.
  const html = render({ ...v, consolePanel: { ask: row.id }, needsYou: v.needsYou.filter((n) => n.id !== row.id) });
  assert.ok(!html.includes('cn-backdrop'), 'a settled ask must not leave a panel standing');
});

test('injection rides in the launch panel, and the demo build is the whole of it', () => {
  assert.match(render(view({ consolePanel: 'launch' })), /class="inject"/);
  assert.doesNotMatch(
    render(view({ consolePanel: 'launch', demo: false })),
    /class="inject"/,
    'a real run must not offer a panel that lies to the harness',
  );
});

test('each tab replaces the last, and a selected goal outranks every one of them', () => {
  assert.ok(render(view()).includes('World signals'), 'the overview is the tab the console opens on');
  assert.ok(!render(view({ tab: 'tickets' })).includes('World signals'), 'a tab replaces the one before it');
  assert.ok(!render(view({ tab: 'work' })).includes('World signals'));

  // A queue row selects a goal without moving the nav, so the goal has to win —
  // otherwise clicking an ask lands on a triage list, or on the record.
  const v = goalView();
  for (const tab of ['tickets', 'work'] as const) {
    assert.ok(render({ ...v, tab }).includes('cn-goal'), `a goal must outrank the ${tab} tab`);
  }
});

/**
 * The work graph is the one surface that outlives the world snapshot, and it used
 * to hang off the bottom of the shell below the whole console — reachable only by
 * scrolling past every panel. It is a destination now. The nav is what says so:
 * three tabs, so a tab added to `ConsoleTab` and forgotten in the nav fails here
 * rather than being a view nothing can reach.
 */
test('the work graph is a nav destination, not a strip under the page', () => {
  const nav = render(view()).split('</nav>')[0] ?? '';
  for (const label of ['Overview', 'Work', 'Tickets']) {
    assert.ok(nav.includes(`>${label}`), `the nav is missing ${label}`);
  }

  assert.ok(render(view({ tab: 'work' })).includes('work-panel'), 'the Work tab draws the graph');
  assert.ok(!render(view()).includes('work-panel'), 'and no other tab draws it');
});

test('the shell renders the console, and the drawer that the console only asks for', () => {
  const src = readFileSync(new URL('../web/src/App.tsx', import.meta.url).pathname, 'utf8');
  assert.ok(src.includes('ConsoleRoot'), 'the shell must render the console');
  // The drawer is overlaid rather than placed, and which agent is open is cockpit
  // state — the subscription is tied to it. The console asks with
  // `actions.select(id)` and the shell answers; without this the three call sites
  // that open an agent do nothing at all.
  assert.ok(src.includes('AgentDrawer'), 'the shell must answer the console’s request for a drawer');
  // The graph moved into the console's nav. Left here as well it would draw twice,
  // once below everything, which is the surface this replaced. Asserted on the
  // import and the element, not on the name: the shell's own comments cite
  // `WorkTreePanel` as the precedent for what else hangs off the shell, and a
  // substring test made writing down the reason a build failure.
  assert.ok(!/import\s+\{[^}]*WorkTreePanel/.test(src), 'the shell must not import the work graph');
  assert.ok(!src.includes('<WorkTreePanel'), 'the work graph is the console’s Work tab, not a strip under it');
});
