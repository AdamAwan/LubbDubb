/**
 * The `report_finding` tool's pure layer: what kinds exist, what a `ref` may be,
 * and what a well-formed report looks like. No store, no transport — so the
 * vocabulary and the validation are testable on their own, and the tool handler
 * is left with nothing but the persist-and-envelope step.
 *
 * ## The gap this closes
 *
 * An agent that discovers something *outside its own task* had nowhere to put it.
 * "This issue duplicates #41", "the real fix is in a package I don't own",
 * "there's an unrelated bug in the module I touched" all ended up in a PR comment,
 * hoping a human read it: nothing landed in the store, nothing surfaced in the
 * cockpit, and nothing could act on it later.
 *
 * ## Does a finding become work? No — deliberately.
 *
 * #108 floats "optionally becomes a queued job". It does not, and the reason is
 * not caution for its own sake: a queued job is dispatched by rule 0 *ahead of
 * every world-driven rule*, so an agent that could queue jobs could put agents on
 * the fleet. That is a capability escalation, not a convenience — one agent's
 * hunch would spend another agent's slot, budget and worktree, with nothing in
 * between saying yes. It is exactly the shape the auto-send seam exists to gate,
 * and an ungated back door round it is what issue #108's own open question 3
 * warns about.
 *
 * So a finding is a **claim, not work**. Nothing in the dispatcher reads the
 * `findings` table. The conservative arm is operator-driven promotion: the
 * cockpit's Findings panel turns one into a queued job on a click
 * (`POST /api/findings/:id/promote`), which is the same `Store.createJob` path the
 * Launch panel already uses — so the operator's authority stays the only thing
 * that puts an agent on the fleet, and the finding records which job it became.
 * The tool's description says this outright, so an agent does not report a bug and
 * then assume it is now being handled.
 */

import type { Finding, FindingInput, FindingKind } from '../types.js';

/**
 * The kinds a finding can be.
 *
 * Three, taken from the three things agents concretely could not say (Exhibit C
 * of #108) rather than invented as a taxonomy. What earns each one a slot is that
 * it implies a *different operator action* — that is the axis worth splitting on,
 * and it is why there is no catch-all fourth: a bucket that implies no action is
 * a place for findings to rot, and the summary already carries the detail.
 */
export const FINDING_KINDS = ['duplicate', 'blocked', 'out_of_scope'] as const satisfies readonly FindingKind[];

/** What each kind means, as told to the agent — the description *is* the vocabulary. */
export const FINDING_KIND_HELP: Record<FindingKind, string> = {
  duplicate: 'this work item is the same work as another one (the operator closes or links one of them)',
  blocked: "the fix needs a change outside what you can touch — another repo, a package you don't own",
  out_of_scope: 'something real you found that is not your task — an unrelated bug, a gap nobody has filed',
};

/** The longest summary we store. Long enough for a paragraph, short enough to read in a list. */
const MAX_SUMMARY = 2000;

/**
 * Normalise the item a finding is *about*.
 *
 * Deliberately the same closed vocabulary the rest of the harness writes
 * (`pr:42`, `issue:12`, `story:abc`), suffix-tolerant for the same reason
 * `world_read` is: the origin ref an agent holds (`pr:42:ci`,
 * `issue:12:part:schema`) names the item, so it can be passed back verbatim.
 *
 * A bare number is *rejected*, unlike in `world_read` — there is no `kind`
 * argument here to say which list it belongs to, and guessing between issue #41
 * and PR #41 is exactly the sort of quiet wrong that a duplicate report must not
 * make. Anything else is rejected too: an open-ended ref field becomes an
 * unqueryable junk drawer, and a finding about something the harness does not
 * track belongs in the summary with no ref at all.
 */
export function parseFindingRef(ref: unknown): { ok: true; ref: string | null } | { ok: false; error: string } {
  if (ref === undefined || ref === null) return { ok: true, ref: null };
  if (typeof ref !== 'string') return { ok: false, error: 'ref must be a string like "issue:41", or omitted.' };
  const raw = ref.trim();
  // An omitted ref and an empty one mean the same thing: this finding is about no
  // tracked item. Not every discovery has one, which is why `ref` is optional.
  if (!raw) return { ok: true, ref: null };

  const m = /^(pr|issue|story):(.+)$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      error:
        `ref "${raw}" is not a harness ref. Use "pr:42", "issue:41" or "story:abc" — a bare number is ` +
        'ambiguous between an issue and a PR. If the finding is about something the harness does not ' +
        'track (an upstream package, say), omit ref and describe it in the summary.',
    };
  }
  const kind = m[1] as 'pr' | 'issue' | 'story';
  const rest = m[2] ?? '';
  if (kind === 'story') return { ok: true, ref: `story:${rest.trim()}` };
  // `pr:42:ci` / `issue:12:part:schema` — the number is the first segment; the
  // rest is the concern an origin ref carries, which names no different item.
  const head = rest.split(':')[0]?.replace(/^#/, '') ?? '';
  if (!/^\d+$/.test(head)) return { ok: false, error: `ref "${raw}" does not contain a ${kind} number.` };
  return { ok: true, ref: `${kind}:${Number(head)}` };
}

/** How long a promoted finding's job title may be before it stops being a title. */
const MAX_TITLE = 80;

/**
 * What a finding becomes when an operator promotes it: the title and prompt of a
 * queued job. Pure, so the wording is testable and the route is left with the
 * `Store.createJob` call.
 *
 * The prompt carries the finding's *provenance* — which agent saw it, on what
 * origin — because the promoted agent's first question is always "says who, and
 * were they looking at this or at something else?", and the answer is the one
 * thing a PR comment could never be trusted to keep attached.
 */
export function findingJobRequest(finding: Finding): { title: string; prompt: string } {
  const firstLine = finding.summary.split('\n')[0]?.trim() ?? finding.summary;
  const label = `[${finding.kind}]${finding.ref ? ` ${finding.ref}` : ''} `;
  const title = `${label}${firstLine}`.slice(0, MAX_TITLE);
  const about = finding.ref ? ` about ${finding.ref}` : '';
  const prompt = [
    `An operator promoted a finding${about} into work. It was reported by an agent working ` +
      `${finding.originRef ?? 'an unrelated task'}, who found it outside its own scope (kind: ${finding.kind} — ` +
      `${FINDING_KIND_HELP[finding.kind]}).`,
    '',
    'The report, verbatim:',
    '',
    finding.summary,
    '',
    'Verify it before acting on it — it is one agent’s reading, not an established fact. If it turns out ' +
      'not to hold, say so and stop rather than inventing work to justify the dispatch.',
  ].join('\n');
  return { title, prompt };
}

/**
 * Validate one `report_finding` call at the boundary, the way every other typed
 * payload in the harness is validated — and, unlike the file-based side channels,
 * hand the reason back to the caller so it can fix it inside the same turn.
 *
 * Note what is *not* here: no agent, task, issue or author argument. Identity is
 * structural (see {@link file://./tools.ts}), so there is nothing to validate.
 */
export function validateFinding(
  args: Record<string, unknown>,
): { ok: true; input: FindingInput } | { ok: false; error: string } {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  if (!(FINDING_KINDS as readonly string[]).includes(kind)) {
    const help = FINDING_KINDS.map((k) => `"${k}" (${FINDING_KIND_HELP[k]})`).join('; ');
    return { ok: false, error: `kind must be one of: ${help}. Got ${JSON.stringify(args.kind)}.` };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return { ok: false, error: 'summary is required: one or two sentences an operator can act on without asking you.' };
  }
  if (summary.length > MAX_SUMMARY) {
    return { ok: false, error: `summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}.` };
  }
  const ref = parseFindingRef(args.ref);
  if (!ref.ok) return { ok: false, error: ref.error };
  return { ok: true, input: { kind: kind as FindingKind, ref: ref.ref, summary } };
}
