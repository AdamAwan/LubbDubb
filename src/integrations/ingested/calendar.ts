import type { Store } from '../../store/store.js';
import type { BriefingMeeting, CalendarEvent } from '../../types.js';
import type { Capability, Integration, WorldSlice } from '../integration.js';

export interface IngestedCalendarOpts {
  store: Store;
}

/**
 * The `calendar` provider fed by the Claude-bridged {@link DeskBriefing} rather than
 * a live Graph connection. It reads the latest ingested briefing from the store and
 * maps its `meetings` into the world's `calendar` slice — a drop-in for
 * {@link MicrosoftCalendarIntegration}, but sourced from persisted ingest instead of
 * the network. No I/O, so it can never throw; an absent/empty briefing is just an
 * empty calendar.
 */
export class IngestedCalendarIntegration implements Integration {
  readonly id = 'calendar:ingested';
  readonly capability: Capability = 'calendar';

  constructor(private readonly opts: IngestedCalendarOpts) {}

  async snapshot(): Promise<WorldSlice> {
    const briefing = this.opts.store.getDeskBriefing();
    if (!briefing) return { calendar: [] };
    return { calendar: briefing.meetings.map(mapBriefingMeeting) };
  }
}

/**
 * Map an ingested {@link BriefingMeeting} down to the thin domain {@link CalendarEvent}
 * the cockpit renders — mirrors `mapGraphEvent`. The join and web links become prep
 * material (in that order); prep is never done, since this provider only surfaces.
 */
export function mapBriefingMeeting(m: BriefingMeeting): CalendarEvent {
  const prepDocs = [m.joinUrl, m.webLink].filter((d): d is string => Boolean(d));
  return {
    id: m.id,
    title: m.subject || '(untitled event)',
    startsAt: m.start,
    prepDocs,
    prepDone: false,
  };
}
