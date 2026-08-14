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
import { KIND_LABEL } from '../web/src/console/QueueRail.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Panel } = await import('../web/src/console/Panel.js');

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

const render = (v: CockpitView) => renderToStaticMarkup(createElement(ConsoleRoot, { view: v, actions }));

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

  // The row wrapper is the element whose class is `cn-q` alone or `cn-q
  // cn-urgent` — anchoring on the whole attribute rules out `cn-qin`/`cn-qkind`,
  // which are unrelated inner elements that happen to share the `cn-q` prefix.
  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    // Attribute order differs between the two tags (`<button type="button"
    // class="…">` vs `<div class="…">`), so match the whole opening tag and
    // check its attributes rather than assuming `class` comes first.
    const matches = [...before.matchAll(/<(button|div)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /class="cn-q(?: cn-urgent)?"/.test(attrs ?? ''),
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
 * `more_work` is a verdict the harness acts on — it puts the goal back in front
 * of pickup once no PR is open — so losing the only control that sets it loses
 * the behaviour, silently and with every type still checking. The floor carried
 * it; this pins that the goal page carries it too.
 */
test('a goal can still be sent back for more work, not only marked done', () => {
  const html = renderToStaticMarkup(createElement(ConsoleRoot, { view: goalView(), actions }));
  assert.ok(html.includes('Work left'), 'the goal page must offer the more_work verdict');

  const already = goalView((s) => {
    const issue = s.world.issues.find((i) => `issue:${i.number}` === goalRef());
    assert.ok(issue, 'the fixture goal must be in the world');
    issue.conclusion = { ...issue.conclusion, verdict: 'more_work' };
  });
  assert.ok(
    !renderToStaticMarkup(createElement(ConsoleRoot, { view: already, actions })).includes('Work left'),
    'a goal already sent back does not offer the same verdict again',
  );
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
  assert.ok(decode(html).includes('The plan has no live parts'));
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

test('a backlog row is a way into the goal it names', () => {
  // One way into a goal, from every surface that lists one — the queue row, the
  // overview row and this. It is the name rather than the whole row, because a
  // backlog row carries controls of its own and a button cannot hold them.
  const html = render(view({ tab: 'backlog' }));
  assert.ok(html.includes('cn-grow cn-goal-row'));
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
  // the text node — the assertion is about the sentence, not its encoding.
  const html = decode(render(v));
  for (const item of held) assert.ok(html.includes(item.reason), `the queue dropped: ${item.reason}`);
});

test('an empty rack still draws — a surface that vanishes reads as one that broke', () => {
  const v = view();
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, pullRequests: [] } } });
  assert.ok(html.includes('Pull requests'));
});

test('an ignored PR is drawn spent, not at the same weight as the ones being worked', () => {
  const v = view();
  const prs = v.state.world.pullRequests;
  const first = prs[0];
  assert.ok(first, 'the demo fixtures must carry an open PR');
  const ignored = {
    ...first,
    labels: [v.state.config.ignoreLabel],
    attention: { status: 'ignored' as const, reasons: ['tagged "lubbdubb-ignore" — the harness is leaving it alone'] },
  };
  const html = render({
    ...v,
    state: { ...v.state, world: { ...v.state.world, pullRequests: [ignored, ...prs.slice(1)] } },
  });
  // The row this PR is drawn in, not "some row on the page": the overview draws
  // several kinds of row and one of them being spent proves nothing.
  const row = html.split('<div class="cn-row').find((chunk) => chunk.includes(ignored.title));
  assert.ok(row, 'the ignored PR is still listed — an ignored PR that vanishes is the other bug');
  assert.ok(row.startsWith(' cn-spent'), 'the ignored PR’s row carries the spent tone');
  // The court chip still names it, in the server's own word — the tone is the
  // second reading, never a replacement for the first.
  assert.ok(html.includes('>ignored</i>'), 'the court chip says which arm it is');
});

test('a goal row is a way into its page', () => {
  const html = render(view());
  assert.ok(html.includes('cn-goal-row'));
});

/**
 * The one `<button …>` opening tag whose *attributes* carry `needle`.
 *
 * Opening tags only, so a string that also appears in a row's text cannot be
 * mistaken for the control that quotes it — and exactly one, because "some button
 * on the page says this" is the assertion that passes with the wrong button.
 */
function buttonWith(html: string, needle: string): string {
  const tags = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(needle));
  assert.equal(tags.length, 1, `expected exactly one button whose attributes mention "${needle}"`);
  const tag = tags[0];
  assert.ok(tag);
  return tag;
}

/** Every backlog group heading, in document order. */
function groupHeadings(html: string): string[] {
  return [...html.matchAll(/<div class="cn-grpname">([^<]*)/g)].map((m) => (m[1] ?? '').trim());
}

const BACKLOG_GROUPS = ['Watched', 'Blocked at intake', 'Unwatched', 'Ignored'];

test('the backlog groups by watch state and gives intake its own group', () => {
  const v = view({ tab: 'backlog' });
  const html = render(v);
  assert.deepEqual(groupHeadings(html), BACKLOG_GROUPS, 'four groups, in the order triage reads them');

  // Intake is pulled *out* of Watched rather than greyed inside it: an `unclear`
  // assay is the one intake reading that stops dispatch, and among watched rows
  // it reads as a detail instead of as the thing holding all work.
  const intake = v.state.world.issues.find((i) => i.assay?.verdict === 'unclear');
  assert.ok(intake, 'the demo fixtures must carry a goal the assay refused');
  const assay = intake.assay;
  assert.ok(assay);

  const decoded = decode(html);
  const quoted = decoded.indexOf(assay.summary);
  assert.ok(quoted !== -1, 'the assayer’s own words are quoted, never reworded');
  assert.ok(
    decoded.indexOf('Blocked at intake') < quoted && quoted < decoded.indexOf('Unwatched'),
    'the refused goal belongs in the intake group, not in Watched',
  );
});

test('a backlog group with nothing in it is muted, never removed', () => {
  const v = view({ tab: 'backlog' });
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues: [] } } });
  assert.deepEqual(groupHeadings(html), BACKLOG_GROUPS, 'a group that vanishes when quiet reads as one that broke');
});

test('a feature is a heading over its work, never a row beside it', () => {
  const v = view({ tab: 'backlog' });
  const container = v.state.world.issues.find((i) => i.pickup.status === 'container');
  assert.ok(container, 'the demo fixtures must carry a container');
  const html = render(v);

  // The feature's own line is the heading, and the fold beside it is what makes a
  // long one collapsible to that line.
  const headings = [...html.matchAll(/<div class="cn-subhead[^"]*">/g)];
  assert.ok(headings.length > 0, 'a tracker with a tree draws feature headings');
  assert.ok(html.includes('aria-expanded="true"'), 'every feature is open until the operator folds one');

  // …and it is not also drawn as an ordinary row, which is the whole complaint:
  // an item nothing is ever dispatched at, sitting in the list being triaged.
  const rows = [...html.matchAll(/<div class="cn-row[^"]*">/g)].length;
  const nested = [...html.matchAll(/<div class="cn-row[^"]*cn-nested[^"]*">/g)].length;
  assert.ok(nested > 0, 'the work under a feature is indented to it');
  assert.ok(nested <= rows);
});

test('folding a feature hides its work and keeps its heading', () => {
  const v = view({ tab: 'backlog' });
  const container = v.state.world.issues.find((i) => i.pickup.status === 'container');
  assert.ok(container);
  // A child the world holds as an issue of its own — the rows the fold hides are
  // those, not the relation summaries the feature merely names.
  const child = v.state.world.issues.find((i) => i.parent?.number === container.number && i.state === 'open');
  assert.ok(child, 'the demo fixtures must carry an open item under that container');

  const open = render(v);
  const folded = render({ ...v, collapsedFeatures: new Set([container.number]) });

  assert.ok(decode(open).includes(child.title), 'open by default — a surface that hides the backlog reports none');
  assert.ok(!decode(folded).includes(child.title), 'folding puts the work away');
  assert.ok(decode(folded).includes(container.title), 'and leaves the heading, or there is nothing to unfold');
  assert.ok(folded.includes('aria-expanded="false"'));
});

test('a container is a heading over its work, and watching it says what it will cascade to', () => {
  const v = view({ tab: 'backlog' });
  const container = v.state.world.issues.find((i) => i.pickup.status === 'container');
  assert.ok(container, 'the demo fixtures must carry an item the harness refuses as a container');

  // Untagged, so it falls into the triage group, which is the group that draws a
  // Watch button at all. The fixture's container carries the watch label.
  const issues = v.state.world.issues.map((i) => (i.number === container.number ? { ...i, labels: [] } : i));
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues } } });

  // The container is live in both directions now: watching a Feature tags every
  // item beneath it, which is what "work this feature" has always meant, so the
  // click the toggle offers is one the harness keeps.
  const toggle = buttonWith(html, `Tag #${container.number}`);
  assert.doesNotMatch(toggle, / disabled=""/, 'watching a feature is a real act, not a refused one');
  const kids = container.children?.length ?? 0;
  assert.ok(kids > 0, 'the demo fixtures must carry a container with work under it');
  assert.match(
    toggle,
    new RegExp(`and its ${kids} child item`),
    'the title states the cascade — a click writing eight tags must say eight',
  );

  const open = v.state.world.issues.find((i) => i.pickup.status === 'unwatched');
  assert.ok(open, 'the demo fixtures must carry an open item nobody has opted in');
  assert.doesNotMatch(buttonWith(html, `#${open.number}`), / disabled=""/, 'an ordinary item is still watchable');
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
  assert.ok(html.includes(`<h2>Needs you · ${KIND_LABEL[row.kind]}</h2>`), 'the panel names the ask the rail named');
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
  assert.ok(!render(view({ tab: 'backlog' })).includes('World signals'), 'a tab replaces the one before it');
  assert.ok(!render(view({ tab: 'work' })).includes('World signals'));

  // A queue row selects a goal without moving the nav, so the goal has to win —
  // otherwise clicking an ask lands on a triage list, or on the record.
  const v = goalView();
  for (const tab of ['backlog', 'work'] as const) {
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
  for (const label of ['Overview', 'Backlog', 'Work']) {
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
