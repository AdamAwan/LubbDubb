import type { Config } from '../config.js';
import { briefTicketFields } from '../briefTicket.js';
import type { ErrorRecorder } from '../errorLog.js';
import { deriveJobTitle } from '../jobs.js';
import { trackerCoordinates } from '../mcp/findings.js';
import type { Store } from '../store/store.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { Job } from '../types.js';
import { watchLabelFor } from '../watchLabels.js';

// → docs/spec/13-jobs-and-tickets.md

interface BriefContext {
  store: Store;
  config: Config;
  filing: TicketFiler;
  errors: ErrorRecorder;
  renderTicketBody(vars: Record<string, string>): string;
  attach?(targetRef: string): void;
}

type BriefOutcome =
  | { ok: true; kind: 'ticket'; ticketRef: string }
  | { ok: true; kind: 'job'; job: Job }
  | { ok: false; reason: 'branch_busy' | 'tracker_refused'; error: string };

interface BriefInput {
  prompt: string;
  title?: string | null;
  kind: 'code' | 'desk';
  branch?: string | null;
}

export async function submitBrief(ctx: BriefContext, input: BriefInput): Promise<BriefOutcome> {
  const { store, config, errors } = ctx;
  const { prompt, kind } = input;
  const providedTitle = input.title ?? null;
  const branch = input.branch ?? null;

  const tracker = kind === 'code' ? trackerCoordinates(config) : null;
  if (tracker) {
    const watchLabel = watchLabelFor(config.labelPrefix);
    const derived = briefTicketFields(prompt);
    let ticketRef: string;
    try {
      ticketRef = await ctx.filing({
        title: providedTitle ?? derived.title,
        body: ctx.renderTicketBody(derived.vars),
        labels: watchLabel ? [watchLabel] : [],
      });
    } catch (err) {
      errors.record({ source: 'provider', message: `filing a brief as a ticket failed: ${(err as Error).message}` });
      return {
        ok: false,
        reason: 'tracker_refused',
        error: `the tracker refused the ticket: ${(err as Error).message}`,
      };
    }
    try {
      ctx.attach?.(ticketRef);
    } catch (err) {
      errors.record({
        source: 'server',
        message: `The ticket ${ticketRef} was filed but its attachment(s) could not be stored: ${(err as Error).message}. Agents working it will not see them.`,
      });
    }
    return { ok: true, kind: 'ticket', ticketRef };
  }

  if (kind === 'code' && branch) {
    const held = store.findActiveTaskByBranch(branch);
    if (held)
      return {
        ok: false,
        reason: 'branch_busy',
        error: `branch ${branch} is held by active task ${held.id}${held.originRef ? ` (${held.originRef})` : ''}`,
      };
  }

  const job = store.createJob({ title: providedTitle ?? deriveJobTitle(prompt), prompt, kind, branch });
  try {
    ctx.attach?.(`job:${job.id}`);
  } catch (err) {
    store.cancelJob(job.id);
    throw err;
  }
  return { ok: true, kind: 'job', job };
}
