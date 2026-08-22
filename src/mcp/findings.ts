/**
 * Two pure answers the tracker arms share: what a world-item ref may be, and
 * **which** tracker the harness files into.
 *
 * What used to be here — the four finding kinds, the three-field validation, and
 * the prompts a promoted or filed finding was worked from — went with the store it
 * belonged to. There is one claim store now
 * (`docs/spec/27-knowledge.md#what-the-three-stores-became`), so the validation is
 * the intake's, and what a claim becomes when an operator sends it somewhere is
 * `src/knowledge/graduation.ts`.
 *
 * The file keeps its name because both survivors have five callers between them
 * across the routes, the snapshot and the tool channel, and a rename is a diff
 * across all of them for no reading anybody gains.
 */

import type { Config } from '../config.js';

/**
 * Normalise the world item a claim or a ticket names.
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
 * unqueryable junk drawer, and a claim about something the harness does not track
 * belongs in the claim itself with no ref at all.
 */
export function parseItemRef(ref: unknown): { ok: true; ref: string | null } | { ok: false; error: string } {
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
