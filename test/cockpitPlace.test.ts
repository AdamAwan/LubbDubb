import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIVE_WORK,
  NOWHERE,
  placeQuery,
  readPlace,
  statePick,
  widenedFor,
  type Place,
} from '../web/src/cockpit/place.js';
import { GOAL_SECTIONS } from '../web/src/view/goalPage.js';

const at = (over: Partial<Place> = {}): Place => ({ ...NOWHERE, ...over });

test('the overview with nothing open is a bare URL', () => {
  assert.equal(placeQuery(NOWHERE), '');
  assert.deepEqual(readPlace(''), NOWHERE);
  assert.deepEqual(readPlace('?'), NOWHERE);
});

test('every place round-trips through the query string', () => {
  const places: Place[] = [
    at({ tab: 'tickets' }),
    at({ tab: 'tickets', ticketTracking: 'frozen', ticketState: 'In Review' }),
    at({ tab: 'tickets', ticketFeature: 812, ticketGroup: 'flat', ticketOrder: 'changed' }),
    at({ tab: 'tickets', ticketFeature: 'none' }),
    at({ tab: 'tickets', ticketView: 'card' }),
    at({ tab: 'tickets', ticketView: 'card', ticketColumns: ['Closed', 'Removed'] }),
    at({ tab: 'tickets', ticketColumns: ['Removed'] }),
    at({ panel: 'record' }),
    at({ goal: 'issue:142' }),
    at({ tab: 'tickets', goal: 'issue:142', agent: 'agent-7' }),
    at({ tab: 'obstacles' }),
    at({ tab: 'obstacles', obstacle: 'obs_abc' }),
    at({ tab: 'obstacles', obstacle: 'obs_abc', obstacleEnded: true }),
    at({ panel: 'faults' }),
    at({ panel: 'launch' }),
    at({ panel: { ask: 'esc-9' } }),
    at({ plan: 'plan-395' }),
    at({ retro: 'issue:142' }),
    at({ scratchpad: 'issue:142' }),
    at({ goal: 'issue:142', pr: 706 }),
    at({ tab: 'tickets', goal: 'issue:142', pr: 706, agent: 'agent-7' }),
    at({ goal: 'issue:142', reviewPack: 684 }),
    at({ goal: 'issue:142', reviewPack: 684, reviewIdea: 'idea_V1StGXR8-Z5jdHi6' }),
    at({ goal: 'issue:142', reviewPack: 684, reviewIdea: 'all' }),
    at({ hatch: 'pet_7f2a1c' }),
    at({ panel: 'pets', hatch: 'pet_7f2a1c' }),
    at({ tab: 'config' }),
    at({ tab: 'config', configTab: 'prompts', configGroup: 'Agents' }),
    at({ tab: 'insights' }),
    at({ tab: 'insights', insightsView: 'causes', insightsWindow: '24h' }),
    at({ tab: 'insights', insightsWindow: 'all' }),
    at({ tab: 'insights', insightsScope: 'pool' }),
    at({ tab: 'insights', insightsScope: 'pool', insightsView: 'throughput', poolProject: 'acme-api' }),
    at({ goal: 'issue:142', goalOpen: ['signals'], goalShut: ['ticket'] }),
    at({ tab: 'features' }),
    at({ tab: 'features', featureCard: 812 }),
    at({ tab: 'features', featureCard: 812, featureSort: 'spend', featurePrs: 'all' }),
    at({ tab: 'features', featureSort: 'moved' }),
    at({ tab: 'features', featurePrs: 'done' }),
  ];
  for (const place of places) assert.deepEqual(readPlace(placeQuery(place)), place, placeQuery(place));
});

test('every panel the type admits round-trips through the URL', () => {
  const source = readFileSync('web/src/cockpit/actions.ts', 'utf8');
  const declaration = /export type ConsolePanel =([\s\S]*?);/.exec(source)?.[1];
  assert.ok(declaration, 'ConsolePanel is declared where this test looks for it');
  const panels = [...declaration.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(panels.length >= 5, `found ${panels.length} panels, which is too few to be the real list`);
  for (const panel of panels) {
    const place = at({ panel: panel as Place['panel'] });
    assert.deepEqual(readPlace(placeQuery(place)), place, `panel=${panel} is dropped by readPlace`);
  }
});

test('every config section the type admits round-trips through the URL', () => {
  const source = readFileSync('web/src/cockpit/actions.ts', 'utf8');
  const declaration = /export type ConfigTab =([\s\S]*?);/.exec(source)?.[1];
  assert.ok(declaration, 'ConfigTab is declared where this test looks for it');
  const sections = [...declaration.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(sections.length >= 5, `found ${sections.length} sections, which is too few to be the real list`);
  for (const section of sections) {
    const place = at({ tab: 'config', configTab: section as Place['configTab'] });
    assert.deepEqual(readPlace(placeQuery(place)), place, `section=${section} is dropped by readPlace`);
  }
});

test('a value that names no destination reads as the overview', () => {
  assert.equal(readPlace('?tab=nowhere').tab, 'overview');
  assert.equal(readPlace('?panel=nowhere').panel, null);
  assert.equal(readPlace('?tab=').tab, 'overview');
});

test('an empty parameter is an absent one', () => {
  assert.deepEqual(readPlace('?goal=&agent=&plan=&pad=&ask='), NOWHERE);
});

test('a place has exactly one spelling', () => {
  const place = at({ tab: 'tickets', goal: 'issue:142', insightsView: 'trend' });
  assert.equal(placeQuery(readPlace(placeQuery(place))), placeQuery(place));
});

test('a goal or a pull request is read under a tab that could have led to it', () => {
  for (const tab of ['insights', 'obstacles', 'pets', 'config']) {
    assert.equal(readPlace(`?tab=${tab}&goal=issue:142`).tab, 'overview', `${tab} does not list goals`);
    assert.equal(readPlace(`?tab=${tab}&pr=706`).tab, 'overview', `${tab} does not list pull requests`);
  }
  for (const tab of ['overview', 'tickets', 'features']) {
    assert.equal(readPlace(`?tab=${tab}&goal=issue:142`).tab, tab, `${tab} lists goals`);
  }
  assert.equal(readPlace('?tab=insights').tab, 'insights');
});

test('ids and refs survive encoding', () => {
  const place = at({ panel: { ask: 'esc:1&2=3' }, goal: 'issue:142' });
  assert.ok(!placeQuery(place).includes('&2=3'));
  assert.deepEqual(readPlace(placeQuery(place)), place);
});

test('an idea is carried only under a pack, and a pack is a positive integer', () => {
  assert.deepEqual(readPlace('?idea=idea_x'), NOWHERE);
  assert.deepEqual(readPlace('?pack=abc&idea=idea_x'), NOWHERE);
  assert.deepEqual(readPlace('?pack=0'), NOWHERE);
  assert.equal(readPlace('?pack=684&idea=idea_x').reviewIdea, 'idea_x');
  assert.equal(placeQuery(at({ reviewIdea: 'idea_x' })), '', 'an idea with no pack writes nothing');
});

test('a pull request page is a positive integer, or it is nowhere', () => {
  assert.deepEqual(readPlace('?pr=main'), NOWHERE);
  assert.deepEqual(readPlace('?pr=0'), NOWHERE);
  assert.deepEqual(readPlace('?pr=-3'), NOWHERE);
  assert.equal(readPlace('?pr=706').pr, 706);
  assert.equal(readPlace('?goal=issue:142&pr=706').goal, 'issue:142', 'the goal underneath survives');
});

test('a link to the deleted backlog tab lands on the tickets tab', () => {
  assert.equal(readPlace('?tab=backlog').tab, 'tickets');
  assert.equal(readPlace('?tab=backlog&collapsed=3').collapsed[0], 3, 'and keeps the rest of the place');
  assert.equal(readPlace('?tab=nonsense').tab, 'overview', 'a tab that never existed is still the overview');
});

test('a link to the retired work tab lands where its triage went', () => {
  assert.equal(readPlace('?tab=work').tab, 'tickets');
  assert.equal(readPlace('?tab=work&goal=issue:142').goal, 'issue:142', 'and keeps the rest of the place');
});

test('links to the retired knowledge, findings and lessons surfaces land on the obstacle board', () => {
  assert.equal(readPlace('?tab=knowledge').tab, 'obstacles');
  assert.equal(readPlace('?panel=knowledge').tab, 'obstacles');
  assert.equal(readPlace('?panel=knowledge&fact=fact_abc').tab, 'obstacles', 'the fact id is simply dropped');
  assert.equal(readPlace('?panel=findings').tab, 'obstacles');
  assert.equal(readPlace('?panel=lessons').tab, 'obstacles');
  assert.equal(readPlace('?panel=findings').panel, null, 'and open no panel over it');
  assert.equal(
    readPlace('?panel=lessons&goal=issue:142').goal,
    'issue:142',
    'and keep the rest of the place they carried',
  );
  assert.equal(
    readPlace('?tab=tickets&panel=findings').tab,
    'tickets',
    'an explicit tab is the operator saying where they meant to be',
  );
});

test('the old open/closed state parameter reads as the tracking axis', () => {
  assert.equal(readPlace('?tab=tickets&state=open').ticketTracking, 'live');
  assert.equal(readPlace('?tab=tickets&state=open').ticketState, 'any');
  assert.equal(readPlace('?tab=tickets&state=closed').ticketTracking, 'frozen');
  assert.equal(readPlace('?tab=tickets&state=In%20Review').ticketState, 'In Review');
  assert.equal(readPlace('?tab=tickets').ticketTracking, 'live', 'and live is what a bare tab means');
});

test('folded features round-trip, deduplicated and sorted', () => {
  const place = at({ tab: 'tickets', collapsed: [12, 3] });
  assert.equal(placeQuery(place).includes('collapsed=3%2C12'), true);
  assert.deepEqual(readPlace(placeQuery(place)).collapsed, [3, 12]);
  assert.equal(placeQuery(at({ collapsed: [3, 12] })), placeQuery(at({ collapsed: [12, 3] })));
});

test('no folded feature writes no parameter', () => {
  assert.equal(placeQuery(at({ collapsed: [] })), '');
  assert.deepEqual(readPlace('?collapsed=').collapsed, []);
});

test('a hand-edited fold list drops what is not an issue number', () => {
  assert.deepEqual(readPlace('?collapsed=4,abc,-1,0,4,7.5,9').collapsed, [4, 9]);
});

test('every ticket filter on the place is forwarded into the view model', () => {
  const place = readFileSync('web/src/cockpit/place.ts', 'utf8');
  const fields = [...place.matchAll(/^ {2}(ticket[A-Za-z]+):/gm)].map((m) => m[1]!);
  assert.ok(fields.length >= 6, `found ${fields.length} ticket filters, which is too few to be the real list`);
  const hook = readFileSync('web/src/cockpit/useCockpit.ts', 'utf8');
  for (const field of fields) {
    assert.ok(hook.includes(`${field}: place.${field},`), `${field} never reaches buildViewModel`);
  }
});

test('every feature field on the place is forwarded into the view model', () => {
  const place = readFileSync('web/src/cockpit/place.ts', 'utf8');
  const fields = [...new Set([...place.matchAll(/^ {2}(feature[A-Za-z]+):/gm)].map((m) => m[1]!))];
  assert.deepEqual(fields, ['featureCard', 'featureSort', 'featurePrs']);
  const hook = readFileSync('web/src/cockpit/useCockpit.ts', 'utf8');
  for (const field of fields) {
    assert.ok(hook.includes(`${field}: place.${field},`), `${field} never reaches buildViewModel`);
  }
});

test('the Features tab defaults are the absent values, and junk reads as them', () => {
  assert.equal(placeQuery(at({ tab: 'features' })), '?tab=features');
  assert.equal(placeQuery(at({ featureSort: 'wants-you', featurePrs: 'open', featureCard: null })), '');
  const junk = readPlace('?tab=features&card=abc&sort=alphabetical&prs=merged');
  assert.equal(junk.featureCard, null);
  assert.equal(junk.featureSort, 'wants-you');
  assert.equal(junk.featurePrs, 'open');
  assert.equal(readPlace('?tab=features&card=0').featureCard, null, 'a card is a positive integer');
  assert.equal(readPlace('?tab=features&card=-3').featureCard, null);
  assert.equal(readPlace('?tab=features&card=812').featureCard, 812);
  const tickets = readPlace('?tab=tickets&feature=812&order=cost&view=card');
  assert.equal(tickets.featureCard, null);
  assert.equal(tickets.featureSort, 'wants-you');
  assert.equal(readPlace('?tab=features&card=812&sort=spend').ticketFeature, null);
  assert.equal(readPlace('?tab=features&sort=spend').ticketOrder, 'added');
});

const facet = (state: string, count: number, live: number) => ({ state, count, live, pickup: false });

test('a state with nothing live widens the tracking axis, and a state with live rows does not', () => {
  assert.deepEqual(statePick(facet('Closed', 68, 0), 'live'), { state: 'Closed', tracking: 'any' });
  assert.deepEqual(statePick(facet('Active', 9, 9), 'live'), { state: 'Active' });
  assert.deepEqual(statePick(facet('Closed', 68, 0), 'frozen'), { state: 'Closed' });
  assert.deepEqual(statePick(null, 'any'), { state: 'any' });
});

test('the tab can name the state its tracking axis is widened for', () => {
  const states = [facet('Closed', 68, 0), facet('Active', 9, 9)];
  assert.equal(widenedFor('Closed', 'any', states)?.state, 'Closed', 'the pick that widened it is named');
  assert.equal(widenedFor('Active', 'any', states), null, 'a state with live rows never widened anything');
  assert.equal(widenedFor('Closed', 'live', states), null, 'and a narrowed axis is not a widened one');
  assert.equal(widenedFor('any', 'any', states), null, 'nor is the whole history with no state picked');
  assert.equal(widenedFor('Closed', 'any', []), null, 'a state the facets do not know is left alone');
});

test('the way back out of a widening is the view the tab lands on', () => {
  assert.deepEqual(LIVE_WORK, { tracking: 'live', state: 'any' });
  assert.deepEqual({ ...NOWHERE, ticketTracking: LIVE_WORK.tracking, ticketState: LIVE_WORK.state }, NOWHERE);
  const back = { ...at({ tab: 'tickets' }), ticketTracking: LIVE_WORK.tracking, ticketState: LIVE_WORK.state };
  assert.equal(placeQuery(back), '?tab=tickets', 'and it is the bare tab, not a second spelling of it');
});

test('the tickets panel reads the widening back and offers the way out of it', () => {
  const panel = readFileSync('web/src/components/TicketsPanel.tsx', 'utf8');
  assert.match(panel, /widenedFor\(query\.state, query\.tracking, states\)/);
  assert.match(panel, /onQuery\(LIVE_WORK\)/);
  assert.match(panel, /className="tickets-widened"/);
});

test('the table is the default view, so it costs no query parameter', () => {
  assert.equal(placeQuery(at({ tab: 'tickets' })), '?tab=tickets');
  assert.equal(readPlace('?tab=tickets').ticketView, 'table');
  assert.equal(readPlace('?tab=tickets&view=kanban').ticketView, 'table');
});

test('hidden columns are the exception, so an untouched board is a bare URL', () => {
  assert.equal(placeQuery(at({ tab: 'tickets', ticketView: 'card' })), '?tab=tickets&view=card');
  assert.deepEqual(readPlace('?tab=tickets').ticketColumns, []);
});

test('hidden columns have one spelling, so hiding A then B is not a second place', () => {
  const one = placeQuery(at({ tab: 'tickets', ticketColumns: ['Removed', 'Closed'] }));
  const other = placeQuery(at({ tab: 'tickets', ticketColumns: ['Closed', 'Removed'] }));
  assert.equal(one, other, 'sorted on the way out, or the two would push a history entry going nowhere');
  assert.deepEqual(readPlace(one).ticketColumns, ['Closed', 'Removed']);
});

test('a blank entry in the hidden list is dropped rather than hiding a nameless column', () => {
  assert.deepEqual(readPlace('?tab=tickets&hide=Closed,,%20%20,Removed').ticketColumns, ['Closed', 'Removed']);
});

test('every foldable goal section round-trips, opened or folded', () => {
  for (const section of GOAL_SECTIONS) {
    const opened = at({ goal: 'issue:142', goalOpen: [section] });
    assert.deepEqual(readPlace(placeQuery(opened)), opened, section);
    const folded = at({ goal: 'issue:142', goalShut: [section] });
    assert.deepEqual(readPlace(placeQuery(folded)), folded, section);
  }
});

test('a hand-edited fold list drops a section that does not exist', () => {
  const place = readPlace('?goal=issue:142&open=ticket,nonesuch&shut=signals,nonesuch');
  assert.deepEqual(place.goalOpen, ['ticket']);
  assert.deepEqual(place.goalShut, ['signals']);
});

/* The pool is a scope rather than a tab, and six of the ten readings are ones a
   fleet only holds about itself. → docs/spec/17-cockpit.md#just-me-or-the-pool */
test('the pool scope carries only the tabs the pool can answer', () => {
  for (const view of ['economics', 'causes', 'throughput', 'usage']) {
    const place = readPlace(`?tab=insights&scope=pool&view=${view}`);
    assert.equal(place.insightsScope, 'pool');
    assert.equal(place.insightsView, view);
  }
  for (const view of ['allowance', 'reliability', 'trend', 'mix', 'mcp', 'review']) {
    const place = readPlace(`?tab=insights&scope=pool&view=${view}`);
    assert.equal(place.insightsScope, 'pool');
    assert.equal(place.insightsView, 'economics', `${view} is not a pool reading and must not be representable`);
  }
});

test('a link to the retired Pool tab lands on the pool scope', () => {
  const place = readPlace('?tab=insights&view=pool');
  assert.equal(place.insightsScope, 'pool');
  assert.equal(place.insightsView, 'economics');
});
