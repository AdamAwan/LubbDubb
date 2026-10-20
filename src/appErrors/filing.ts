import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import { issueOriginNumber } from '../issueOrigins.js';
import { requestInvestigation, type IssueWatchContext } from '../issueWatch.js';
import type { IssueKeySink } from '../sink/actionSink.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { AppErrorTicketSearch } from '../types.js';
import { investigateLabelFor, watchLabelFor } from '../watchLabels.js';
import type { AppErrorGroupView, AppErrorPressPayload, AppErrorsPayload } from '../wire.js';
import type { AppErrorTrackerDesk } from './tracker.js';

// → docs/spec/39-app-errors.md#the-presses

const MAX_TITLE_CHARS = 200;

export interface AppErrorFilingDeps {
  tracker: AppErrorTrackerDesk;
  sink: Partial<IssueKeySink>;
  filing: TicketFiler;
  prompts: PromptTemplates;
  watch: IssueWatchContext;
  current: () => AppErrorsPayload;
  /** `trackerCoordinates(config)`, read live: null when there is no tracker to file into. */
  trackerTarget: () => string | null;
}

export type PressOutcome = AppErrorPressPayload | { ok: false; status: 404 | 409 | 502; error: string };

interface FileRequest {
  environment: string;
  fingerprint: string;
  investigate: boolean;
  /** The operator files knowing the search could not answer: the lock is off for this one press. */
  unsearched: boolean;
}

const inFlight = new Set<string>();

export async function fileAppErrorBug(deps: AppErrorFilingDeps, request: FileRequest): Promise<PressOutcome> {
  if (deps.trackerTarget() === null) return noTracker();
  const group = findGroup(deps.current(), request.environment, request.fingerprint);
  if (group === null)
    return { ok: false, status: 404, error: `no error group ${request.fingerprint} is held on ${request.environment}` };
  if (inFlight.has(group.key)) return { ok: false, status: 409, error: `${group.key} is already being filed` };
  inFlight.add(group.key);
  try {
    const found = await searchAgain(deps, group.key, request.unsearched);
    if (!found.ok) return found;
    if (found.search?.status === 'open' && found.search.ticketRef !== null)
      return {
        ok: true,
        ticketRef: found.search.ticketRef,
        reused: true,
        investigation: request.investigate ? await investigate(deps, found.search.ticketRef, group.key) : null,
      };
    const ticketRef = await deps.filing({
      title: `${request.environment}: ${group.title}`.slice(0, MAX_TITLE_CHARS),
      body: deps.prompts.render('app-error-ticket-body', bodyVars(group)),
      bug: true,
      labels: request.investigate ? investigateLabels(deps.watch.labelPrefix) : [],
      ...relatedTo(group),
      errorKey: group.key,
    });
    deps.tracker.record({
      key: group.key,
      status: 'open',
      ticketRef,
      closedAt: null,
      tickets: (found.search?.tickets ?? 0) + 1,
      detail: null,
    });
    return { ok: true, ticketRef, reused: false, investigation: request.investigate ? { failed: [] } : null };
  } finally {
    inFlight.delete(group.key);
  }
}

export async function reopenAppErrorTicket(deps: AppErrorFilingDeps, key: string): Promise<PressOutcome> {
  if (deps.trackerTarget() === null) return noTracker();
  if (deps.sink.canReopenIssue?.() !== true || deps.sink.reopenIssue === undefined)
    return {
      ok: false,
      status: 409,
      error: 'this tracker cannot be reopened from here (on Azure DevOps, name issuePickupStates); reopen it there',
    };
  const found = await searchAgain(deps, key, false);
  if (!found.ok) return found;
  const search = found.search!;
  if (search.status === 'open' && search.ticketRef !== null)
    return { ok: true, ticketRef: search.ticketRef, reused: true, investigation: null };
  const number = search.status === 'closed' ? issueOriginNumber('root', search.ticketRef) : null;
  if (number === null) return { ok: false, status: 409, error: `nothing closed is filed under ${key} to reopen` };
  await deps.sink.reopenIssue.call(deps.sink, number);
  deps.tracker.record({ ...search, status: 'open', closedAt: null, detail: null });
  return { ok: true, ticketRef: search.ticketRef!, reused: false, investigation: null };
}

function noTracker(): PressOutcome {
  return {
    ok: false,
    status: 409,
    error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)',
  };
}

/** The search right before the write, so the window two fleets can both file in is seconds, not a read interval. */
async function searchAgain(
  deps: AppErrorFilingDeps,
  key: string,
  unsearched: boolean,
): Promise<{ ok: true; search: AppErrorTicketSearch | null } | { ok: false; status: 409 | 502; error: string }> {
  if (!deps.tracker.searchable()) {
    if (unsearched) return { ok: true, search: null };
    return {
      ok: false,
      status: 409,
      error: 'this tracker cannot be searched by key, so a duplicate cannot be ruled out',
    };
  }
  const search = (await deps.tracker.search([key])).get(key)!;
  if (search.status !== 'unknown') return { ok: true, search };
  if (unsearched) return { ok: true, search: null };
  return {
    ok: false,
    status: 502,
    error: `${search.detail ?? 'the tracker search failed'} — not filing what may be a duplicate; retry, or file anyway`,
  };
}

async function investigate(deps: AppErrorFilingDeps, ticketRef: string, key: string): Promise<{ failed: string[] }> {
  const number = issueOriginNumber('root', ticketRef);
  if (number === null) return { failed: [`${ticketRef} is not an issue the harness can label`] };
  const { failed } = await requestInvestigation(deps.watch, number, `to investigate app error ${key}`);
  return { failed: failed.map((f) => `#${String(f.number)}: ${f.message}`) };
}

function investigateLabels(prefix: string): string[] {
  return [watchLabelFor(prefix), investigateLabelFor(prefix)].filter((label) => label !== '');
}

function relatedTo(group: AppErrorGroupView): { relatedTo?: number } {
  const story = issueOriginNumber('root', group.link?.goalRef ?? null);
  return story === null ? {} : { relatedTo: story };
}

function findGroup(payload: AppErrorsPayload, environment: string, fingerprint: string): AppErrorGroupView | null {
  const env = payload.environments.find((e) => e.environment === environment);
  return env?.groups.find((g) => g.fingerprint === fingerprint) ?? null;
}

function bodyVars(group: AppErrorGroupView): Record<string, string | number> {
  return {
    title: group.title,
    environment: group.environment,
    state: group.state,
    count: group.count,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    operation: group.operation ?? '(not reported)',
    version: group.version ?? '(not reported)',
    frames: group.frames.length === 0 ? '(none reported)' : ['```', ...group.frames.slice(0, 10), '```'].join('\n'),
    link: group.url ?? '(none)',
  };
}
