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

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { Panel } = await import('../web/src/console/Panel.js');
const { BacklogBody } = await import('../web/src/console/Backlog.js');
const { HumanTaskActions } = await import('../web/src/components/HumanTaskActions.js');

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
      backlogOpen: false,
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

test('a row with a goalRef is a button; the recovery hold (no goalRef) is not', () => {
  const rows = [
    {
      id: 'clickable',
      kind: 'escalation',
      group: 'blocking',
      title: 'Opens a goal',
      goalRef: 'issue:9',
      agentId: 'a1',
      holding: 1,
      raisedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: 'Answered on the banner above',
      goalRef: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));

  // The row wrapper is the element opening `class="cn-q "` or `class="cn-q
  // cn-urgent"` — the trailing space after `cn-q` rules out `cn-qin`/`cn-qkind`,
  // which are unrelated inner elements that happen to share the `cn-q` prefix.
  const rowWrapper = (title: string): string => {
    const titlePos = html.indexOf(title);
    assert.ok(titlePos !== -1, `row "${title}" must render`);
    const before = html.slice(0, titlePos);
    // Attribute order differs between the two tags (`<button type="button"
    // class="…">` vs `<div class="…">`), so match the whole opening tag and
    // check its attributes rather than assuming `class` comes first.
    const matches = [...before.matchAll(/<(button|div)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /class="cn-q (?:cn-urgent)?"/.test(attrs ?? ''),
    );
    const last = matches.at(-1);
    assert.ok(last, `no cn-q wrapper found before "${title}"`);
    const tag = last[1];
    assert.ok(tag, `unmatched capture group for "${title}"`);
    return tag;
  };

  assert.equal(rowWrapper('Opens a goal'), 'button', 'a row with a goalRef is a button');
  assert.equal(
    rowWrapper('Answered on the banner above'),
    'div',
    'the recovery row has no goalRef and must not be wrapped in a button',
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
    backlogOpen: false,
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
  const v = view({ backlogOpen: true });
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
  const v = view({ backlogOpen: true });
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues: [] } } });
  assert.deepEqual(groupHeadings(html), BACKLOG_GROUPS, 'a group that vanishes when quiet reads as one that broke');
});

test('a container type is disabled rather than absent — “cannot be picked up” is worth seeing', () => {
  const v = view({ backlogOpen: true });
  const container = v.state.world.issues.find((i) => i.pickup.status === 'container');
  assert.ok(container, 'the demo fixtures must carry an item the harness refuses as a container');
  const reason = container.pickup.reasons[0];
  assert.ok(reason, 'the server says why it refuses one — the button quotes that and invents nothing');

  // Untagged, so it falls into the triage group, which is the group that draws a
  // Watch button at all. The fixture's container carries the watch label.
  const issues = v.state.world.issues.map((i) => (i.number === container.number ? { ...i, labels: [] } : i));
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues } } });

  // Deliberately not `html.includes('disabled')`: the console draws other
  // disabled buttons (the rack's ignore toggle, with no ignore label configured),
  // so that assertion passes with no container on the page at all.
  assert.match(buttonWith(html, 'is a container'), / disabled=""/, 'the button is drawn, and refuses');

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

test('injection rides in the launch panel, and the demo build is the whole of it', () => {
  assert.match(render(view({ consolePanel: 'launch' })), /class="inject"/);
  assert.doesNotMatch(
    render(view({ consolePanel: 'launch', demo: false })),
    /class="inject"/,
    'a real run must not offer a panel that lies to the harness',
  );
});

test('the backlog replaces the overview, and a selected goal outranks both', () => {
  assert.ok(render(view()).includes('World signals'), 'no goal and no backlog is the overview');
  assert.ok(!render(view({ backlogOpen: true })).includes('World signals'), 'the backlog replaces the overview');

  // A queue row selects a goal without closing whatever the nav left open, so the
  // goal has to win — otherwise clicking an ask lands on the backlog.
  const v = goalView();
  assert.ok(render({ ...v, backlogOpen: true }).includes('cn-goal'));
});

test('the shell renders the console, and the drawer that the console only asks for', () => {
  const src = readFileSync(new URL('../web/src/App.tsx', import.meta.url).pathname, 'utf8');
  assert.ok(src.includes('ConsoleRoot'), 'the shell must render the console');
  // `AgentDrawer` seeds itself over its own route, so it cannot live under
  // `console/`. The console asks with `actions.select(id)` and the shell answers —
  // without this the three call sites that open an agent do nothing at all.
  assert.ok(src.includes('AgentDrawer'), 'the shell must answer the console’s request for a drawer');
});

// ---------------------------------------------------------------------------
// The rack's chains, the backlog's second axis, and the settled tail — the three
// surfaces added for capabilities that shipped end-to-end with no reader.
// ---------------------------------------------------------------------------

test('a chain draws as one block, bottom rung first, with its rungs numbered', () => {
  const v = view();
  const stack = v.state.stacks[0];
  assert.ok(stack, 'the demo fixtures must carry a stack');
  const html = render(v);

  assert.ok(html.includes('cn-chain'), 'a chain is drawn as a chain, not as loose rows');
  assert.ok(html.includes(`Stack of ${stack.rungs.length}`));

  // Merge order is the rung order, and the rack must not re-sort it: the bottom
  // rung is the only one `pr-merge-ready` will ever propose first. Measured from
  // the chain's own block — a PR number also appears in other cards, and the
  // page-wide index would be reading one of those.
  // Measured over the rung *rows*, not the whole page and not the header: a PR
  // number appears in other cards, and in the header it appears in the server's
  // blocking reason, which names whichever rung is red rather than the bottom one.
  const block = html.slice(html.indexOf('cn-row cn-rung'));
  const positions = stack.rungs.map((r) => block.indexOf(`#${r.prNumber}`));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    'rungs are drawn bottom-first',
  );
  assert.ok(block.indexOf('Rung 1') < block.indexOf('Rung 2'), 'the rung numbers run bottom-first too');
});

test('the land button is disabled with the server’s own reason, never hidden', () => {
  const v = view();
  const landing = v.state.stackLandings.find((l) => !l.offer && l.blockedBy !== null);
  assert.ok(landing, 'the demo fixtures must carry a chain that is not ready to land');
  const blockedBy = landing.blockedBy;
  assert.ok(blockedBy);

  const tag = buttonWith(decode(render(v)), 'Not ready to land');
  assert.ok(tag.includes('disabled'), 'a chain with an unread rung must not be clickable');
  assert.ok(tag.includes(blockedBy), 'the withheld button states the server’s first reason verbatim');
});

test('a standing intent reports its own scope, not the chain as it reads now', () => {
  const v = view();
  const first = v.state.stackLandings[0];
  assert.ok(first, 'the demo fixtures must carry a chain');
  const landing = {
    ...first,
    offer: true,
    landed: 1,
    landing: {
      id: 'sl1',
      ref: first.ref,
      // Two rungs authorized where the chain now has three: the reading must
      // come off the intent, or a rung stacked on afterwards silently reads as
      // authorized.
      rungs: [1, 2],
      status: 'standing' as const,
      reason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  const html = render({ ...v, state: { ...v.state, stackLandings: [landing] } });
  assert.ok(html.includes('landing 1 of 2'), 'progress is counted against the authorized rungs');
});

test('a chain the open list no longer holds whole is not drawn as a chain', () => {
  const v = view();
  const stack = v.state.stacks[0];
  assert.ok(stack);
  const gone = stack.rungs[stack.rungs.length - 1]?.prNumber;
  assert.ok(gone !== undefined);

  const world = { ...v.state.world, pullRequests: v.state.world.pullRequests.filter((pr) => pr.number !== gone) };
  const html = render({ ...v, state: { ...v.state, world } });
  assert.ok(!html.includes(`Stack of ${stack.rungs.length}`), 'a header must not claim a rung nobody can see');
});

test('the backlog offers a second axis only where the tracker reports one', () => {
  const v = view({ backlogOpen: true });
  assert.ok(render(v).includes('cn-axis'), 'a tracker with a hierarchy gets the choice');

  // Every parent and container stripped: `groupByFeature` refuses, and a control
  // offering an arrangement the tracker cannot produce is worse than its absence.
  const flat = v.state.world.issues.map((i) => ({
    ...i,
    parent: undefined,
    pickup: { ...i.pickup, status: i.pickup.status === 'container' ? ('unwatched' as const) : i.pickup.status },
  }));
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, issues: flat } } });
  assert.ok(!html.includes('cn-axis'), 'a flat tracker is offered no axis at all');
});

test('the feature axis heads each group and files its items under it', () => {
  const v = view({ backlogOpen: true });
  const html = decode(
    renderToStaticMarkup(createElement(BacklogBody, { byFeature: true, onAxis: () => undefined, view: v, actions })),
  );
  const feature = v.state.world.issues.find((i) => i.pickup.status === 'container');
  assert.ok(feature, 'the demo fixtures must carry a container the harness refuses to work');
  const child = v.state.world.issues.find((i) => i.parent?.number === feature.number && i.state === 'open');
  assert.ok(child, 'that container must have an open child');

  const heading = html.indexOf(`#${feature.number} ${feature.title}`);
  assert.ok(heading !== -1, 'the feature heads its own group');
  assert.ok(heading < html.indexOf(child.title), 'its items are filed under it');

  // The watch-state headings are the other axis, and only one is drawn at a time.
  assert.ok(!html.includes('Blocked at intake'), 'the two axes do not draw at once');
});

test('the settled tail keeps its place on a goal with nothing settled', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  assert.ok(
    render({ ...v, goalPage: { ...page, settledTasks: [] } }).includes('Settled asks'),
    'a section that vanishes when quiet reads as one that broke',
  );
});

test('a settled task offers dismiss and neither verdict; an open one the reverse', () => {
  const settled = (view().state.humanTasks ?? []).find((t) => t.status !== 'open' && t.dismissedAt === null);
  assert.ok(settled, 'the demo fixtures must carry a settled, undismissed task');

  const noop = () => undefined;
  const html = renderToStaticMarkup(
    createElement(HumanTaskActions, { task: settled, onDone: noop, onDecline: noop, onDismiss: noop }),
  );
  assert.ok(html.includes('Dismiss'), 'a settled row is cleared off the bench, not re-answered');
  assert.ok(!html.includes('Done') && !html.includes('Decline'), 'a settled row has no verdict left to cast');

  // The store refuses to dismiss an open row (409), so the button must not be
  // offered on one — the same rule, stated once on each side of the wire.
  const open = { ...settled, status: 'open' as const, resolution: null, resolvedAt: null };
  const openHtml = renderToStaticMarkup(
    createElement(HumanTaskActions, { task: open, onDone: noop, onDecline: noop, onDismiss: noop }),
  );
  assert.ok(!openHtml.includes('Dismiss'), 'hiding an open obligation is not one of its two answers');
  assert.ok(openHtml.includes('Done') && openHtml.includes('Decline'));
});

test('the settled tail carries only rows the dismiss route can settle', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page);
  const tasks = page.settledTasks;
  for (const task of tasks) {
    assert.notEqual(task.status, 'open', 'an open obligation is answered above, never hidden from here');
    assert.equal(task.dismissedAt, null, 'a dismissed row is already off the bench');
  }
});
