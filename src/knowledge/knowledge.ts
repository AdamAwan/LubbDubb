import { claimKey } from '../claims.js';
import type { FactLifetime, FactResolution, FactScope } from '../types.js';

/**
 * The knowledge base's pure layer: what a scope is, what a proposal is allowed to
 * be, who counts as an independent corroborator, and how a question finds a claim.
 * No store and no transport, so every rule the tools rest on is testable on its
 * own — `src/remedies/remedies.ts`'s shape, for its reason.
 *
 * → `docs/spec/27-knowledge.md`
 */

/**
 * How long a claim may be. A readability bound rather than a storage one, and the
 * same bound `MAX_LESSON_CHARS` states for the same reason: every safeguard on
 * this surface rests on a person having read the row before vouching for it, and
 * a wall of text is the row nobody reads.
 */
export const MAX_CLAIM_CHARS = 2_000;

/** What the agent saw, in its own words. Longer than the claim, because it is the argument for it. */
export const MAX_EVIDENCE_CHARS = 4_000;

/** How long an expiring fact may run. A notice is a report on today, not a standing claim wearing a clock. */
const MAX_NOTICE_HOURS = 168;

/**
 * What a notice may be, said to the agent raising one.
 *
 * The rule binds harder here than anywhere else in this store because a notice is
 * the one thing that reaches every agent on corroboration alone, with no operator
 * in the loop — so the sentence that lands there is written under this and nothing
 * else checks it. An observation can be wrong about the world; an instruction is
 * wrong about what the reader should do, and the reader cannot tell.
 */
export const NOTICE_RULE =
  'State what you SAW, never what to do about it. "This check went red and then green on the same ' +
  'commit" is an observation and belongs here. "Do not chase the diff — re-run it" is an instruction ' +
  'and does not: the next agent reading it skips a check that may be genuinely broken, and it will ' +
  'have been told to by the fleet. Supply what was seen; let the agent that reads it draw the ' +
  'conclusion.';

/**
 * How the agent names a scope, and what each one costs to be wrong about — the
 * description *is* the vocabulary, as it is for a finding's kinds.
 *
 * `goal` and `check:<name>` are asymmetric on purpose. A goal scope is resolved
 * from the credential (`token -> agent -> task -> origin`) and cannot be named,
 * exactly as every other write in the tool channel is attributed; a check name is
 * a provider identifier the harness has no way to derive from the caller, so it
 * is an argument — and a fragile one, which the page says out loud.
 */
export const SCOPE_HELP: Record<'fleet' | 'goal' | 'check', string> = {
  fleet: 'fleet: true of working this repository at all. The most expensive to be wrong — use it sparingly',
  goal: "goal: true of the goal you are working, and it dies with the goal. Resolved from your own task's origin",
  check: 'check:<name>: true of one CI check, named exactly as the provider names it (e.g. "check:test (windows)")',
};

/** One proposal, validated and resolved — what the store is handed. */
export interface FactProposal {
  claim: string;
  scope: FactScope;
  lifetime: FactLifetime;
  /** Hours from now until an expiring fact lapses; null for a standing one. */
  expiresInHours: number | null;
  /** The agent's own words: what it saw that makes the claim true. Recorded as the first corroboration. */
  evidence: string;
  /** The fact this amends, when it is one. A proposal naming a barred parent is exempt from its bar. */
  supersedes: string | null;
  /**
   * What settles this notice before its clock runs out — **the harness's own to
   * write, and never an agent's**.
   *
   * A condition is a mechanism rather than a sentence: settling one means reading
   * a world object pulse after pulse, and the only party that can promise to do
   * that is the one already reading it. An agent naming a condition would be
   * naming a thing nothing watches, and the notice would then quietly be exactly
   * what it was without one — a clock — while its row claimed otherwise.
   * {@link validateFactProposal} never fills this in for that reason.
   */
  resolvesWhen: FactResolution | null;
}

/**
 * Resolve what the agent asked for into a stored scope, refusing anything else by
 * name.
 *
 * `goal` is refused outright for a caller with no goal behind it rather than
 * quietly widened to `fleet`: an agent handed a silent success believes it filed
 * a goal-local note, and what it would actually have filed is a fleet-wide claim.
 */
export function resolveFactScope(
  raw: unknown,
  goalRef: string | null,
): { ok: true; scope: FactScope } | { ok: false; error: string } {
  const asked = typeof raw === 'string' ? raw.trim() : '';
  if (asked === 'fleet') return { ok: true, scope: 'fleet' };
  if (asked === 'goal') {
    if (!goalRef) {
      return {
        ok: false,
        error:
          `scope "goal" is the goal you were dispatched for, and your task has no goal behind it. ` +
          `Say "fleet" if the claim is true of working this repository at all, or name a check.`,
      };
    }
    return { ok: true, scope: `goal:${goalRef}` };
  }
  const check = /^check:(.+)$/.exec(asked);
  if (check) {
    const name = check[1]!.trim();
    if (name) return { ok: true, scope: `check:${name}` };
  }
  return {
    ok: false,
    error: `scope must be one of ${Object.values(SCOPE_HELP).join('; ')}`,
  };
}

/**
 * Validate one proposal.
 *
 * Refused rather than trimmed, the asymmetry `validateFinding` states: a fact is
 * a claim an operator rules on and later agents read, so a malformed one must not
 * land at all — where a progress note, whose value is being cheap and frequent,
 * is trimmed and kept.
 */
export function validateFactProposal(
  raw: unknown,
  goalRef: string | null,
): { ok: true; proposal: FactProposal } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const claim = typeof args.claim === 'string' ? args.claim.trim() : '';
  if (!claim) {
    return {
      ok: false,
      error: 'claim is required: one thing that is true of this repository, in the words you would want to read it in',
    };
  }
  if (claim.length > MAX_CLAIM_CHARS) {
    return { ok: false, error: `claim must be ${MAX_CLAIM_CHARS} characters or fewer — it is a line or two` };
  }
  const scope = resolveFactScope(args.scope, goalRef);
  if (!scope.ok) return scope;

  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
  if (!evidence) {
    return {
      ok: false,
      error:
        'evidence is required: what you actually saw that makes this true. It is what an operator reads to ' +
        'decide whether the claim should reach other agents, and a claim with no observation behind it is a guess',
    };
  }
  const lifetimeRaw = typeof args.lifetime === 'string' ? args.lifetime.trim() : 'standing';
  if (lifetimeRaw !== 'standing' && lifetimeRaw !== 'expiring') {
    return { ok: false, error: 'lifetime must be "standing" (it holds until retired) or "expiring" (it has a clock)' };
  }
  const lifetime: FactLifetime = lifetimeRaw;
  const hoursRaw = args.expiresInHours;
  if (lifetime === 'standing' && hoursRaw !== undefined && hoursRaw !== null) {
    return { ok: false, error: 'expiresInHours belongs to an expiring fact; a standing one holds until it is retired' };
  }
  let expiresInHours: number | null = null;
  if (lifetime === 'expiring') {
    const hours = typeof hoursRaw === 'number' ? hoursRaw : Number.NaN;
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_NOTICE_HOURS) {
      return {
        ok: false,
        error:
          `expiresInHours is required for an expiring fact and must be between 1 and ${MAX_NOTICE_HOURS}: ` +
          `how long you expect what you saw to still be true`,
      };
    }
    expiresInHours = hours;
  }
  const supersedes = typeof args.supersedes === 'string' ? args.supersedes.trim() : '';
  return {
    ok: true,
    proposal: {
      claim,
      scope: scope.scope,
      lifetime,
      expiresInHours,
      evidence: evidence.slice(0, MAX_EVIDENCE_CHARS),
      supersedes: supersedes || null,
      resolvesWhen: null,
    },
  };
}

/**
 * Validate what `knowledge_notice` was handed.
 *
 * A notice is a proposal with the lifetime decided rather than asked for, so this
 * is {@link validateFactProposal} with `expiring` supplied — one validator, not
 * two views of what a claim may be. The tool exists as its own tool because the
 * *description* is the safeguard ({@link NOTICE_RULE}) and because a clock an
 * agent may forget to ask for is a standing fleet-wide claim filed by accident,
 * which is the one thing agreement alone must never produce.
 */
export function validateFactNotice(
  raw: unknown,
  goalRef: string | null,
): { ok: true; proposal: FactProposal } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  return validateFactProposal({ ...args, lifetime: 'expiring' }, goalRef);
}

/**
 * The **goal** one observation was made on, collapsed from the dispatch origin —
 * `pr:412:ci` and `pr:412:comments` are two origins and one goal.
 *
 * This is the whole of "different goals, not different origins": two parts of one
 * goal hitting one wall is one observation, and counting the origins would promote
 * a claim on the strength of one agent's two dispatches.
 *
 * Null for an origin naming no goal at all (an operator's job), which the count
 * treats as its own corroborator rather than as a shared one.
 */
export function corroborationGoal(originRef: string | null): string | null {
  const match = /^(issue|pr|job):([^:]+)(?::|$)/.exec(originRef ?? '');
  return match ? `${match[1]}:${match[2]}` : null;
}

/** One observation, as the count reads it. */
interface Corroborator {
  id: string;
  goalRef: string | null;
  /**
   * The session it was made in. A re-dispatch inherits the conversation through
   * `spawn`'s `resumeSessionId` (`docs/spec/10-agent-runtimes.md`), so an agent
   * agreeing with its own predecessor arrives carrying its session id — which is
   * what lets the count see one agent rather than two.
   */
  sessionId: string | null;
}

/**
 * How many independent corroborators these observations came from.
 *
 * Two rows are the same corroborator if they share a goal **or** a session, and
 * the relation is transitive — a union over both key spaces rather than a pass
 * that collapses one into the other, because an agent resumed across two goals
 * would otherwise be counted twice by whichever key was checked second. A row
 * with no goal and no session is its own corroborator.
 */
export function distinctCorroborators(rows: readonly Corroborator[]): number {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = parent.get(key) ?? key;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const keys = rows.map((r) => (r.goalRef ? `goal:${r.goalRef}` : `row:${r.id}`));
  for (const [i, row] of rows.entries()) {
    const key = keys[i]!;
    if (!parent.has(key)) parent.set(key, key);
    if (row.sessionId) union(key, `session:${row.sessionId}`);
  }
  return new Set(keys.map(find)).size;
}

/** A word worth matching on. Shorter tokens are the ones every claim shares. */
const MIN_QUESTION_TOKEN = 4;

/**
 * How well a claim answers a question: the number of distinct words they share.
 *
 * Deliberately **not** `claimsMatch`, which asks whether two agents wrote the same
 * sentence. A question is not a restatement of the claim that answers it — "why
 * does knip fail on a type I export" and "an unimported export turns check red"
 * share three words and no containment — so the matcher that guards the rejection
 * bar would answer almost every ask with nothing, which reads as "the fleet knows
 * nothing about this" rather than "the search was too strict".
 */
export function questionScore(question: string, claim: string): number {
  const wanted = new Set(
    claimKey(question)
      .split(' ')
      .filter((w) => w.length >= MIN_QUESTION_TOKEN),
  );
  if (wanted.size === 0) return 0;
  const words = new Set(claimKey(claim).split(' '));
  let score = 0;
  for (const word of wanted) if (words.has(word)) score += 1;
  return score;
}
