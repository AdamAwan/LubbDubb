/**
 * The failing output of a red CI check, fetched at dispatch and appended to the
 * agent's prompt.
 *
 * ## The gap
 *
 * A CI-fix agent used to be handed the **names** of the failing checks and
 * nothing else (`ciFailureNote`). Names are not output: the agent knows *that*
 * `lint` is red and nothing about *why*, so its cheapest route to the actual
 * error is to reproduce the failure locally — in this repository `npm run check`,
 * six passes over 151 test files, all of it landing in context before a single
 * edit, and again on every retry and every later CI dispatch on the same branch.
 *
 * The saving is not bytes off a prompt, it is **turns**. An agent handed the
 * failing assertion goes straight to the file; an agent handed a check name
 * rebuilds the world first.
 *
 * ## Structured errors first, log tail second
 *
 * Both providers expose the failure twice: once already extracted, once as raw
 * output. GitHub has check-run **annotations** (`{path, line, message}` — what
 * the pull request page renders beside the diff); Azure has the build
 * **timeline**, whose per-task records carry an `issues[]` of errors. Those are
 * preferred wherever they are populated, because they *are* the failing
 * assertion rather than a heuristic guess at where it lives, and because they
 * cost one small request instead of a log download.
 *
 * The raw tail is the fallback for the large set of jobs that emit no structured
 * error at all — a bare `npm test` with no problem matcher. Both providers cost
 * a whole download that is then tailed locally: Azure's endpoint does offer a
 * line range, but a range needs a total line count to take a *tail* from, which
 * is a second request, so `getBuildLog` fetches the log whole. What differs is
 * **granularity** — Azure's smallest unit is one failed task, GitHub's is the
 * entire job. That is a bandwidth cost, not a token cost, and it is why the
 * structured read is tried first rather than second.
 *
 * ## Why it is bounded, and why the cap is per prompt
 *
 * This is input tokens the harness *adds* to every CI dispatch, so it pays for
 * itself only if it is genuinely the failing part; an excerpt that is mostly
 * setup noise is a straight loss. Three red checks at a per-check cap would be
 * three times the budget on a prompt that is otherwise five lines, so
 * {@link MAX_EVIDENCE_CHARS} is a **whole-prompt** budget divided across the
 * checks that have evidence.
 *
 * What the cap dropped is always **named**, never silently cut — the rule
 * `priorWork.ts` already follows. An agent that reads a partial log as a whole
 * one draws a conclusion from the absence of an error that was merely trimmed,
 * which is worse than having no excerpt at all.
 */

/** One failing check's evidence, as the provider was able to supply it. */
export interface CiFailureEvidence {
  /** The check name, matching {@link CiCheck.name} — what the agent sees it called. */
  check: string;
  /**
   * Which of the two sources this came from. It changes how the excerpt is
   * trimmed ({@link trimEvidence}) and how it is labelled: an agent reading
   * three extracted errors should not think it is reading the whole log.
   */
  kind: 'errors' | 'log';
  /**
   * The excerpt, split to lines and already free of provider framing. Ordered
   * as the agent should read it: `errors` most-significant first (the first
   * error is usually the cause of the rest), `log` in the order it was printed.
   */
  lines: string[];
  /**
   * Lines the **provider read** did not return — a log longer than the tail that
   * was asked for. Distinct from what {@link ciEvidenceNote}'s cap drops, and
   * reported separately, because they answer different questions: this one says
   * the harness never saw them, the cap says it saw them and chose.
   */
  droppedBefore?: number;
}

/** One check the harness wants evidence for, as {@link CiEvidenceReader} is asked. */
export interface CiEvidenceTarget {
  name: string;
  /** {@link CiCheck.evidenceRef} — opaque here, meaningful only to the provider that wrote it. */
  evidenceRef: string;
}

/**
 * The seam the executor depends on: "what broke on these checks of this PR".
 *
 * A **read**, deliberately not on {@link ActionSink} — that seam changes the
 * world, and this only looks at it. It is not on {@link Connector} either: the
 * world snapshot is taken every pulse for every open pull request, and a log
 * fetch on that path would be paid on every pulse and used on almost none of
 * them. This is asked once per actual dispatch, which is bounded and rare.
 *
 * Never throws and never rejects. A provider that cannot answer — no capability,
 * a 404, a timeout, a PAT without build scope — returns the checks it *could*
 * answer for, or nothing at all, having recorded the failure through
 * `errors.record`. Absent evidence must leave the prompt exactly as it was, and
 * a dispatch must never fail because a log could not be read.
 */
export interface CiEvidenceReader {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

/**
 * The whole-prompt budget for evidence, in characters.
 *
 * Sized against what it displaces rather than by feel: reproducing this repo's
 * own `npm run check` costs an agent tens of thousands of tokens of test output
 * before it has read a single source file, so a few thousand characters of the
 * actual assertion is a large net saving even when it misses. Sized *down* by
 * the fact that it is spent on every CI dispatch including the ones where the
 * agent would have found the fault immediately.
 */
const MAX_EVIDENCE_CHARS = 6000;

/**
 * The smallest excerpt worth including for one check. Below this a share is too
 * small to carry a stack frame, so it would spend prompt on a fragment that
 * cannot be acted on — better to name the check as un-excerpted and let the
 * agent look, which is what it would have done anyway.
 */
const MIN_SHARE_CHARS = 400;

/** Lines of a raw log worth asking a provider for. Ignored for structured errors. */
export const EVIDENCE_LOG_TAIL_LINES = 120;

/**
 * The evidence block appended to a CI-fix prompt, or `''` when there is none.
 *
 * **Appended by the caller, never interpolated.** `pr-ci-fix` is operator-
 * overridable and `loadPromptTemplates` rejects only *unknown* placeholders, so
 * an override written before this existed would silently drop a `{logs}` token —
 * on exactly the deployments that customised most. Empty string in, byte-
 * identical prompt out, which is what makes a failed fetch invisible rather than
 * damaging.
 */
export function ciEvidenceNote(evidence: CiFailureEvidence[]): string {
  const usable = evidence.filter((e) => e.lines.length > 0);
  if (usable.length === 0) return '';

  // An even split rather than first-come: the checks are unordered as far as the
  // agent is concerned, and letting a chatty first log eat the budget would hide
  // the second check's assertion behind the first one's setup noise.
  const share = Math.floor(MAX_EVIDENCE_CHARS / usable.length);
  const included =
    share >= MIN_SHARE_CHARS ? usable : usable.slice(0, Math.floor(MAX_EVIDENCE_CHARS / MIN_SHARE_CHARS));
  const perCheck = Math.floor(MAX_EVIDENCE_CHARS / Math.max(included.length, 1));

  const lines = [
    'What the failing checks actually reported. The harness fetched this from the provider, so you do not need ' +
      'to reproduce the failure to find out what broke — read it first, and reproduce only if it is not enough:',
  ];
  for (const e of included) {
    const { text, dropped, cutMidLine } = trimEvidence(e, perCheck);
    lines.push(
      '',
      `--- ${e.check} (${e.kind === 'errors' ? 'errors reported by the check' : 'end of the job log'}) ---`,
    );
    lines.push(text);
    // Both kinds of loss are named, and named apart. A reader who cannot tell
    // "the harness trimmed this" from "the provider never sent it" cannot tell
    // whether fetching the rest would help.
    const notes: string[] = [];
    if (e.droppedBefore) notes.push(`${e.droppedBefore} earlier lines were not fetched`);
    if (dropped) notes.push(`${dropped} more ${e.kind === 'errors' ? 'errors were' : 'lines were'} trimmed to fit`);
    // A third loss, and it needs its own wording: the line the reader is holding
    // is itself incomplete, which neither of the two above says.
    if (cutMidLine) notes.push('one line was longer than the budget and was cut mid-line to fit');
    if (notes.length > 0) lines.push(`[${notes.join('; ')} — open the check in the provider for the full output.]`);
  }

  const omitted = usable.length - included.length;
  if (omitted > 0) {
    lines.push(
      '',
      `[${omitted} other failing check${omitted === 1 ? '' : 's'} had output too, but it would not fit in this ` +
        'prompt. Open them in the provider if the above does not explain the failure.]',
    );
  }

  return `\n\n${lines.join('\n')}`;
}

/**
 * Cut one check's excerpt to its share, from the end that matters.
 *
 * The direction is the whole point and it differs by kind. A **log** fails at the
 * bottom — the assertion, the stack, the exit code — and its head is install and
 * setup noise, so the tail is kept. **Errors** are already ranked, and a later
 * error is usually a consequence of the first, so the head is kept.
 *
 * **The cap holds against a single line longer than the whole budget**, which is
 * ordinary provider output rather than a synthetic input: both readers flatten a
 * multi-line message onto one line so the line arithmetic here stays honest, and
 * an Azure task issue or a GitHub annotation routinely carries a whole stack
 * trace. Admitting that line whole — the shape of "always keep at least one" — is
 * how one check turns 6 000 characters into 46 000, and the per-check split makes
 * it worse rather than better, since each oversized line gets its own unbounded
 * pass. So the first line is truncated to what is left rather than admitted, from
 * the same end the kind is read from, and the cut is reported: a reader who
 * cannot tell a cut line from a whole one is the exact reader the "name what was
 * dropped" rule protects.
 */
function trimEvidence(
  evidence: CiFailureEvidence,
  budget: number,
): { text: string; dropped: number; cutMidLine: boolean } {
  const kept: string[] = [];
  let used = 0;
  let cutMidLine = false;
  // Walk from the end the failure is at, so the cut lands on the noise.
  const ordered = evidence.kind === 'log' ? [...evidence.lines].reverse() : evidence.lines;
  for (const line of ordered) {
    if (used + line.length + 1 > budget) {
      if (kept.length > 0) break;
      // Nothing kept yet and this one line already overruns: take the budget's
      // worth from the end that carries the failure — a log's own tail, an
      // error's head — rather than the whole line.
      const room = Math.max(budget - 1, 0);
      kept.push(evidence.kind === 'log' ? line.slice(line.length - room) : line.slice(0, room));
      cutMidLine = true;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const text = (evidence.kind === 'log' ? kept.reverse() : kept).join('\n');
  return { text, dropped: evidence.lines.length - kept.length, cutMidLine };
}
