import type { PadDecision } from '../types.js';

/**
 * The scratchpad's pure layer: which pad a caller may reach, and what an entry is
 * allowed to be. No store and no transport, so the access rule every tool rests on
 * is testable on its own.
 *
 * ## The gap this closes
 *
 * Nothing let one agent leave something a later agent — or a retrospective — could
 * read. `note_progress` is a single overwritten line written for a fleet card, so
 * the second call destroys the first. `report_finding` is testimony about work
 * *outside* the caller's task, deliberately narrow and operator-actioned. Neither is
 * "here is what I learned doing this, for whoever works this goal next", which is
 * the thing a decomposed issue needs most: five part agents rediscovering one
 * constraint is the cost of having no such surface.
 *
 * ## Why the pad is never named by argument
 *
 * Identity is structural for every write in the tool channel: the credential
 * resolves `token -> agent -> task -> origin`, and the tool derives what it may
 * touch from that. A `padRef` argument would make this the one write an agent could
 * aim at another goal's record, and it would buy nothing — an agent has exactly one
 * goal.
 *
 * ## Why the whole issue subtree shares one pad
 *
 * The sharing *is* the feature: these are agents on one goal, dispatched by one
 * plan, and a part reading what a sibling learned is what the pad is for. It stops
 * there deliberately. A `pr:<m>:*` agent never reaches an issue's pad even when its
 * PR is linked to the issue, because `linkedPrNumber` is sticky — that join would
 * let an agent reach a pad through a PR the issue merely points at — and a job
 * agent is refused because `job:<id>` is distinct work whose origin says nothing
 * about which goal it serves.
 *
 * ## Why a pull request has a pad of its own
 *
 * The CI-fix and review-comment agents are `pr:<n>:*` origins, and they are exactly
 * the agents whose pushes move a head — so the forks behind a pull request's later
 * heads are theirs. They write to `pr:<n>`: a second family, its own record, that no
 * issue agent reads and that reaches no issue's pad. The join the refusal above
 * guards against is still never made; the pull request's pad is beside the issue's,
 * not a door into it. → docs/spec/31-review-packs.md#the-witness-log
 */

/** A note long enough to be a paragraph of reasoning, short enough not to be a pasted transcript. */
export const MAX_PAD_NOTE = 4000;

/** A topic is a scannable tag, not a sentence. */
const MAX_PAD_TOPIC = 60;

/**
 * The pad an origin belongs to, or null when the origin is inside neither one
 * issue's subtree nor one pull request's. The vocabulary is the harness's own —
 * `issue:<n>` plus the `:plan`, `:appraisal`, `:assess`, `:retro` and
 * `:part:<slug>` suffixes the rules already dispatch on, and `pr:<n>` plus the
 * `:ci`, `:review`, `:comment:<id>` and `:merge` concerns — so nothing here has to
 * be kept in step with a second taxonomy. The two families never meet: an origin
 * resolves to exactly one of them by its own first segment, never by a join.
 */
export function padOriginFor(originRef: string | null): string | null {
  if (!originRef) return null;
  const match = /^(issue|pr):(\d+)(?::.+)?$/.exec(originRef);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * The **goal** an origin is inside — the issue family of {@link padOriginFor} alone,
 * for the readers that scope a briefing, an instruction or an attachment to "the
 * goal this agent is working". A pull request's pad is a record of its own and not
 * a goal: nothing about `issue:12` reaches `pr:42:ci` through here, which is
 * `outstandingForOrigin`'s widening rule, and the pull request's own pad reaches
 * its agents through `scratch_read` rather than a replay.
 */
export function goalOriginFor(originRef: string | null): string | null {
  const pad = padOriginFor(originRef);
  return pad?.startsWith('issue:') ? pad : null;
}

/**
 * Resolve the caller's pad, refusing anything outside an issue **by name and with
 * the tool it actually wants** — `partConclusionOrigin`'s discipline, because an
 * agent handed a silent success believes its note was recorded.
 */
export function padWriteTarget(originRef: string | null): { ok: true; padRef: string } | { ok: false; error: string } {
  const padRef = padOriginFor(originRef);
  if (padRef) return { ok: true, padRef };
  return {
    ok: false,
    error:
      `The scratchpad belongs to one issue or one pull request and the agents working it, and this ` +
      `task's origin is ${originRef ?? '(none)'}, which is neither. If you noticed something outside ` +
      `your own task, use report_finding; if you are saying what you are working on right now, use note_progress.`,
  };
}

/**
 * Normalise one entry.
 *
 * An over-long note is **trimmed and stored** rather than refused — `note_progress`'s
 * rule and for its reason: a pad note's whole value is being cheap and frequent,
 * while a refusal costs the agent a turn to learn about. Only an empty note is
 * refused, because there is nothing to record. The note keeps its newlines (it is
 * prose a human reads, unlike a one-line status); only the topic is collapsed,
 * since it exists to be scanned.
 */
export function normalisePadNote(
  value: unknown,
  topic: unknown,
): { ok: true; note: string; topic: string | null; trimmed: boolean } | { ok: false; error: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return {
      ok: false,
      error:
        'note is required: what you learned, tried, or decided, in plain words — written for whoever ' +
        'works this goal next and for the retrospective at the end.',
    };
  }
  const tag = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim().slice(0, MAX_PAD_TOPIC) : '';
  const trimmed = raw.length > MAX_PAD_NOTE;
  return { ok: true, note: trimmed ? raw.slice(0, MAX_PAD_NOTE) : raw, topic: tag || null, trimmed };
}

/** A decision line is one line: what was chosen, why, or one alternative. Longer is a note. */
export const MAX_PAD_LINE = 300;

/** Alternatives and paths past this are a pasted transcript, not a fork. */
export const MAX_DECISION_ITEMS = 20;

/**
 * Normalise a fork's `decision`, the way {@link normalisePadNote} normalises the
 * note beside it — and refuse malformed input **by field name**, because the
 * schema the tool advertises is a hint the model reads once, and an object with
 * `chose` missing that landed as a note would be a fork the log silently lost.
 *
 * Absent (or null) means the entry is an ordinary note. Present, `chose` and
 * `because` are required and every line is collapsed to one; over-long lines and
 * over-long lists are trimmed rather than refused, `normalisePadNote`'s trade for
 * its reason. What comes back is always the whole shape — empty lists rather than
 * missing ones — so a reader never has to ask which fields a fork carries.
 */
export function normalisePadDecision(
  value: unknown,
): { ok: true; decision: PadDecision | null; trimmed: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, decision: null, trimmed: false };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'decision must be an object: {chose, because, rejected, paths}.' };
  }
  const raw = value as Record<string, unknown>;
  let trimmed = false;
  const line = (field: string, v: unknown, what: string): string | { error: string } => {
    const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { error: `${field} is required: ${what}, in one line.` };
    if (text.length > MAX_PAD_LINE) trimmed = true;
    return text.slice(0, MAX_PAD_LINE);
  };
  const chose = line('decision.chose', raw.chose, 'what the change does here');
  if (typeof chose !== 'string') return { ok: false, error: chose.error };
  const because = line('decision.because', raw.because, 'why');
  if (typeof because !== 'string') return { ok: false, error: because.error };

  const rejectedRaw = raw.rejected ?? [];
  if (!Array.isArray(rejectedRaw)) {
    return { ok: false, error: 'decision.rejected must be a list of {alternative, because}, or omitted.' };
  }
  const rejected: PadDecision['rejected'] = [];
  for (const [i, item] of rejectedRaw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `decision.rejected[${i}] must be an object: {alternative, because}.` };
    }
    const r = item as Record<string, unknown>;
    const alternative = line(`decision.rejected[${i}].alternative`, r.alternative, 'the road not taken');
    if (typeof alternative !== 'string') return { ok: false, error: alternative.error };
    const why = line(`decision.rejected[${i}].because`, r.because, 'why it was not taken');
    if (typeof why !== 'string') return { ok: false, error: why.error };
    rejected.push({ alternative, because: why });
  }

  const pathsRaw = raw.paths ?? [];
  if (!Array.isArray(pathsRaw)) return { ok: false, error: 'decision.paths must be a list of file paths, or omitted.' };
  const paths: string[] = [];
  for (const [i, item] of pathsRaw.entries()) {
    const path = line(`decision.paths[${i}]`, item, 'a file path');
    if (typeof path !== 'string') return { ok: false, error: path.error };
    paths.push(path);
  }

  if (rejected.length > MAX_DECISION_ITEMS || paths.length > MAX_DECISION_ITEMS) trimmed = true;
  return {
    ok: true,
    decision: {
      chose,
      because,
      rejected: rejected.slice(0, MAX_DECISION_ITEMS),
      paths: paths.slice(0, MAX_DECISION_ITEMS),
    },
    trimmed,
  };
}

/**
 * The instruction to record forks, **appended** to every code dispatch's rendered
 * prompt by `recordDispatchTask` and never interpolated into a template: an
 * operator's override written before this existed would drop a `{witness}` token
 * in silence, on exactly the deployments that customised most. Desk agents do not
 * get it — they move no head, and a pack is written from the forks behind one.
 *
 * Short on purpose. It says what a fork is, that `rejected` is the field that
 * matters, and that an empty log is fine — because a prose ceiling to fill is what
 * turns a record of facts into a story. → docs/spec/31-review-packs.md#the-witness-log
 */
export const WITNESS_INSTRUCTION = [
  '## Record the forks you take',
  '',
  'When the change could reasonably have gone another way — two ways to shape a fix, a file you',
  'chose not to touch, an approach you tried and dropped — leave a `scratch_append` entry with a',
  '`decision` beside the note: `chose` (what you did here), `because` (why), `rejected` (each',
  'alternative with the reason it was not taken) and `paths` (the files the fork touches, where you',
  'can say). One line each, written at the fork rather than as a narrative at the end. `rejected`',
  'is the field that matters: the road not taken leaves no trace in the diff, and it is the thing a',
  'reviewer asks about most. If there were no forks, write nothing — an empty log is an honest one.',
].join('\n');
