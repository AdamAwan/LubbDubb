import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  MicrosoftCalendarIntegration,
  graphStartToIso,
  mapGraphEvent,
} from '../src/integrations/microsoft/calendar.js';
import type { MicrosoftGraphApi, MsCalendarEvent } from '../src/integrations/microsoft/microsoftGraphApi.js';

/** A Graph event with benign defaults; override just the fields a case cares about. */
function event(over: Partial<MsCalendarEvent> = {}): MsCalendarEvent {
  return {
    id: 'evt_1',
    subject: 'Standup',
    start: { dateTime: '2026-07-22T09:00:00.0000000', timeZone: 'UTC' },
    joinUrl: null,
    webLink: null,
    ...over,
  };
}

interface FakeState {
  events: MsCalendarEvent[];
  /** Flip on to make the next call throw — exercises the last-good fallback. */
  fail: boolean;
  /** The windowDays argument every call was made with. */
  windowDaysSeen: number[];
}

function fakeApi(events: MsCalendarEvent[] = []): { api: MicrosoftGraphApi; state: FakeState } {
  const state: FakeState = { events, fail: false, windowDaysSeen: [] };
  const api: MicrosoftGraphApi = {
    async listUpcomingEvents(windowDays) {
      state.windowDaysSeen.push(windowDays);
      if (state.fail) throw new Error('boom');
      return state.events;
    },
  };
  return { api, state };
}

// --------------------------------------------------------------------------
// Integration (snapshot)
// --------------------------------------------------------------------------

test('snapshot maps Graph events into the calendar slice and passes the window through', async () => {
  const store = new Store(':memory:');
  const { api, state } = fakeApi([
    event({
      id: 'evt_42',
      subject: 'Design review',
      start: { dateTime: '2026-07-22T14:30:00.0000000', timeZone: 'UTC' },
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz',
      webLink: 'https://outlook.office365.com/owa/?itemid=42',
    }),
  ]);
  const cal = new MicrosoftCalendarIntegration({ api, store, windowDays: 14 });

  const slice = await cal.snapshot();

  assert.deepEqual(slice.calendar, [
    {
      id: 'evt_42',
      title: 'Design review',
      startsAt: '2026-07-22T14:30:00.000Z',
      prepDocs: ['https://teams.microsoft.com/l/meetup-join/xyz', 'https://outlook.office365.com/owa/?itemid=42'],
      prepDone: false,
    },
  ]);
  assert.deepEqual(state.windowDaysSeen, [14]);
  store.close();
});

test('snapshot serves the last-good slice and does not throw on a transient failure', async () => {
  const store = new Store(':memory:');
  const { api, state } = fakeApi([event({ id: 'evt_7' })]);
  const cal = new MicrosoftCalendarIntegration({ api, store, windowDays: 7 });

  const first = await cal.snapshot(); // warm the last-good cache
  assert.equal(first.calendar?.length, 1);

  state.fail = true;
  const second = await cal.snapshot(); // failing → serve last-good, must not throw
  assert.deepEqual(second.calendar, first.calendar);
  store.close();
});

// --------------------------------------------------------------------------
// Pure mapping
// --------------------------------------------------------------------------

test('graphStartToIso marks a UTC wall-clock as an instant and truncates sub-second digits', () => {
  assert.equal(
    graphStartToIso({ dateTime: '2026-07-22T09:00:00.0000000', timeZone: 'UTC' }),
    '2026-07-22T09:00:00.000Z',
  );
  assert.equal(
    graphStartToIso({ dateTime: '2026-07-22T09:30:15.1234567', timeZone: 'UTC' }),
    '2026-07-22T09:30:15.000Z',
  );
});

test('graphStartToIso passes a non-UTC wall-clock through rather than dropping the event', () => {
  // No tz data here to convert, so the wall-clock survives (RestMicrosoftGraphApi asks
  // Graph for UTC, so this branch is a defensive fallback).
  assert.equal(
    graphStartToIso({ dateTime: '2026-07-22T09:00:00.0000000', timeZone: 'Pacific Standard Time' }),
    '2026-07-22T09:00:00',
  );
});

test('mapGraphEvent labels an untitled hold and collects only the links that exist', () => {
  const untitled = mapGraphEvent(event({ subject: '', joinUrl: 'https://join', webLink: null }));
  assert.equal(untitled.title, '(untitled event)');
  assert.deepEqual(untitled.prepDocs, ['https://join']);
  assert.equal(untitled.prepDone, false);

  const bare = mapGraphEvent(event({ joinUrl: null, webLink: null }));
  assert.deepEqual(bare.prepDocs, []);
});
