/**
 * The narrow Microsoft Graph network seam — the counterpart to {@link AzureDevOpsApi}
 * and {@link GitHubApi}.
 *
 * Only the operations the Microsoft 365 integrations actually use live here, not
 * the whole Graph surface. This is the boundary that isolates network I/O: the
 * real {@link RestMicrosoftGraphApi} is the *only* file that speaks HTTP (and
 * resolves auth), and tests inject a scripted fake, so the mapping logic in the
 * integrations is exercised without a single request.
 *
 * The payload types are minimal structural shapes describing only the fields we
 * read, so Graph's sprawling response shapes don't leak across the codebase.
 */
export interface MicrosoftGraphApi {
  /**
   * Calendar events starting within the next `windowDays` days, ordered by start
   * time. Recurring series are expanded into individual occurrences (Graph's
   * `calendarView`), so each returned event is a concrete meeting on the calendar.
   */
  listUpcomingEvents(windowDays: number): Promise<MsCalendarEvent[]>;
}

/** One calendar event, reduced to the fields the `calendar` slice needs. */
export interface MsCalendarEvent {
  /** Graph event id — stable per occurrence. */
  id: string;
  /** The meeting subject; may be empty for an untitled hold. */
  subject: string;
  /** Start instant as Graph returns it: a naive datetime plus its IANA/Windows zone. */
  start: MsDateTimeZone;
  /** Teams/online-meeting join URL, when the event has one. */
  joinUrl: string | null;
  /** Web link that opens the event in Outlook. */
  webLink: string | null;
}

/** Graph's `dateTimeTimeZone` shape: a zone-less local datetime + the zone it's in. */
export interface MsDateTimeZone {
  /** e.g. `2026-07-22T09:00:00.0000000` — no offset; interpret with `timeZone`. */
  dateTime: string;
  /** e.g. `UTC` or `Pacific Standard Time`. */
  timeZone: string;
}
