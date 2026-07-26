/**
 * The `note_progress` tool's pure layer: what a progress note is allowed to be.
 * No store, no transport — so the one-line contract the fleet card depends on is
 * testable on its own, and the handler is left with the persist-and-envelope step.
 *
 * ## The gap this closes
 *
 * A fleet card's live line is `agent:tail` — the last non-empty line the process
 * happened to print, folded in `Hub.updateTail`. Three things are wrong with it as
 * an answer to "what is this agent doing, and is it stuck?":
 *
 * - **It is a byproduct, not a statement.** In stream mode the transcript is
 *   `renderBlocks` output, so the last line is as likely to be a tool label or a
 *   truncated tool result as it is to be a sentence about the work.
 * - **It is ephemeral and per-cockpit.** The tail lives in the `Hub`'s in-memory
 *   map and the cockpit's `tails` ref, fed by broadcast frames. Reload the page,
 *   or open the cockpit twenty minutes into a run, and there is nothing to show
 *   until the agent's next line of output — the card is simply blank.
 * - **Nobody wrote it for a reader.** It answers "is output still coming out",
 *   which is a liveness signal, not a progress one. On a forty-minute run those
 *   are different questions and the operator is asking the second.
 *
 * So this tool is the agent's own answer, written to be read: attributed by
 * credential, timestamped, and durable on the agent row.
 *
 * ## Beside the tail, never instead of it
 *
 * The note does not replace `agent:tail` and does not suppress it. Same asymmetry
 * as `@@LUBBDUBB_DONE@@` against the `result` event (#108): a note an agent forgets
 * to call is *silence*, and silence must not read as "no progress". An agent that
 * never calls this leaves a card that looks exactly like today's. Where both exist
 * they answer different questions and neither substitutes: the note is a claim
 * (durable, attributed, possibly stale), the tail is evidence the process is still
 * emitting (live, unattributed, gone on reload).
 *
 * ## One field, and why there is not a second
 *
 * `note` and nothing else. The obvious candidate for a second is a `stage` enum —
 * exploring / implementing / testing / blocked — which would give the fleet view a
 * scannable chip. It is not here because only one of those members implies an
 * operator action, `blocked`, and {@link file://./tools.ts}'s `escalate` already
 * owns that one and does it properly: it parks the agent and returns an answer. A
 * vocabulary whose only actionable member is another tool's job is decoration, and
 * a miscategorised chip reads as authoritative in a way free text does not. A
 * percentage-complete field fails a harder test: there is nothing for the model to
 * derive it from, so it would be invented.
 *
 * ## Trimmed, not rejected
 *
 * Unlike `report_finding`, an over-long note is stored (trimmed) rather than
 * refused, and the response says it was trimmed. The two are different kinds of
 * write. A finding is testimony an operator acts on, so a malformed one must not
 * land at all. A progress note is a status line whose whole value is being cheap
 * and frequent: a trimmed one still answers the question, while a rejected one
 * leaves the card blank and taxes the agent a turn to learn that. Only an empty
 * note is refused, because there is nothing to store.
 */

/**
 * How much of a note reaches the store. The fleet card renders one ellipsised
 * line, so this is roughly what a reader gets before the CSS truncates it anyway.
 */
export const MAX_NOTE_LENGTH = 200;

/**
 * Normalise one `note_progress` argument into the single line the card contract
 * assumes, reporting whether anything was cut so the caller can hear about it.
 *
 * Whitespace is collapsed rather than validated: "one line" is a property this
 * function can simply establish, and a note pasted with a newline in it is a
 * fine note that happens to be formatted wrong.
 */
export function normaliseNote(
  value: unknown,
): { ok: true; note: string; trimmed: boolean } | { ok: false; error: string } {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!raw) {
    return {
      ok: false,
      error: 'note is required: one line saying what you are working on right now, in plain words.',
    };
  }
  if (raw.length <= MAX_NOTE_LENGTH) return { ok: true, note: raw, trimmed: false };
  return { ok: true, note: raw.slice(0, MAX_NOTE_LENGTH - 1).trimEnd() + '…', trimmed: true };
}
