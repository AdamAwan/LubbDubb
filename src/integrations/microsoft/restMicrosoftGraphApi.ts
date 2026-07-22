import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MicrosoftGraphApi, MsCalendarEvent } from './microsoftGraphApi.js';

const execFileAsync = promisify(execFile);

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** The Microsoft Graph resource the `az` CLI mints access tokens against. */
const GRAPH_RESOURCE = 'https://graph.microsoft.com';

/**
 * How the harness authenticates to Microsoft Graph. Two strategies ship, chosen by
 * {@link resolveMicrosoftGraphAuth}: a static bearer token (`MICROSOFT_GRAPH_TOKEN`)
 * or, when none is set, an access token from the logged-in `az` CLI. Injectable so
 * the REST client stays testable and the `az` spawn is isolated — the same shape as
 * the Azure DevOps auth seam.
 */
interface MicrosoftGraphAuth {
  /** The `Authorization` header value to send with each request. */
  header(): Promise<string>;
}

/** A bearer token supplied verbatim via the environment — the analogue of a PAT. */
class StaticTokenAuth implements MicrosoftGraphAuth {
  constructor(private readonly token: string) {}
  async header(): Promise<string> {
    return `Bearer ${this.token}`;
  }
}

/**
 * Bearer auth from the logged-in `az` CLI (`az account get-access-token`). The token
 * is cached and refreshed on a fixed window rather than parsing Azure's ambiguous
 * local-time `expiresOn` — Graph tokens live well past this, so a conservative
 * refresh is safe and avoids a fragile date parse.
 */
class AzCliGraphAuth implements MicrosoftGraphAuth {
  private cached: { token: string; fetchedAtMs: number } | null = null;
  /** Refresh well inside the token's real lifetime (typically 60–90 min). */
  private static readonly TTL_MS = 45 * 60 * 1000;

  constructor(private readonly fetchToken: () => Promise<string> = defaultGraphToken) {}

  async header(): Promise<string> {
    const now = Date.now();
    if (!this.cached || now - this.cached.fetchedAtMs >= AzCliGraphAuth.TTL_MS) {
      this.cached = { token: await this.fetchToken(), fetchedAtMs: now };
    }
    return `Bearer ${this.cached.token}`;
  }
}

/** Spawn the `az` CLI for a Graph access token. Throws a clear error if `az` isn't logged in. */
async function defaultGraphToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', GRAPH_RESOURCE, '--query', 'accessToken', '--output', 'tsv'],
      // On Windows `az` is `az.cmd`; execFile won't resolve the extension without a
      // shell, so it ENOENTs. All args here are hardcoded constants — no injection risk.
      { shell: true },
    );
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    throw new Error(
      `Could not get a Microsoft Graph token from the az CLI (${(err as Error).message}). ` +
        'Run `az login`, or set MICROSOFT_GRAPH_TOKEN to a bearer token.',
    );
  }
}

/**
 * Pick the auth strategy: a static bearer token (`MICROSOFT_GRAPH_TOKEN`) if set,
 * otherwise the logged-in `az` CLI. The token is read from the environment only —
 * never from config — so a secret never lands in a committed file (mirroring
 * `GITHUB_TOKEN` / `AZURE_DEVOPS_PAT`).
 */
export function resolveMicrosoftGraphAuth(): MicrosoftGraphAuth {
  const token = process.env.MICROSOFT_GRAPH_TOKEN;
  return token ? new StaticTokenAuth(token) : new AzCliGraphAuth();
}

// ---------------------------------------------------------------------------
// Minimal shape of the Graph JSON we read. Only the fields we consume.
// ---------------------------------------------------------------------------

interface RawEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  webLink?: string;
}

/**
 * The real {@link MicrosoftGraphApi}: all Graph HTTP behind `fetch`, mapping Graph's
 * responses down to the minimal `Ms*` shapes the integration consumes. All Graph
 * HTTP (and auth) lives here — nothing else in the repo touches Graph — so the
 * integration stays network-free and unit-testable.
 *
 * The calendar is addressed either as the delegated signed-in user (`/me`, when
 * `userId` is null) or a specific mailbox (`/users/{userId}`, which app-only
 * client-credential tokens require since they have no `me`).
 */
export class RestMicrosoftGraphApi implements MicrosoftGraphApi {
  constructor(
    private readonly auth: MicrosoftGraphAuth,
    /** Target mailbox (UPN or object id); null = the delegated signed-in user. */
    private readonly userId: string | null,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static create(cfg: { userId?: string }, auth: MicrosoftGraphAuth): RestMicrosoftGraphApi {
    return new RestMicrosoftGraphApi(auth, cfg.userId ?? null);
  }

  private get calendarPath(): string {
    return this.userId ? `/users/${encodeURIComponent(this.userId)}/calendarView` : '/me/calendarView';
  }

  async listUpcomingEvents(windowDays: number): Promise<MsCalendarEvent[]> {
    const start = this.now();
    const end = new Date(start.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const url = new URL(`${GRAPH_BASE}${this.calendarPath}`);
    url.searchParams.set('startDateTime', start.toISOString());
    url.searchParams.set('endDateTime', end.toISOString());
    url.searchParams.set('$orderby', 'start/dateTime');
    url.searchParams.set('$top', '50');
    url.searchParams.set('$select', 'subject,start,onlineMeeting,webLink');
    const data = await this.request<{ value?: RawEvent[] }>(url.toString());
    return (data.value ?? []).map(mapRawEvent);
  }

  private async request<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: await this.auth.header(),
        Accept: 'application/json',
        // Ask Graph to express event times in UTC, so the zone-less `start.dateTime`
        // is a UTC wall-clock the integration can mark with `Z` (see graphStartToIso).
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Microsoft Graph GET ${url} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

function mapRawEvent(e: RawEvent): MsCalendarEvent {
  return {
    id: e.id,
    subject: e.subject ?? '',
    start: { dateTime: e.start?.dateTime ?? '', timeZone: e.start?.timeZone ?? 'UTC' },
    joinUrl: e.onlineMeeting?.joinUrl ?? null,
    webLink: e.webLink ?? null,
  };
}
