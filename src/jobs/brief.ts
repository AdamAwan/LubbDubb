import type { Config } from '../config.js';
import { briefTicketFields } from '../briefTicket.js';
import type { ErrorRecorder } from '../errorLog.js';
import { deriveJobTitle } from '../jobs.js';
import { trackerCoordinates } from '../mcp/findings.js';
import type { Store } from '../store/store.js';
import type { TicketFiler } from '../tickets/filing.js';
import type { Job } from '../types.js';
import { watchLabelFor } from '../watchLabels.js';

/**
 * Submitting an operator's brief, in one place — the door a piece of
 * operator-launched work comes in through, whichever surface asked for it.
 *
 * **A code brief is filed as a watched ticket, not dispatched onto a branch**
 * (issue #198), so it flows through the planning funnel — appraisal, plan, parts,
 * work — exactly like a picked-up issue rather than being coded straight off the
 * prompt. That transform lives here, at submission time; rule `manual-job` is
 * untouched, which keeps a clean recursion boundary.
 *
 * **The harness files it rather than a desk agent** (issue #394), and that is the
 * half worth guarding: the ticket must carry the effective watch label or the
 * funnel never picks it up, and an agent that forgot it left an item created, a
 * filing shown complete in the cockpit, and **nothing ever dispatched** — no
 * error, nothing red. A label the harness passes cannot be forgotten.
 *
 * Two arms fall through to a direct dispatch instead: a **desk** brief, which is
 * not funnel work, and a code brief on a deployment with **no tracker**, which has
 * nowhere to file.
 */
interface BriefContext {
  store: Store;
  config: Config;
  filing: TicketFiler;
  errors: ErrorRecorder;
  /**
   * Renders the `brief-ticket-body` template. Passed in rather than reached for,
   * because the body an operator's words become is operator-overridable and a
   * second rendering of it here would be a template that only one surface honours.
   */
  renderTicketBody(vars: Record<string, string>): string;
  /**
   * Where images the operator attached are written, once the ref the work will
   * live under is known — `issue:<n>` for a filed ticket, `job:<id>` for a direct
   * dispatch. A callback rather than a list, because the ref is decided in the
   * middle of this function and the caller owns what "attaching" means.
   *
   * It may throw. On the ticket arm a failure is recorded and the ticket stands;
   * on the job arm the job is cancelled and the throw propagates, because a brief
   * that says "make it look like this" without the "this" is worse than no brief.
   */
  attach?(targetRef: string): void;
}

type BriefOutcome =
  | { ok: true; kind: 'ticket'; ticketRef: string }
  | { ok: true; kind: 'job'; job: Job }
  | { ok: false; reason: 'branch_busy' | 'tracker_refused'; error: string };

interface BriefInput {
  prompt: string;
  /** Falls back to the prompt's first line. */
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
        // The operator's own words, through the template — never the raw prompt.
        body: ctx.renderTicketBody(derived.vars),
        // Empty when the watch gate is off (`labelPrefix: ''`), and an empty label
        // must not be written: the harness then acts on every open issue and there
        // is nothing to tag.
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
    // The images follow the ticket, which is what makes them the *goal's*: every
    // agent the funnel dispatches for this issue is handed them. Recorded rather
    // than raised — the ticket exists and the operator asked for it, and losing the
    // onward visibility of a screenshot is the smaller failure.
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

  // Refuse a branch a live task already holds, up front (issue #116). The
  // executor's identical check is the real gate and stays — a branch can go busy
  // between queueing and dispatch — but a refusal now is worth far more to the
  // operator than a deferral read out of the decision log hours later. Only for
  // code jobs: rule `manual-job` ignores a desk job's branch entirely.
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
