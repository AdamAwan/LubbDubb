import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, BuildReading } from '../web/src/types.js';
import { updateAskRows, upgradeHeadline } from '../web/src/view/updateAsks.js';

/**
 * The rail's two update asks.
 *
 * These are the one pair of queue rows derived from a *reading* rather than from
 * something somebody raised, which is what makes each predicate here worth a test:
 * nothing anywhere else in the harness will ever settle them, so a row that draws
 * when it should not is furniture on the surface that must not have any, and one
 * that does not draw when it should is a deployment quietly staying behind.
 *
 * → docs/spec/21-self-update.md, `web/src/view/updateAsks.ts`
 */

const NOW = '2026-09-05T12:00:00.000Z';

/** A build reading with nothing waiting; each test names only the field it is about. */
function build(over: Partial<BuildReading> = {}): BuildReading {
  return {
    state: 'behind',
    label: '14 behind',
    live: 0,
    upgradable: true,
    blocked: null,
    supervised: true,
    standing: {
      head: 'aaaaaaa',
      upstream: 'bbbbbbb',
      behind: 14,
      ahead: 0,
      commits: [
        { sha: 'ccc1111', author: 'Priya Raman', authoredAt: '2026-09-05T09:00:00.000Z', subject: 'Newest' },
        { sha: 'ddd2222', author: 'Tomas Weir', authoredAt: '2026-08-15T09:00:00.000Z', subject: 'Oldest carried' },
      ],
      dirty: false,
      branch: 'main',
      checkedAt: NOW,
      unavailable: null,
    },
    intent: { state: 'idle', targetSha: null, requestedAt: null, pausedByDrain: false },
    project: null,
    projectPull: { can: false, blocked: 'no project checkout is being watched' },
    projectAutoPull: true,
    snoozedUntil: { upgrade: null, projectPull: null },
    ...over,
  };
}

/** A project standing that is behind, so only the pull's own verdict decides the row. */
function projectStanding(over: Partial<NonNullable<BuildReading['project']>> = {}) {
  return {
    head: 'eee3333',
    upstream: 'fff4444',
    behind: 2,
    ahead: 0,
    commits: [],
    dirty: false,
    branch: 'main',
    checkedAt: NOW,
    unavailable: null,
    ...over,
  };
}

function stateWith(reading: BuildReading): AppState {
  return { build: reading, config: { desktopFolder: '/home/pat/work/markdown-magpie' } } as unknown as AppState;
}

test('an upgrade that can be taken is a row, and one that cannot is not', () => {
  const offered = updateAskRows(stateWith(build()), NOW);
  assert.deepEqual(
    offered.map((r) => [r.kind, r.group, r.opens]),
    [['upgrade', 'yours', 'build']],
  );

  // Keyed on the server's own verdict, never on `behind > 0`. A build fourteen
  // commits behind whose install directory is dirty has an upgrade the server will
  // refuse, and a row offering an act that comes back a 409 is worse than no row.
  const refused = updateAskRows(stateWith(build({ upgradable: false, blocked: 'uncommitted changes' })), NOW);
  assert.deepEqual(refused, []);
});

test("the row's age is how long the deployment has been behind, not when the check ran", () => {
  const rows = updateAskRows(stateWith(build()), NOW);
  // The oldest commit the reading carries. It is the one number that separates a
  // deployment a morning behind from one nobody has touched since August, and it
  // is the whole reason a queue row for this beats a card.
  assert.equal(rows[0]?.raisedAt, '2026-08-15T09:00:00.000Z');

  // With no commits carried there is nothing to date it by, and the reading's own
  // stamp is the honest fallback rather than an empty string that sorts first.
  const bare = updateAskRows(stateWith(build({ standing: { ...build().standing, commits: [] } })), NOW);
  assert.equal(bare[0]?.raisedAt, NOW);
});

test('the headline says what to press: one act with the fleet clear, a choice without', () => {
  assert.match(upgradeHeadline(build({ live: 0 })), /nothing is running, so this would apply now/);
  // With agents out there is a real choice to make — wait for them or stop them —
  // so the sentence does not pre-empt it.
  assert.equal(upgradeHeadline(build({ live: 3 })), '14 commits waiting');
  assert.equal(upgradeHeadline(build({ standing: { ...build().standing, behind: 1 }, live: 3 })), '1 commit waiting');
});

test('a drain in progress outranks the standing, because it is the thing that is happening', () => {
  const draining = build({
    live: 2,
    intent: { state: 'draining', targetSha: 'bbbbbbb', requestedAt: NOW, pausedByDrain: true },
  });
  assert.equal(upgradeHeadline(draining), 'Draining — waiting for 2 agents to finish');
  assert.equal(upgradeHeadline({ ...draining, live: 0 }), 'Draining — the fleet is clear');

  // And the row stays: an ask that vanished the moment it was pressed would leave
  // an operator with no way to tell whether the press registered.
  assert.equal(updateAskRows(stateWith(draining), NOW).length, 1);
});

test('a snoozed ask draws nothing, and comes back on its own when the window runs out', () => {
  const snoozed = build({ snoozedUntil: { upgrade: '2026-09-05T12:30:00.000Z', projectPull: null } });
  assert.deepEqual(updateAskRows(stateWith(snoozed), NOW), []);

  // Nothing has to clear the stamp: the row returns because the clock passed it,
  // which is why the derivation takes `now` rather than reading it.
  const later = updateAskRows(stateWith(snoozed), '2026-09-05T12:31:00.000Z');
  assert.deepEqual(
    later.map((r) => r.kind),
    ['upgrade'],
  );
});

test('an unreadable snooze stamp shows the ask rather than hiding it', () => {
  // The safe direction. A row hidden by a clock nobody can read is a row nobody
  // can un-hide, on the one queue whose whole job is that nothing is missed.
  const rows = updateAskRows(stateWith(build({ snoozedUntil: { upgrade: 'not a date', projectPull: null } })), NOW);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['upgrade'],
  );
});

test('the project ask appears only where an auto-pull was supposed to have handled it', () => {
  const blocked = {
    can: false,
    blocked: 'the project checkout has uncommitted changes to tracked files; commit or stash them before pulling',
  };

  const raised = updateAskRows(
    stateWith(build({ upgradable: false, project: projectStanding(), projectPull: blocked })),
    NOW,
  );
  assert.deepEqual(
    raised.map((r) => [r.kind, r.group]),
    [['project_pull', 'yours']],
  );
  // It names the checkout, because the operator has two of them and
  // `projectPullability`'s sentence names neither.
  assert.equal(
    raised[0]?.title,
    'Auto-pull is disabled for markdown-magpie because the checkout has uncommitted changes to tracked ' +
      'files; commit or stash them before pulling',
  );

  // Auto-pull off: the operator has already said they pull by hand, and a daily
  // row saying so is the harness reporting their own decision back as news.
  const byHand = updateAskRows(
    stateWith(build({ upgradable: false, projectAutoPull: false, project: projectStanding(), projectPull: blocked })),
    NOW,
  );
  assert.deepEqual(byHand, []);

  // A checkout that *can* be pulled has been — the harness does it on the pulse —
  // so a row here would be an ask about nothing.
  const pullable = updateAskRows(
    stateWith(build({ upgradable: false, project: projectStanding(), projectPull: { can: true, blocked: null } })),
    NOW,
  );
  assert.deepEqual(pullable, []);

  // And a checkout that is not behind has nothing to pull, whatever else is true
  // of it: `projectPullability` refuses a current clone too, and that refusal is
  // not an obstruction worth a row.
  const current = updateAskRows(
    stateWith(
      build({
        upgradable: false,
        project: projectStanding({ behind: 0 }),
        projectPull: { can: false, blocked: 'the project checkout is up to date — there is nothing to pull' },
      }),
    ),
    NOW,
  );
  assert.deepEqual(current, []);
});

test('both asks can stand at once, and neither is ever blocking', () => {
  const rows = updateAskRows(
    stateWith(
      build({
        project: projectStanding(),
        projectPull: { can: false, blocked: 'the project checkout carries 1 commit of its own' },
      }),
    ),
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['upgrade', 'project_pull'],
  );
  // Nothing is parked and no slot is held. The group is strictly about a held
  // slot, and widening it for how much an operator ought to do would cost it the
  // only thing it means.
  assert.ok(rows.every((r) => r.group === 'yours'));
  assert.ok(rows.every((r) => r.holding === 0 && r.agentId === null && r.goalRef === null));
});
