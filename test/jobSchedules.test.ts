import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { Store } from '../src/store/store.js';
import { nextCronRun, parseCron } from '../src/schedules/cron.js';
import { jobStillGoing, schedulePass, scheduleJobRequest } from '../src/schedules/schedule.js';
import { ScheduleDesk } from '../src/schedules/scheduleDesk.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import type { Job, JobSchedule, Task } from '../src/types.js';

/**
 * Recurring blueprints: a prompt queued on a clock.
 *
 * The property every test below is really about is that a schedule adds a way for
 * work to *arrive* and no way for it to be *run*: what a firing produces is an
 * ordinary job, drained by rule `manual-job` under the same cap, pause flag and
 * queue as one the operator launched by hand.
 */

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sched-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 2,
    ...overrides,
  });
}

function build(overrides: Partial<Config> = {}): System {
  return buildSystem(testConfig(overrides), {
    backend: new FakePtyBackend(),
    // Without this a dispatched code agent cuts a real branch in whatever checkout
    // the suite is running in. → docs/spec/19-development.md
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
}

/**
 * An error sink that records nothing — these tests drive the desk directly, and
 * the failures it routes here are the subject of no assertion below.
 */
const SILENT: ErrorRecorder = { record: (input) => ({ id: 'err', createdAt: '', detail: null, ...input }) };

/** A schedule row as the pure pass sees it, with only the fields under test spelled out. */
function schedule(over: Partial<JobSchedule> = {}): JobSchedule {
  return {
    id: 'sch_1',
    title: 'Sweep the dependencies',
    prompt: 'Check for outdated dependencies and open a PR.',
    kind: 'code',
    cron: '0 9 * * *',
    enabled: true,
    nextRunAt: '2026-08-12T09:00:00.000Z',
    lastFiredAt: null,
    lastJobId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

// -- The expression ---------------------------------------------------------

test('a five-field expression parses, and everything else is refused by name', () => {
  assert.equal(parseCron('0 9 * * 1-5').ok, true);
  assert.equal(parseCron('*/15 * * * *').ok, true);
  assert.equal(parseCron('0,30 0-6/2 1,15 */3 0').ok, true);
  // Whitespace is not significant beyond separating the fields.
  assert.equal(parseCron('  0   9  *  *  *  ').ok, true);

  // The count is checked before the fields, because "five fields" is the thing a
  // seconds-style expression got wrong and no field-level message would say so.
  const six = parseCron('0 0 9 * * *');
  assert.equal(six.ok, false);
  assert.match(six.ok === false ? six.error : '', /five fields/);

  // A field's refusal names the field and what it accepts — it is handed straight
  // back to whoever typed it, so "invalid" would be no help at all.
  const named = parseCron('0 9 * * MON');
  assert.equal(named.ok, false);
  assert.match(named.ok === false ? named.error : '', /day-of-week/);
  assert.match(named.ok === false ? named.error : '', /names like MON are not supported/);

  const range = parseCron('99 * * * *');
  assert.equal(range.ok, false);
  assert.match(range.ok === false ? range.error : '', /minute must be between 0 and 59/);

  // The shapes that parse as *something* if nobody looks: an empty list item is
  // `Number('') === 0`, and a bare number with a step is a guess about intent.
  assert.equal(parseCron('1,,2 * * * *').ok, false);
  assert.equal(parseCron('5/2 * * * *').ok, false);
  assert.equal(parseCron('* * * * */0').ok, false);
  assert.equal(parseCron('@daily').ok, false);
});

test('the next run is the next matching minute, strictly after the moment asked about', () => {
  // Local time throughout, which is what an operator means by "09:00" — so the
  // expectations are built with the local constructor rather than from ISO text.
  const at = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m - 1, d, h, min, 0, 0);

  assert.deepEqual(nextCronRun('0 9 * * *', at(2026, 8, 12, 8, 59)), at(2026, 8, 12, 9, 0));
  // Strictly after: a schedule fired at exactly its slot must not pick the same
  // minute again and fire twice.
  assert.deepEqual(nextCronRun('0 9 * * *', at(2026, 8, 12, 9, 0)), at(2026, 8, 13, 9, 0));
  assert.deepEqual(nextCronRun('*/15 * * * *', at(2026, 8, 12, 9, 1)), at(2026, 8, 12, 9, 15));
  // 12 Aug 2026 is a Wednesday; the weekday range rolls to Thursday, and from
  // Friday evening to Monday.
  assert.deepEqual(nextCronRun('0 9 * * 1-5', at(2026, 8, 12, 10, 0)), at(2026, 8, 13, 9, 0));
  assert.deepEqual(nextCronRun('0 9 * * 1-5', at(2026, 8, 14, 10, 0)), at(2026, 8, 17, 9, 0));
  // Sunday is both 0 and 7.
  assert.deepEqual(nextCronRun('0 9 * * 7', at(2026, 8, 12, 10, 0)), at(2026, 8, 16, 9, 0));
  // A month field skips whole months rather than stepping through them.
  assert.deepEqual(nextCronRun('0 0 1 1 *', at(2026, 8, 12, 10, 0)), at(2027, 1, 1, 0, 0));

  // Vixie's day rule: with *both* day fields restricted the match is their union,
  // so this fires on the 1st and on every Monday. 12 Aug 2026 is a Wednesday, so
  // the next is Monday the 17th — not September the 1st.
  assert.deepEqual(nextCronRun('0 9 1 * 1', at(2026, 8, 12, 10, 0)), at(2026, 8, 17, 9, 0));

  // An expression that can never match answers null rather than looping.
  assert.equal(nextCronRun('0 0 30 2 *', at(2026, 8, 12, 10, 0)), null);
  assert.equal(nextCronRun('nonsense', at(2026, 8, 12, 10, 0)), null);
});

// -- The pass ---------------------------------------------------------------

test('a schedule fires when it is due, once, and is rescheduled from now', () => {
  const now = new Date('2026-08-12T09:00:30.000Z');
  const firings = schedulePass({
    schedules: [
      schedule({ id: 'due', nextRunAt: '2026-08-12T09:00:00.000Z' }),
      schedule({ id: 'later', nextRunAt: '2026-08-13T09:00:00.000Z' }),
      schedule({ id: 'off', enabled: false, nextRunAt: null }),
      // An expression that matches nothing has no due date to compare, and is not
      // asked about every pulse forever.
      schedule({ id: 'never', nextRunAt: null }),
    ],
    now,
    inFlight: () => false,
  });
  assert.deepEqual(
    firings.map((f) => f.schedule.id),
    ['due'],
  );
  assert.equal(firings[0]!.heldFor, null);
  // Computed from `now`, not from the slot that fired — which is what makes a
  // harness that was off for a week queue one job rather than seven. Asserted as
  // "the next 09:00 local, within a day" rather than as a literal, because the
  // fields are read in whatever timezone the suite is running in.
  const next = new Date(firings[0]!.nextRunAt!);
  assert.equal(next.getHours(), 9);
  assert.ok(next.getTime() > now.getTime());
  assert.ok(next.getTime() - now.getTime() <= 24 * 3_600_000, 'the next slot, not a backlog of the missed ones');
});

test('a schedule whose previous job is still in flight is rolled forward, not stacked', () => {
  const now = new Date('2026-08-12T09:00:30.000Z');
  const [firing] = schedulePass({
    schedules: [schedule({ nextRunAt: '2026-08-12T09:00:00.000Z', lastJobId: 'job_1' })],
    now,
    inFlight: () => true,
  });
  assert.ok(firing);
  assert.match(firing.heldFor ?? '', /still in flight/);
  // Rolled forward rather than deferred: the missed slot does not fire the instant
  // the long-running one lands.
  assert.ok(firing.nextRunAt && firing.nextRunAt > now.toISOString());
});

test('in flight means the job is queued, or the task it became is still active', () => {
  const job = (over: Partial<Job> = {}): Job => ({
    id: 'job_1',
    title: 't',
    prompt: 'p',
    kind: 'code',
    branch: null,
    status: 'queued',
    originRef: null,
    taskId: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  });
  const task = (status: Task['status']): Task => ({
    id: 'task_1',
    title: 't',
    prompt: 'p',
    kind: 'code',
    status,
    branch: null,
    originRef: 'job:job_1',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    agentId: null,
    createdAt: '',
    updatedAt: '',
  });

  assert.equal(jobStillGoing(null, null), false, 'a schedule that has never fired holds nothing');
  assert.equal(jobStillGoing(job(), null), true, 'still waiting for a slot');
  assert.equal(jobStillGoing(job({ status: 'cancelled' }), null), false);
  // `dispatched` is terminal for a job, so the task is the only thing that says
  // whether the work is still going on.
  assert.equal(jobStillGoing(job({ status: 'dispatched', taskId: 'task_1' }), task('running')), true);
  assert.equal(jobStillGoing(job({ status: 'dispatched', taskId: 'task_1' }), task('done')), false);
});

test("a firing's job carries the operator's own text, and no branch of its own", () => {
  const request = scheduleJobRequest(schedule({ title: 'Nightly sweep', prompt: 'Do the thing.', kind: 'desk' }));
  // Verbatim: nothing about the schedule, the time or the harness is interpolated
  // into a prompt the operator wrote.
  assert.deepEqual(request, { title: 'Nightly sweep', prompt: 'Do the thing.', kind: 'desk' });
  assert.equal('branch' in request, false, 'each firing takes the derived job/<id> branch of its own job');
});

// -- The desk, against a real store -----------------------------------------

test('the desk queues a job for a due schedule and records what it created', () => {
  const store = new Store(':memory:');
  const desk = new ScheduleDesk({ store, errors: SILENT });
  const created = store.createJobSchedule({
    title: 'Nightly sweep',
    prompt: 'Sweep it.',
    kind: 'desk',
    nextRunAt: '2026-08-12T03:00:00.000Z',
    cron: '0 3 * * *',
  });

  desk.run(new Date('2026-08-12T02:59:00.000Z'));
  assert.equal(store.listQueuedJobs().length, 0, 'nothing fires before its slot');

  desk.run(new Date('2026-08-12T03:00:10.000Z'));
  const queued = store.listQueuedJobs();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.title, 'Nightly sweep');
  assert.equal(queued[0]!.prompt, 'Sweep it.');
  assert.equal(queued[0]!.kind, 'desk');

  const after = store.getJobSchedule(created.id)!;
  assert.equal(after.lastJobId, queued[0]!.id, 'the schedule remembers the job it made');
  assert.ok(after.lastFiredAt);
  assert.ok(after.nextRunAt! > '2026-08-12T03:00:10.000Z', 'it is rescheduled ahead of the firing');

  // A second pass at the same moment must not fire again — the reschedule is what
  // stops it, and it is the property a repeated pulse depends on.
  desk.run(new Date('2026-08-12T03:00:20.000Z'));
  assert.equal(store.listQueuedJobs().length, 1);
  store.close();
});

test('a schedule whose previous job is still queued does not queue a second one', () => {
  const store = new Store(':memory:');
  const desk = new ScheduleDesk({ store, errors: SILENT });
  store.createJobSchedule({
    title: 'Nightly sweep',
    prompt: 'Sweep it.',
    kind: 'desk',
    nextRunAt: '2026-08-12T03:00:00.000Z',
    cron: '0 3 * * *',
  });
  desk.run(new Date('2026-08-12T03:00:10.000Z'));
  assert.equal(store.listQueuedJobs().length, 1);

  // A day later, with yesterday's job still waiting for a slot.
  desk.run(new Date('2026-08-13T03:00:10.000Z'));
  assert.equal(store.listQueuedJobs().length, 1, 'the second firing is held, not stacked');
  store.close();
});

// -- The pulse and the routes ------------------------------------------------

test('a due schedule dispatches an agent on the pulse it fires', async () => {
  const system = build();
  system.store.createJobSchedule({
    title: 'Nightly sweep',
    prompt: 'Sweep it.',
    kind: 'desk',
    // Due, so the very next pulse fires it.
    nextRunAt: '2020-01-01T00:00:00.000Z',
    cron: '0 3 * * *',
  });

  await system.harness.runCycle('manual');

  // The desk runs above the `listQueuedJobs` the dispatcher decides from, so the
  // job it queued is dispatched in the same cycle rather than the next one.
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'the firing became an agent');
  const task = system.store.getTask(live[0]!.taskId)!;
  assert.equal(task.prompt, 'Sweep it.');
  assert.match(task.originRef ?? '', /^job:/, 'a firing is an ordinary job, keyed on its own job origin');
  system.store.close();
});

test('a paused fleet holds a firing in the queue, exactly as it holds a hand-launched job', async () => {
  const system = build();
  system.runtimeControl.apply({ paused: true });
  system.store.createJobSchedule({
    title: 'Nightly sweep',
    prompt: 'Sweep it.',
    kind: 'desk',
    nextRunAt: '2020-01-01T00:00:00.000Z',
    cron: '0 3 * * *',
  });

  await system.harness.runCycle('manual');

  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 0, 'nothing spawns while paused');
  assert.equal(system.store.listQueuedJobs().length, 1, 'the firing waits in the queue');
  system.store.close();
});

test('the routes write, edit, run and end a schedule', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const created = await app.inject({
    method: 'POST',
    url: '/api/schedules',
    payload: { cron: '0 9 * * 1-5', prompt: 'Review the open PRs.\nSecond line.', kind: 'desk' },
  });
  assert.equal(created.statusCode, 200);
  const schedule = created.json<{ schedule: JobSchedule }>().schedule;
  // The title falls back to the prompt's first line, through the same derivation
  // the launch route uses.
  assert.equal(schedule.title, 'Review the open PRs.');
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.nextRunAt && schedule.nextRunAt > new Date().toISOString(), 'the first slot is in the future');

  // A bad expression is refused in the parser's own words, before anything is written.
  const bad = await app.inject({ method: 'POST', url: '/api/schedules', payload: { cron: 'every day', prompt: 'x' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /five fields/);
  assert.equal(system.store.listJobSchedules().length, 1, 'the refusal left nothing behind');

  // Pausing clears the next run, so resuming later starts from the clock rather
  // than firing instantly off a slot that is long past.
  const paused = await app.inject({
    method: 'POST',
    url: `/api/schedules/${schedule.id}`,
    payload: { enabled: false },
  });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json<{ schedule: JobSchedule }>().schedule.nextRunAt, null);
  const resumed = await app.inject({
    method: 'POST',
    url: `/api/schedules/${schedule.id}`,
    payload: { enabled: true },
  });
  assert.ok(resumed.json<{ schedule: JobSchedule }>().schedule.nextRunAt! > new Date().toISOString());

  // An edit that only rewords leaves the recurrence where it was.
  const before = system.store.getJobSchedule(schedule.id)!.nextRunAt;
  const reworded = await app.inject({
    method: 'POST',
    url: `/api/schedules/${schedule.id}`,
    payload: { prompt: 'Review the open PRs and comment.' },
  });
  assert.equal(reworded.json<{ schedule: JobSchedule }>().schedule.nextRunAt, before);
  assert.equal(reworded.json<{ schedule: JobSchedule }>().schedule.prompt, 'Review the open PRs and comment.');

  // Run now: the job is queued from the *current* text, and the cadence is untouched.
  const ran = await app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/run` });
  assert.equal(ran.statusCode, 200);
  assert.equal(ran.json<{ job: Job }>().job.prompt, 'Review the open PRs and comment.');
  assert.equal(system.store.getJobSchedule(schedule.id)!.nextRunAt, before, 'running early is not a change of cadence');
  assert.ok(system.store.getJobSchedule(schedule.id)!.lastFiredAt);

  // Ending it leaves the work it queued alone.
  const deleted = await app.inject({ method: 'DELETE', url: `/api/schedules/${schedule.id}` });
  assert.equal(deleted.statusCode, 200);
  assert.equal(system.store.listJobSchedules().length, 0);
  assert.equal(system.store.listJobs().length, 1, 'the job it queued is its history, not part of it');

  const gone = await app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/run` });
  assert.equal(gone.statusCode, 404);

  await app.close();
  system.store.close();
});

test('the snapshot ships every schedule, paused ones included', async () => {
  const system = build();
  const { app } = await buildApp(system);
  await app.inject({ method: 'POST', url: '/api/schedules', payload: { cron: '0 9 * * *', prompt: 'One.' } });
  const second = await app.inject({
    method: 'POST',
    url: '/api/schedules',
    payload: { cron: '0 3 * * *', prompt: 'Two.' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/schedules/${second.json<{ schedule: JobSchedule }>().schedule.id}`,
    payload: { enabled: false },
  });

  const state = await app.inject({ method: 'GET', url: '/api/state' });
  const schedules = state.json<{ schedules: JobSchedule[] }>().schedules;
  assert.equal(schedules.length, 2, 'a paused recurrence is the one thing only this panel can show');
  assert.deepEqual(
    schedules.map((s) => s.enabled),
    [true, false],
  );

  await app.close();
  system.store.close();
});
