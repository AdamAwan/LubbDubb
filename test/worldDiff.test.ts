import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffWorlds } from '../src/world/worldDiff.js';
import type { CalendarEvent, Issue, PullRequest, Story, WorldEventKind, WorldSnapshot } from '../src/types.js';

function world(patch: Partial<Omit<WorldSnapshot, 'takenAt'>> = {}): WorldSnapshot {
  return {
    takenAt: '2026-07-21T00:00:00.000Z',
    pullRequests: [],
    issues: [],
    stories: [],
    calendar: [],
    ...patch,
  };
}

function pr(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr1',
    number: 42,
    title: 'Add widget',
    branch: 'feat/widget',
    ciStatus: 'unknown',
    unresolvedComments: [],
    ...patch,
  };
}

function issue(patch: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    number: 12,
    title: 'Crash on save',
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...patch,
  };
}

function story(patch: Partial<Story> = {}): Story {
  return {
    id: 's1',
    title: 'Login',
    description: null,
    acceptanceCriteria: null,
    wafPillars: [],
    state: 'ready',
    priority: 1,
    ...patch,
  };
}

function meeting(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'm1',
    title: 'Standup',
    startsAt: '2026-07-21T09:00:00.000Z',
    prepDocs: [],
    prepDone: false,
    ...patch,
  };
}

const kinds = (prev: WorldSnapshot, next: WorldSnapshot): WorldEventKind[] => diffWorlds(prev, next).map((e) => e.kind);

test('identical snapshots produce no events', () => {
  const w = world({ pullRequests: [pr()], stories: [story()] });
  assert.deepEqual(diffWorlds(w, w), []);
});

test('a newly appeared PR emits a single pr_opened, not per-field', () => {
  const events = diffWorlds(world(), world({ pullRequests: [pr({ ciStatus: 'passing', approved: true })] }));
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pr_opened'],
  );
  assert.equal(events[0]!.ref, 'pr:42');
  assert.match(events[0]!.summary, /#42/);
});

test('PR CI status change emits pr_ci with the new status in the summary', () => {
  const events = diffWorlds(
    world({ pullRequests: [pr({ ciStatus: 'pending' })] }),
    world({ pullRequests: [pr({ ciStatus: 'passing' })] }),
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pr_ci'],
  );
  assert.match(events[0]!.summary, /passing/);
});

test('PR approval, mergeable, and merged transitions each emit once (false->true only)', () => {
  assert.deepEqual(kinds(world({ pullRequests: [pr()] }), world({ pullRequests: [pr({ approved: true })] })), [
    'pr_approved',
  ]);
  assert.deepEqual(kinds(world({ pullRequests: [pr()] }), world({ pullRequests: [pr({ mergeable: true })] })), [
    'pr_mergeable',
  ]);
  assert.deepEqual(kinds(world({ pullRequests: [pr()] }), world({ pullRequests: [pr({ merged: true })] })), [
    'pr_merged',
  ]);
  // Already approved -> still approved: no event.
  assert.deepEqual(
    kinds(world({ pullRequests: [pr({ approved: true })] }), world({ pullRequests: [pr({ approved: true })] })),
    [],
  );
});

test('a new unresolved PR comment emits pr_comment (by comment id)', () => {
  const before = world({ pullRequests: [pr({ unresolvedComments: [] })] });
  const after = world({
    pullRequests: [pr({ unresolvedComments: [{ id: 'c1', author: 'bob', body: 'why?', handled: false }] })],
  });
  const events = diffWorlds(before, after);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pr_comment'],
  );
  assert.match(events[0]!.summary, /bob/);
  // The same comment on the next diff must not re-emit.
  assert.deepEqual(diffWorlds(after, after), []);
});

test('issue open->closed emits issue_closed; linking emits issue_linked', () => {
  assert.deepEqual(kinds(world({ issues: [issue()] }), world({ issues: [issue({ state: 'closed' })] })), [
    'issue_closed',
  ]);
  assert.deepEqual(kinds(world({ issues: [issue()] }), world({ issues: [issue({ linkedPrNumber: 77 })] })), [
    'issue_linked',
  ]);
});

test('a newly appeared issue emits issue_opened only', () => {
  assert.deepEqual(kinds(world(), world({ issues: [issue()] })), ['issue_opened']);
});

test('story appearance and state change emit story_added / story_state', () => {
  assert.deepEqual(kinds(world(), world({ stories: [story()] })), ['story_added']);
  const events = diffWorlds(
    world({ stories: [story({ state: 'ready' })] }),
    world({ stories: [story({ state: 'in_progress' })] }),
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['story_state'],
  );
  assert.match(events[0]!.summary, /in_progress/);
});

test('meeting appearance and prep completion emit meeting_added / meeting_prep', () => {
  assert.deepEqual(kinds(world(), world({ calendar: [meeting()] })), ['meeting_added']);
  assert.deepEqual(
    kinds(world({ calendar: [meeting({ prepDone: false })] }), world({ calendar: [meeting({ prepDone: true })] })),
    ['meeting_prep'],
  );
});

test('multiple simultaneous transitions on one PR all surface', () => {
  const events = diffWorlds(
    world({ pullRequests: [pr({ ciStatus: 'pending', approved: false })] }),
    world({ pullRequests: [pr({ ciStatus: 'passing', approved: true, mergeable: true })] }),
  );
  const set = new Set(events.map((e) => e.kind));
  assert.ok(set.has('pr_ci'));
  assert.ok(set.has('pr_approved'));
  assert.ok(set.has('pr_mergeable'));
});
