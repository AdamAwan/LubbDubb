import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CockpitEnvironment,
  GoalEnvironmentReachView,
  GoalWatchView,
  ValidationCheckView,
} from '../web/src/types.js';
import { buildGoalPage, buildGoalNav, type GoalPageView } from '../web/src/view/goalPage.js';
import {
  checkTally,
  goalTabCarrier,
  goalTabTitle,
  obligationChoices,
  pickedGoalTab,
  watchSourcesOf,
  watchWindowOf,
} from '../web/src/view/goalPanes.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function basePage(): GoalPageView {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, []);
  assert.ok(page);
  return page;
}

function reach(environment: string, status: GoalEnvironmentReachView['status']): GoalEnvironmentReachView {
  return { environment, status } as GoalEnvironmentReachView;
}

test('a picked pane the row does not draw is no pick at all', () => {
  const page = { ...basePage(), obligations: { validate: [], close: [], watch: [] } };
  assert.equal(pickedGoalTab(page, null), null);
  assert.equal(pickedGoalTab(page, 'plan'), 'plan');
  assert.equal(pickedGoalTab(page, 'watch'), null);
  assert.equal(pickedGoalTab({ ...page, obligations: { ...page.obligations, watch: ['prod'] } }, 'watch'), 'watch');
});

test('the selected tab explains why it opened only until the operator picks one', () => {
  const page = basePage();
  const entry = buildGoalNav(page).find((e) => e.tab === 'plan')!;
  const opening = { tab: 'plan' as const, why: 'work is out' };
  assert.equal(goalTabTitle(entry, 'plan', null, opening), 'Opened here because work is out');
  assert.equal(goalTabTitle(entry, 'plan', 'plan', opening), `${entry.label}: ${entry.reading} — go to it`);
  assert.equal(goalTabTitle(entry, 'ask', null, opening), `${entry.label}: ${entry.reading} — go to it`);
});

test('a tab names the one environment carrying it, and counts several', () => {
  assert.equal(goalTabCarrier([]), null);
  assert.deepEqual(goalTabCarrier(['test']), { text: 'test', title: 'Carried by test' });
  assert.deepEqual(goalTabCarrier(['test', 'prod']), { text: '2 environments', title: 'Carried by test and prod' });
});

test('the obligation picker draws only where two or more environments carry it', () => {
  const page = basePage();
  const one = { ...page, obligations: { ...page.obligations, validate: ['test'] } };
  assert.deepEqual(obligationChoices(one, 'validate', 'test'), []);
  const two = {
    ...page,
    obligations: { ...page.obligations, validate: ['test', 'prod'] },
    environments: [reach('test', 'reached')],
  };
  assert.deepEqual(obligationChoices(two, 'validate', 'prod'), [
    { name: 'test', status: 'reached', showing: false },
    { name: 'prod', status: null, showing: true },
  ]);
});

test('the check tally counts live checks, and passed or waived as done', () => {
  const page = basePage();
  const check = (state: ValidationCheckView['state'], supersededReason: string | null = null): ValidationCheckView =>
    ({ state, supersededReason }) as ValidationCheckView;
  assert.deepEqual(checkTally({ ...page, checks: [] }), { live: 0, settled: 0 });
  assert.deepEqual(
    checkTally({
      ...page,
      checks: [check('passed'), check('waived'), check('failed'), check('unrun'), check('passed', 'replaced')],
    }),
    { live: 4, settled: 2 },
  );
});

test('the watch pane reads the window and sources of the environment it shows', () => {
  const page = basePage();
  const prod = { environment: 'prod' } as GoalWatchView;
  assert.equal(watchWindowOf({ ...page, watches: [prod] }, 'prod'), prod);
  assert.equal(watchWindowOf({ ...page, watches: [prod] }, 'test'), undefined);
  const sources = [{}] as CockpitEnvironment['watchSources'];
  const envs = [{ name: 'prod', watchSources: sources }] as CockpitEnvironment[];
  assert.equal(watchSourcesOf(envs, 'prod'), sources);
  assert.deepEqual(watchSourcesOf(envs, null), []);
});
