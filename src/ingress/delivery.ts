import { z } from 'zod';
import { issueReadRef, prReadRef } from '../world/readPlan.js';

/**
 * Turning one delivery into the one thing the harness does with it: the set of
 * entities whose cached hydration is now wrong.
 *
 * **Every field here is attacker-controlled in the limit.** A verified GitHub
 * delivery proves only that somebody holding the secret produced the bytes; an
 * Azure post proves only that somebody holding the basic credential sent it
 * (`src/ingress/signature.ts`). So nothing in a payload is read as a *fact* — not
 * a title, not a state, not a label. The only thing taken from it is a number
 * naming an entity, and even that is used solely to say "re-read this one", which
 * the harness then does through the authenticated provider API. The worst a
 * fabricated id can do is spend one entity's fan-out on the next pulse.
 * → `docs/spec/30-ingress.md#what-the-endpoint-trusts`
 */

/** What a delivery asks the harness to do. Empty refs means "nothing to re-read". */
interface IngressEffect {
  /** Refs (`pr:42`, `issue:7`) whose hydration this delivery invalidates. */
  refs: string[];
  /** What it was, for the debug log. Never the payload — only the event's own name. */
  summary: string;
}

const NOTHING = (summary: string): IngressEffect => ({ refs: [], summary });

/**
 * The most entities one delivery may name.
 *
 * A `check_suite` legitimately lists several pull requests; a forged one could
 * list a hundred thousand, and each is a fan-out the next pulse pays for. Sixteen
 * is comfortably above anything a real delivery carries and is a bound rather than
 * a guess about what is normal.
 */
const MAX_REFS = 16;

/**
 * A number that could name an entity: a positive integer inside the range a
 * tracker actually issues. `z.number().int()` alone would accept `1e300` and
 * `-1`, which reach the cache as keys nothing will ever match and the provider as
 * requests for items that do not exist.
 */
const EntityNumber = z.number().int().positive().max(2_147_483_647);

/** A payload object. Anything else — an array, a string, `null` — names no entity. */
const Payload = z.object({}).passthrough();

/**
 * GitHub's events, keyed off `X-GitHub-Event`.
 *
 * Only the events that name an entity the harness holds a hydration for are here.
 * Everything else — `push`, `status`, `ping`, and the sixty others a repository
 * hook can be subscribed to — is accepted and does nothing, which is deliberate:
 * an event that names no entity would fire a cycle that invalidates nothing, and a
 * repository's `push` traffic would then set this fleet's provider spend.
 *
 * `issue_comment` is the one that needs care. GitHub numbers issues and pull
 * requests out of one sequence and delivers a comment on either as `issue_comment`
 * — the `pull_request` sub-object is the only thing that says which. Reading it
 * wrong invalidates `issue:12` while the stale hydration is `pr:12`'s, which is a
 * miss that looks exactly like the webhook not being wired up.
 * → `docs/spec/30-ingress.md#what-each-event-invalidates`
 */
export function githubEffect(event: string, payload: unknown): IngressEffect {
  const body = Payload.safeParse(payload);
  if (!body.success) return NOTHING(`${event} (no object payload)`);
  const data = body.data;

  switch (event) {
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
    case 'pull_request_review_thread': {
      // `pull_request.number` on every one of them; `number` at the top level is
      // the same value on the `pull_request` event and absent on the other three.
      const shape = z.object({
        number: EntityNumber.optional(),
        pull_request: z.object({ number: EntityNumber }).optional(),
      });
      const read = shape.safeParse(data);
      const number = read.success ? (read.data.pull_request?.number ?? read.data.number) : undefined;
      return refs(event, number === undefined ? [] : [prReadRef(number)]);
    }
    case 'issues':
    case 'issue_comment': {
      const shape = z.object({
        // `pull_request` present at all is GitHub saying "this number is a pull
        // request". Its contents are never read, so an empty object is enough.
        issue: z.object({ number: EntityNumber, pull_request: z.unknown().optional() }),
      });
      const read = shape.safeParse(data);
      if (!read.success) return NOTHING(`${event} (no issue number)`);
      const { number, pull_request: pr } = read.data.issue;
      return refs(event, [pr === undefined ? issueReadRef(number) : prReadRef(number)]);
    }
    case 'check_run':
    case 'check_suite':
    case 'workflow_run': {
      // A check names a commit, not a pull request — the numbers come from the
      // `pull_requests` array the check object carries. GitHub leaves that array
      // empty for a pull request opened from a fork, so a fork's builds are the one
      // thing this endpoint cannot hear about and the slow lane still covers.
      const list = z.object({ pull_requests: z.array(z.object({ number: EntityNumber })).optional() });
      const shape = z.object({
        check_run: list.optional(),
        check_suite: list.optional(),
        workflow_run: list.optional(),
      });
      const read = shape.safeParse(data);
      if (!read.success) return NOTHING(`${event} (no pull requests)`);
      const inner = read.data.check_run ?? read.data.check_suite ?? read.data.workflow_run;
      return refs(
        event,
        (inner?.pull_requests ?? []).map((p) => prReadRef(p.number)),
      );
    }
    default:
      return NOTHING(event);
  }
}

/** `refs/pull/42/merge` — how an Azure build names the pull request it is validating. */
const PULL_BRANCH = /^refs\/pull\/(\d{1,9})\/(?:merge|head)$/;

/**
 * Azure DevOps service hooks, keyed off the payload's own `eventType`.
 *
 * The event name arrives *inside* the body here rather than in a header, which is
 * one more reason the body is read for a number and nothing else: on Azure the
 * caller chooses the event name too.
 *
 * `build.complete` is the one with no id in it. What it carries is the branch the
 * build ran on, and for a pull-request validation build that is `refs/pull/N/merge`
 * — so the number is parsed out of it, bounded, and treated exactly like any other
 * claimed number. A build on a normal branch names no entity and does nothing.
 */
export function azureEffect(payload: unknown): IngressEffect {
  const body = z.object({ eventType: z.string().max(200), resource: Payload.optional() }).safeParse(payload);
  if (!body.success) return NOTHING('(no eventType)');
  const { eventType, resource } = body.data;
  if (resource === undefined) return NOTHING(eventType);

  if (eventType.startsWith('git.pullrequest.')) {
    const read = z
      .object({
        pullRequestId: EntityNumber.optional(),
        pullRequest: z.object({ pullRequestId: EntityNumber }).optional(),
      })
      .safeParse(resource);
    const number = read.success ? (read.data.pullRequestId ?? read.data.pullRequest?.pullRequestId) : undefined;
    return refs(eventType, number === undefined ? [] : [prReadRef(number)]);
  }
  // The comment event's id is `ms.vss-code.git-pullrequest-comment-event`, which
  // shares nothing with the `git.pullrequest.*` family but the payload shape.
  if (eventType.includes('git-pullrequest-comment')) {
    const read = z.object({ pullRequest: z.object({ pullRequestId: EntityNumber }) }).safeParse(resource);
    return refs(eventType, read.success ? [prReadRef(read.data.pullRequest.pullRequestId)] : []);
  }
  if (eventType.startsWith('workitem.')) {
    const read = z.object({ id: EntityNumber.optional(), workItemId: EntityNumber.optional() }).safeParse(resource);
    const number = read.success ? (read.data.id ?? read.data.workItemId) : undefined;
    return refs(eventType, number === undefined ? [] : [issueReadRef(number)]);
  }
  if (eventType === 'build.complete') {
    const read = z.object({ sourceBranch: z.string().max(400).optional() }).safeParse(resource);
    const branch = read.success ? (read.data.sourceBranch ?? '') : '';
    const number = PULL_BRANCH.exec(branch)?.[1];
    return refs(eventType, number === undefined ? [] : [prReadRef(Number(number))]);
  }
  return NOTHING(eventType);
}

/** De-duplicated and bounded — see {@link MAX_REFS}. */
function refs(summary: string, found: string[]): IngressEffect {
  return { refs: [...new Set(found)].slice(0, MAX_REFS), summary };
}
