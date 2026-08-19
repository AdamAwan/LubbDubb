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
 * not caution for its own sake: a queued job is dispatched by rule `manual-job` *ahead of
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

import type { Config } from '../config.js';
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

/**
 * The three text fields, and what each may hold.
 *
 * A finding used to be one `summary` asked for "what it is, where, and why it
 * matters" plus the evidence — four things in one string, which is how it
 * arrived in the cockpit as a single undifferentiated block with the claim, the
 * identifier and the stack trace all at the same weight. Naming the parts is
 * what separates them; nothing else can, because the structure was never in the
 * text to begin with.
 *
 * `summary` is capped short and refuses a newline, and that refusal is the
 * load-bearing part of the split: it turns a blob into a tool error the agent
 * fixes inside its own turn rather than something an operator reads hours later.
 * `where` and `detail` are optional, because a required field an agent has
 * nothing for comes back as "N/A" and noise is worse than a blob.
 */
const MAX_SUMMARY = 160;
const MAX_WHERE = 200;
const MAX_DETAIL = 2000;

/**
 * Normalise the item a finding is *about*.
 *
 * Deliberately the same closed vocabulary the rest of the harness writes
 * (`pr:42`, `issue:12`), suffix-tolerant for the same reason
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

  const m = /^(pr|issue):(.+)$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      error:
        `ref "${raw}" is not a harness ref. Use "pr:42" or "issue:41" — a bare number is ` +
        'ambiguous between an issue and a PR. If the finding is about something the harness does not ' +
        'track (an upstream package, say), omit ref and describe it in the summary.',
    };
  }
  const kind = m[1] as 'pr' | 'issue';
  const rest = m[2] ?? '';
  // `pr:42:ci` / `issue:12:part:schema` — the number is the first segment; the
  // rest is the concern an origin ref carries, which names no different item.
  const head = rest.split(':')[0]?.replace(/^#/, '') ?? '';
  if (!/^\d+$/.test(head)) return { ok: false, error: `ref "${raw}" does not contain a ${kind} number.` };
  return { ok: true, ref: `${kind}:${Number(head)}` };
}

/** How long a promoted finding's job title may be before it stops being a title. */
const MAX_TITLE = 80;

/**
 * The three fields recomposed into one block of prose, for the places a finding
 * is handed to *another agent* rather than drawn on a card.
 *
 * It exists so `where` and `detail` reach the promoted and the filing agent
 * without either gaining a `{token}` of its own. Prompt templates are
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so a new one is silently dropped by every override that never
 * learned about it — folding the new fields into the existing `summary` value
 * has no such fallback to get wrong. → CLAUDE.md, "Prompts and templates".
 *
 * A legacy row is its own report: null `where` and `detail` collapse to the
 * summary alone, which is exactly what those rows used to render as.
 */
function findingReport(finding: Finding): string {
  return [
    finding.summary,
    finding.where ? `\nWhere: ${finding.where}` : '',
    finding.detail ? `\n${finding.detail}` : '',
  ]
    .join('')
    .trim();
}

/** The one line a finding is titled by — its summary, or the first line of a pre-split blob. */
function findingHeadline(finding: Finding): string {
  return finding.summary.split('\n')[0]?.trim() ?? finding.summary;
}

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
  const label = `[${finding.kind}]${finding.ref ? ` ${finding.ref}` : ''} `;
  const title = `${label}${findingHeadline(finding)}`.slice(0, MAX_TITLE);
  const about = finding.ref ? ` about ${finding.ref}` : '';
  const prompt = [
    `An operator promoted a finding${about} into work. It was reported by an agent working ` +
      `${finding.originRef ?? 'an unrelated task'}, who found it outside its own scope (kind: ${finding.kind} — ` +
      `${FINDING_KIND_HELP[finding.kind]}).`,
    '',
    'The report, verbatim:',
    '',
    findingReport(finding),
    '',
    'Verify it before acting on it — it is one agent’s reading, not an established fact. If it turns out ' +
      'not to hold, say so and stop rather than inventing work to justify the dispatch.',
  ].join('\n');
  return { title, prompt };
}

/**
 * **Which** tracker the harness files into, named so a prompt can say it — and the
 * one gate on whether filing is offered at all.
 *
 * It used to be a `gh`/`az` **command**, composed here and handed to a desk agent
 * to run in its own shell, because the wording of a ticket is the part an operator
 * has opinions about and a prompt is where those opinions live. Issue #394 kept the
 * wording and took the command back: the harness creates the item through
 * {@link ActionSink.createIssue}, so the type, the labels, the assignee and any
 * relation are structural rather than a sentence a model has to remember. What is
 * left is the fact a composing agent genuinely cannot infer from a scratch
 * directory with no git remote — where its words are going to end up.
 *
 * Null for the `fake` provider (and for a provider whose config is absent): there
 * is no tracker to file into, and the cockpit hides the button rather than offering
 * one that fails. Every filing route asks this before it does anything else, so the
 * three that no longer dispatch an agent share the refusal with the one that does.
 */
export function trackerCoordinates(config: Config): string | null {
  const provider = config.integrations.issues;
  if (provider === 'github' && config.github) {
    return `the GitHub repository ${config.github.owner}/${config.github.repo}`;
  }
  if (provider === 'azure' && config.azureDevOps) {
    const { organization, project } = config.azureDevOps;
    return `the Azure DevOps project "${project}" in organization "${organization}"`;
  }
  return null;
}

/**
 * The values the `finding-ticket` prompt is rendered with — pure, so the wording
 * an agent acts on is testable without a server, and so the route is left with
 * nothing but `render` + `createJob`.
 *
 * `title` is the job's, not the ticket's: the agent writes the ticket's title
 * (that is the judgement being delegated), while this one only has to be
 * recognisable in the Up next queue.
 */
export function findingTicketFields(
  finding: Finding,
  tracker: string,
): { title: string; vars: Record<string, string> } {
  const title = `File ticket: ${findingHeadline(finding)}`.slice(0, MAX_TITLE);
  return {
    title,
    vars: {
      kind: finding.kind,
      kindHelp: FINDING_KIND_HELP[finding.kind],
      ref: finding.ref ?? 'nothing the harness tracks',
      // The whole report, not the headline: the `{summary}` placeholder is what
      // every override already renders, so the new fields ride in on it.
      summary: findingReport(finding),
      originRef: finding.originRef ?? 'an untracked task',
      tracker,
    },
  };
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
    return { ok: false, error: 'summary is required: one line an operator can act on without asking you.' };
  }
  // Both refusals name the field the text belongs in. An error that only says
  // "too long" gets the same paragraph back, shortened.
  if (/[\r\n]/.test(summary)) {
    return {
      ok: false,
      error:
        'summary must be a single line — the claim on its own. Put the error, the repro and the ' +
        'reasoning in detail, and the file or package in where.',
    };
  }
  if (summary.length > MAX_SUMMARY) {
    return {
      ok: false,
      error:
        `summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}. It is the one line an ` +
        'operator scans — move the rest into detail.',
    };
  }
  const where = typeof args.where === 'string' ? args.where.trim() : '';
  if (where.length > MAX_WHERE) {
    return { ok: false, error: `where is ${where.length} characters; keep it under ${MAX_WHERE}.` };
  }
  const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
  if (detail.length > MAX_DETAIL) {
    return { ok: false, error: `detail is ${detail.length} characters; keep it under ${MAX_DETAIL}.` };
  }
  const ref = parseFindingRef(args.ref);
  if (!ref.ok) return { ok: false, error: ref.error };
  return {
    ok: true,
    input: { kind: kind as FindingKind, ref: ref.ref, summary, where: where || null, detail: detail || null },
  };
}
