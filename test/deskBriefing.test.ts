import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { mapBriefingMeeting } from '../src/integrations/ingested/calendar.js';
import { DeskBriefingSchema } from '../src/integrations/ingested/briefingSchema.js';
import type { BriefingMeeting, DeskBriefing } from '../src/types.js';

/** A briefing meeting with benign defaults; override just what a case cares about. */
function meeting(over: Partial<BriefingMeeting> = {}): BriefingMeeting {
  return {
    id: 'm_1',
    subject: 'Standup',
    start: '2026-07-22T09:00:00.000Z',
    end: '2026-07-22T09:15:00.000Z',
    isOnline: true,
    relevance: 'mine',
    ...over,
  };
}

/** A full, valid briefing for the endpoint/schema happy paths. */
function briefing(over: Partial<DeskBriefing> = {}): DeskBriefing {
  return {
    generatedAt: '2026-07-22T08:00:00.000Z',
    windowStart: '2026-07-22T08:00:00.000Z',
    windowEnd: '2026-07-23T08:00:00.000Z',
    owner: { email: 'adam@example.com', name: 'Adam' },
    areas: ['me', 'statements'],
    meetings: [
      meeting({
        id: 'm_42',
        subject: 'Design review',
        joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz',
        webLink: 'https://outlook.office365.com/owa/?itemid=42',
      }),
    ],
    mail: [
      {
        id: 'mail_1',
        subject: 'Q3 statements',
        from: 'finance@example.com',
        receivedAt: '2026-07-22T07:30:00.000Z',
        isUnread: true,
        isFlagged: false,
        relevance: 'area',
        area: 'statements',
      },
    ],
    pings: [
      {
        id: 'ping_1',
        source: 'teams',
        chatOrChannel: 'Platform',
        from: 'Jo',
        sentAt: '2026-07-22T07:45:00.000Z',
        relevance: 'mine',
      },
    ],
    ...over,
  };
}

// --------------------------------------------------------------------------
// Pure mapping
// --------------------------------------------------------------------------

test('mapBriefingMeeting collects join then web link as prep and passes the start through', () => {
  const ev = mapBriefingMeeting(
    meeting({
      id: 'm_7',
      subject: 'Design review',
      joinUrl: 'https://join',
      webLink: 'https://web',
    }),
  );
  assert.deepEqual(ev, {
    id: 'm_7',
    title: 'Design review',
    startsAt: '2026-07-22T09:00:00.000Z',
    prepDocs: ['https://join', 'https://web'],
    prepDone: false,
  });
});

test('mapBriefingMeeting labels an untitled hold and drops absent links', () => {
  const untitled = mapBriefingMeeting(meeting({ subject: '', joinUrl: undefined, webLink: 'https://web' }));
  assert.equal(untitled.title, '(untitled event)');
  assert.deepEqual(untitled.prepDocs, ['https://web']);

  const bare = mapBriefingMeeting(meeting({ joinUrl: undefined, webLink: undefined }));
  assert.deepEqual(bare.prepDocs, []);
});

// --------------------------------------------------------------------------
// Zod schema
// --------------------------------------------------------------------------

test('DeskBriefingSchema accepts a full valid payload', () => {
  const result = DeskBriefingSchema.safeParse(briefing());
  assert.equal(result.success, true);
});

test('DeskBriefingSchema rejects a malformed payload', () => {
  // Missing owner, wrong relevance, ping from a non-teams source.
  const bad = {
    generatedAt: '2026-07-22T08:00:00.000Z',
    windowStart: '2026-07-22T08:00:00.000Z',
    windowEnd: '2026-07-23T08:00:00.000Z',
    areas: [],
    meetings: [{ id: 'm', subject: 'x', start: 's', end: 'e', isOnline: true, relevance: 'everyone' }],
    mail: [],
    pings: [],
  };
  const result = DeskBriefingSchema.safeParse(bad);
  assert.equal(result.success, false);
});

// --------------------------------------------------------------------------
// Endpoint integration (ingested calendar wired end-to-end)
// --------------------------------------------------------------------------

function ingestedConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    integrations: { sourceControl: 'fake', issues: 'fake', backlog: 'fake', calendar: 'ingested' },
  });
}

test('POST /api/briefing persists the briefing and surfaces it in state and the world calendar', async () => {
  const system = buildSystem(ingestedConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/briefing', payload: briefing() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().counts, { meetings: 1, mail: 1, pings: 1 });

  const state = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  // The read-only briefing is returned wholesale.
  assert.equal(state.briefing.owner.email, 'adam@example.com');
  assert.equal(state.briefing.mail.length, 1);
  assert.equal(state.briefing.pings.length, 1);
  // And the meeting half flows through the harness world's calendar slice.
  assert.equal(state.world.calendar.length, 1);
  assert.equal(state.world.calendar[0].id, 'm_42');
  assert.equal(state.world.calendar[0].title, 'Design review');
  assert.deepEqual(state.world.calendar[0].prepDocs, [
    'https://teams.microsoft.com/l/meetup-join/xyz',
    'https://outlook.office365.com/owa/?itemid=42',
  ]);

  system.store.close();
});

test('POST /api/briefing rejects a malformed payload with 400', async () => {
  const system = buildSystem(ingestedConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/briefing', payload: { owner: {} } });
  assert.equal(res.statusCode, 400);
  assert.ok(typeof res.json().error === 'string');

  system.store.close();
});
