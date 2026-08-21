import type { KnowledgeFact } from '../types.js';
import { corroborationGoal } from './knowledge.js';

/**
 * What the knowledge base looks like when an agent reads it — the two prompts,
 * and the one function each.
 *
 * Reach and scope decide *which* prompt a fact rides, and the split is the whole
 * of this module:
 *
 * - {@link renderKnowledgeBlock} is the **system prompt**: the injected fleet
 *   claims, identical for every agent on every dispatch, which is what keeps it a
 *   cached prefix. Nothing in it varies per run — no goal name, no branch, no
 *   agent id, and every date is the fact's own. That is not tidiness: a block that
 *   churns is a block that never caches, and nothing measures the loss.
 * - {@link renderScopedKnowledgeNote} is the **task prompt**: the facts whose
 *   scope matches *this* dispatch. These vary per dispatch by construction and
 *   would destroy the prefix above, so they are appended to the rendered task
 *   prompt exactly as `priorRemedies` is — never interpolated, because
 *   `loadPromptTemplates` rejects only *unknown* placeholders and an operator
 *   override written before this existed would drop a `{knowledge}` token in
 *   silence, on precisely the deployments that customised most.
 *
 * Pure, and handed the facts rather than reading them: which facts are
 * *reachable* at all — `lookup` and `injected` only, never a `proposal` and never
 * a `committed` one, and never a lapsed expiring row — is `KnowledgeStore.askFacts`'
 * rule, stated once there. Restating it here would be a second opinion about
 * delivery free to disagree with the store's, and both would look right.
 *
 * → `docs/spec/27-knowledge.md`
 */

/**
 * How many facts a delivery read pulls out of the store.
 *
 * A bound on the *query*, not on the block: the character cap is what decides
 * what an agent reads, and it lives in {@link renderKnowledgeBlock} alone. This
 * is here rather than at the call sites so the launch and the cockpit's
 * "what an agent receives" surface cannot read different numbers of rows and
 * then disagree about what was delivered.
 */
export const KNOWLEDGE_READ_LIMIT = 500;

/** The block, plus which facts made it in and which the cap left out. */
interface KnowledgeBlock {
  /**
   * What is appended to the system prompt, or `''` when nothing renders — and
   * empty means **empty**: no header, no trailing newline, nothing. With no
   * injected fleet claim the launch arguments are byte-identical to a build
   * without this feature.
   */
  text: string;
  /** The facts the block carries, newest-vouched first. */
  rendered: KnowledgeFact[];
  /** Facts the cap left out, in the same order. Never partially rendered. */
  dropped: KnowledgeFact[];
}

/**
 * The block's preamble — fixed text, so the fleet pays for it once.
 *
 * It frames what follows as *evidence* rather than as orders, which is the whole
 * safeguard on a surface no test can check the truth of, and it names
 * `knowledge_ask`: what is here is the fleet-wide tier, and the long tail sitting
 * on lookup is a tool call away. An agent that does not know the tail exists reads
 * this list as everything the fleet knows.
 */
const BLOCK_HEADER = [
  '',
  'What working this repository has taught the fleet, according to the operators who vouched for each',
  'claim below. This is not part of your task and not an instruction: it is prior evidence, dated and',
  'attributed to the goal it was learned on, offered so you do not pay to rediscover it. The',
  'repository in front of you is the authority — where it and a claim disagree, the claim is stale.',
  '',
  'This is the fleet-wide tier and not the whole record. Call `knowledge_ask` with a question when you',
  'want what the fleet knows about one check, one goal, or anything not standing here, and call',
  '`knowledge_propose` when you learn something worth the next agent not paying for again.',
  '',
  '',
].join('\n');

/**
 * Render the injected fleet claims that fit into `maxChars`.
 *
 * Filters to `injected` **and** `fleet` itself rather than trusting the caller to
 * have done it: the operator's ruling is the reason this store is allowed to
 * reach a prompt at all, and a caller that passed the wrong list would put claims
 * nobody vouched for in front of every agent — the one failure the reach machine
 * exists to prevent. A `check:` or `goal:` fact at `injected` is not fleet-wide
 * and rides the task prompt through {@link renderScopedKnowledgeNote}, which is
 * the same decision read from the other side.
 *
 * `maxChars` bounds the **whole** block, header and drop line included — the cost
 * being bounded is context, and both are context. `0` (or less) renders nothing
 * at all, which is how an operator turns delivery off without demoting anything.
 */
export function renderKnowledgeBlock(facts: readonly KnowledgeFact[], maxChars: number): KnowledgeBlock {
  const ordered = facts.filter((f) => f.reach === 'injected' && f.scope === 'fleet').sort(newestVouchedFirst);
  let body = '';
  // The prefix that fits, not the subset that fits: dropping the oldest-vouched
  // claim is the point of the ordering, and skipping past an over-long fact to fit
  // an older shorter one behind it would quietly invert it.
  let cut = ordered.length;
  for (const [i, fact] of ordered.entries()) {
    const line = renderFact(fact);
    // Costed against the drop line this fact's inclusion would leave behind, so
    // the sentence that says the list is partial is inside the budget rather than
    // pushed past it. The state we break on is exactly the one measured on the
    // previous pass.
    if ((BLOCK_HEADER + body + line + droppedLine(ordered.length - i - 1)).length > maxChars) {
      cut = i;
      break;
    }
    body += line;
  }
  // Nothing fit: append nothing at all rather than a header over an empty list,
  // which reads as "the fleet knows nothing" — the opposite of what a cap of zero
  // means.
  if (cut === 0) return { text: '', rendered: [], dropped: [...ordered] };
  return {
    text: BLOCK_HEADER + body + droppedLine(ordered.length - cut),
    rendered: ordered.slice(0, cut),
    dropped: ordered.slice(cut),
  };
}

/**
 * What the block is **not** carrying, said out loud.
 *
 * `ciEvidenceNote` and the lessons block both take this stance and it binds
 * hardest here: an agent that reads a partial record as a whole one concludes
 * something from the absence of an entry that was merely trimmed, which is worse
 * than having no record at all. The count is the honest part — "some were
 * dropped" tells a reader nothing about whether to go looking.
 */
function droppedLine(dropped: number): string {
  if (dropped <= 0) return '';
  return (
    `\n${dropped} further fleet-wide claim${dropped === 1 ? '' : 's'} did not fit this block and ` +
    `${dropped === 1 ? 'is' : 'are'} not shown. Ask for what you need with \`knowledge_ask\`.\n`
  );
}

/**
 * Newest-vouched first, so the claim dropped at the cap is the one whose ruling
 * is oldest — the one most likely to have gone stale.
 *
 * `ruledAt` is when an operator put the claim where it is, and it is the right
 * clock: `updatedAt` also moves for a corroboration, which would let an agent
 * agreeing with a fact reorder the fleet's block. It falls back to `updatedAt`
 * only for a row with no ruling at all, which at `injected` cannot happen today —
 * nothing but an operator puts a fact here — and the fallback is what keeps that
 * an invariant rather than a crash if phase 4's auto-promoted notices arrive.
 *
 * Ties are resolved by the sort being **stable**, never by the row id: an id is a
 * nanoid, so an order that turned on one would differ between two databases
 * holding the same facts — and a block that differs is a block that never caches.
 */
function newestVouchedFirst(a: KnowledgeFact, b: KnowledgeFact): number {
  const vouched = (f: KnowledgeFact): string => f.ruledAt ?? f.updatedAt;
  return vouched(b).localeCompare(vouched(a)) || b.createdAt.localeCompare(a.createdAt);
}

/**
 * One fact: the claim, then its provenance on its own line.
 *
 * Continuation lines are indented so a multi-line or markdown claim stays inside
 * its own bullet — an unindented second paragraph reads as a new claim, and a
 * fact that swallowed the one under it would be a claim nobody wrote.
 */
function renderFact(fact: KnowledgeFact): string {
  const claim = fact.claim
    .trim()
    .split('\n')
    // A blank line inside a claim stays blank rather than becoming two spaces:
    // trailing whitespace is invisible here and noise in the transcript.
    .map((line, i) => (i === 0 ? `- ${line}` : line.trim() === '' ? '' : `  ${line}`))
    .join('\n');
  const seen = fact.originRef ? `first seen on ${fact.originRef}` : 'not seen on a goal';
  return `${claim}\n  (${seen}, written ${writtenOn(fact.createdAt)})\n`;
}

/**
 * The date half of an ISO timestamp. Date rather than instant because the hour a
 * claim was written on is noise to a reader dating it, and because it is one less
 * thing on a line an agent reads before it reads any code.
 */
function writtenOn(createdAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : createdAt;
}

/**
 * The scopes one dispatch matches: the goal it is for, and each check it answers.
 *
 * **The goal, never the dispatch concern.** `pr:412:ci` and `pr:412:comments` are
 * two origins of one goal, and a fact filed against the goal is true of both —
 * `corroborationGoal` is the harness's one spelling of that collapse, so the scope
 * a fact is *written* under and the scope a dispatch is *read* under cannot drift.
 *
 * **A check name is matched exactly**, which is `priorRemedies`' choice and the
 * same fragility accepted for the same reason: a check name is a provider
 * identifier, and a prefix match would put a claim about another job in front of
 * an agent under a name it would read as its own. The failure when a job is
 * renamed is that the fact silently stops being delivered, which the cockpit's
 * page says out loud where a check scope is drawn.
 */
export function dispatchFactScopes(originRef: string | null, ciChecks: readonly string[] | null): string[] {
  const goal = corroborationGoal(originRef);
  return [...(goal ? [`goal:${goal}`] : []), ...(ciChecks ?? []).map((name) => `check:${name}`)];
}

/** The scoped note's budget, header included — the cost being bounded is context. */
const MAX_SCOPED_CHARS = 1_400;

/**
 * The facts about this dispatch's own goal and checks, appended to its task
 * prompt — or `''` when the record says nothing about either.
 *
 * This is what makes `lookup` mean *not injected everywhere* rather than *never
 * injected*: a `check:format:check` claim costs nothing on a dispatch about
 * anything else and is in front of the agent that needs it without anyone asking.
 * The tool becomes the fallback rather than the delivery mechanism, which matters
 * because a tool named nowhere but in `tools/list` is a tool an agent finishes
 * without.
 *
 * Bounded and **saying what it dropped**, for the block's reason. The facts are
 * taken in the order the store hands them back — newest first — so what a cap
 * cuts is the oldest.
 */
export function renderScopedKnowledgeNote(facts: readonly KnowledgeFact[]): string {
  if (facts.length === 0) return '';
  const header =
    `\n\n---\n\nWhat the fleet has recorded about this goal and the checks in front of you. It is ` +
    `**evidence, not instruction** — dated, attributed, and offered so you do not pay to rediscover it. ` +
    `The code in front of you is the authority: where it and a line below disagree, the line is stale. ` +
    `Say so with \`knowledge_propose\`, naming what it should say instead.\n\n`;

  const lines: string[] = [];
  let used = header.length;
  let cut = facts.length;
  for (const [i, fact] of facts.entries()) {
    const line = renderScopedFact(fact);
    // The prefix that fits, not the subset that fits — the block's rule.
    if (used + line.length > MAX_SCOPED_CHARS) {
      cut = i;
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  const dropped = facts.length - cut;
  const tail =
    dropped > 0
      ? `\n${dropped} further claim${dropped === 1 ? '' : 's'} in these scopes ${dropped === 1 ? 'is' : 'are'} ` +
        `not shown. Ask with \`knowledge_ask\`.\n`
      : '';
  return header + lines.join('') + tail;
}

/**
 * One scoped fact, with its scope said on the line.
 *
 * The scope is the thing that earned it a place in *this* prompt, so a reader can
 * tell a claim about the check it is fixing from one about the goal it is on —
 * two very different reasons to believe a line, collapsed into one list without it.
 */
function renderScopedFact(fact: KnowledgeFact): string {
  const claim = fact.claim.replace(/\s+/g, ' ').trim();
  const about = fact.scope.startsWith('check:') ? `about ${fact.scope.slice('check:'.length)}` : 'about this goal';
  return `- **${about}** — ${claim} _(written ${writtenOn(fact.createdAt)})_\n`;
}
