import type { Store } from '../../store/store.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type { CalendarEvent } from '../../types.js';
import type { Capability, Integration, WorldSlice } from '../integration.js';
import type { MicrosoftGraphApi, MsCalendarEvent, MsDateTimeZone } from './microsoftGraphApi.js';

export interface MicrosoftCalendarOpts {
  /** The Graph client, already bound to a single calendar (delegated `me` or a target user). */
  api: MicrosoftGraphApi;
  store: Store;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /** How many days ahead to surface events. */
  windowDays: number;
}

/**
 * The real `calendar` provider for Microsoft 365 (Outlook / Teams calendar): reads
 * upcoming events from Microsoft Graph and surfaces them as the world's `calendar`
 * slice. A drop-in for {@link FakeCalendarIntegration} — same {@link Integration}
 * seam, reading from the network instead of an injected fake world, so it is *not*
 * `Injectable`.
 *
 * Step 1 is read-only surfacing: no writes back to Graph, no meeting-prep dispatch.
 */
export class MicrosoftCalendarIntegration implements Integration {
  readonly id = 'calendar:microsoft365';
  readonly capability: Capability = 'calendar';

  /** Last successful slice, served on a transient failure so the calendar doesn't flap. */
  private lastGood: CalendarEvent[] = [];

  constructor(private readonly opts: MicrosoftCalendarOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const events = await this.opts.api.listUpcomingEvents(this.opts.windowDays);
      const calendar = events.map(mapGraphEvent);
      this.lastGood = calendar;
      return { calendar };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      return { calendar: this.lastGood };
    }
  }
}

/** Map a Graph event down to the domain {@link CalendarEvent} the cockpit renders. */
export function mapGraphEvent(ev: MsCalendarEvent): CalendarEvent {
  // Surface the actionable links as prep material: the Teams join URL (if this is an
  // online meeting) and the Outlook web link that opens the event.
  const prepDocs: string[] = [];
  if (ev.joinUrl) prepDocs.push(ev.joinUrl);
  if (ev.webLink) prepDocs.push(ev.webLink);
  return {
    id: ev.id,
    title: ev.subject || '(untitled event)',
    startsAt: graphStartToIso(ev.start),
    prepDocs,
    // Surfacing only — the harness hasn't done any prep, and this provider doesn't
    // (yet) write prep-done state back to Graph.
    prepDone: false,
  };
}

/**
 * Normalise Graph's `dateTimeTimeZone` to an ISO instant.
 *
 * {@link RestMicrosoftGraphApi} asks Graph to return times in UTC (the
 * `Prefer: outlook.timezone` header), so `timeZone` is `UTC` and `dateTime` is a
 * zone-less UTC wall-clock — we just mark it with `Z`. Graph emits up to seven
 * fractional-second digits, which `Date` won't parse, so truncate to whole seconds
 * (meeting granularity needs nothing finer). A non-UTC zone can't be converted here
 * without tz data, so pass the wall-clock through rather than drop the event.
 */
export function graphStartToIso(start: MsDateTimeZone): string {
  const whole = start.dateTime.trim().replace(/\.\d+$/, '');
  if (start.timeZone === 'UTC') {
    const asInstant = new Date(`${whole}Z`);
    if (!Number.isNaN(asInstant.getTime())) return asInstant.toISOString();
  }
  return whole;
}
