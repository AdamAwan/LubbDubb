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
 * there deliberately. A `pr:<m>:*` agent is refused even when its PR is linked to
 * the issue, because `linkedPrNumber` is sticky — that join would let an agent reach
 * a pad through a PR the issue merely points at — and a job agent is refused because
 * `job:<id>` is distinct work whose origin says nothing about which goal it serves.
 */

/** A note long enough to be a paragraph of reasoning, short enough not to be a pasted transcript. */
export const MAX_PAD_NOTE = 4000;

/** A topic is a scannable tag, not a sentence. */
const MAX_PAD_TOPIC = 60;

/**
 * The pad an origin belongs to, or null when the origin is not inside one issue's
 * subtree. The vocabulary is the harness's own — `issue:<n>` plus the `:plan`,
 * `:appraisal`, `:assess`, `:retro` and `:part:<slug>` suffixes the rules already
 * dispatch on — so nothing here has to be kept in step with a second taxonomy.
 */
export function padOriginFor(originRef: string | null): string | null {
  if (!originRef) return null;
  const match = /^issue:(\d+)(?::.+)?$/.exec(originRef);
  return match ? `issue:${match[1]}` : null;
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
      `The scratchpad belongs to one issue and the agents working it, and this task's origin is ` +
      `${originRef ?? '(none)'}, which is not one of them. If you noticed something outside your own ` +
      `task, use report_finding; if you are saying what you are working on right now, use note_progress.`,
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
