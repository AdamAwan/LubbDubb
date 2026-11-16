import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoalEnvironmentReachView, ValidationCheckView } from '../web/src/types.js';
import {
  buildGoalPage,
  buildGoalNav,
  checkTally,
  goalTabCarrier,
  goalTabTitle,
  obligationChoices,
  pickedGoalTab,
  type GoalPageView,
} from '../web/src/view/goalPage.js';

const { buildFixtureState } = await import('./support/cockpitFixtures.js');

function basePage(): GoalPageView {
  const state = buildFixtureState();
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
  assert.deepEqual(obligationChoices(one, 'validate'), []);
  const two = {
    ...page,
    obligations: { ...page.obligations, validate: ['test', 'prod'] },
    environments: [reach('test', 'reached')],
  };
  assert.deepEqual(obligationChoices(two, 'validate'), [
    { name: 'test', status: 'reached' },
    { name: 'prod', status: null },
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
