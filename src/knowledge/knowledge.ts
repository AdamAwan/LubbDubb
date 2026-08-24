import { claimKey } from '../claims.js';
import type { FactLifetime, FactResolution, FactScope, KnowledgeFact } from '../types.js';

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
  /** The world item the claim is about (`pr:412`), or null. Never the observer's own origin. */
  aboutRef: string | null;
  /** What locates it — file and line, package, service. Null when the agent had nothing to give. */
  where: string | null;
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
 * Whether this text is a claim at all, and the one place its bound lives.
 *
 * Its own function rather than four lines inside {@link validateFactProposal}
 * because it has three callers with three different ideas of what a refusal costs:
 * the intake turns it into a tool error the agent fixes in its own turn, the
 * operator's route turns it into a 400 they retype against, and a retrospective
 * **drops the claim and keeps the write-up** — half a write-up is a shorter
 * write-up, and half a claim is a different claim. All three need the same answer
 * to "is this a claim", and a bound written three times drifts in the direction
 * that matters: whichever writer is loosest decides what an operator ends up being
 * asked to read.
 *
 * This is `src/lessons.ts`'s `validateLessonText` with one word changed, and one
 * file fewer for the same rule.
 */
export function validateClaimText(raw: unknown): { ok: true; claim: string } | { ok: false; error: string } {
  const claim = typeof raw === 'string' ? raw.trim() : '';
  if (!claim) {
    return {
      ok: false,
      error: 'claim is required: one thing that is true of this repository, in the words you would want to read it in',
    };
  }
  if (claim.length > MAX_CLAIM_CHARS) {
    return { ok: false, error: `claim must be ${MAX_CLAIM_CHARS} characters or fewer — it is a line or two` };
  }
  return { ok: true, claim };
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
  const parsedClaim = validateClaimText(args.claim);
  if (!parsedClaim.ok) return parsedClaim;
  const claim = parsedClaim.claim;
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
  const located = validateLocators(args);
  if (!located.ok) return located;
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
      aboutRef: located.aboutRef,
      where: located.where,
    },
  };
}

/**
 * How long a locator may be. `validateFinding`'s bound, kept to the character
 * because a `where` written under one tool and read under the other is the same
 * string — two bounds for one field is a field that means something different
 * depending on which door it came through.
 */
const MAX_WHERE_CHARS = 200;

/**
 * The two fields that say *what the claim is about* and *where it was seen*.
 *
 * Shared by every writer rather than validated per tool, for the reason
 * {@link MAX_CLAIM_CHARS} is one constant: whichever writer is looser decides what
 * an operator ends up being asked to read, and a bound written twice drifts in
 * exactly that direction.
 */
function validateLocators(
  args: Record<string, unknown>,
): { ok: true; aboutRef: string | null; where: string | null } | { ok: false; error: string } {
  const where = typeof args.where === 'string' ? args.where.trim() : '';
  if (where.length > MAX_WHERE_CHARS) {
    return { ok: false, error: `where must be ${MAX_WHERE_CHARS} characters or fewer — it locates the claim` };
  }
  const rawRef = typeof args.ref === 'string' ? args.ref.trim() : '';
  if (!rawRef) return { ok: true, aboutRef: null, where: where || null };
  const ref = parseAboutRef(rawRef);
  if (!ref) {
    return {
      ok: false,
      error:
        'ref must name a world item as "issue:<n>" or "pr:<n>" — a bare number is refused because there is ' +
        'nothing here to tell issue #41 from pull request #41, and a claim about the wrong one is worse ' +
        'than a claim about neither. Omit it and say what you mean in the claim',
    };
  }
  return { ok: true, aboutRef: ref, where: where || null };
}

/**
 * The closed `issue:` / `pr:` vocabulary, suffix-tolerant so a dispatch origin
 * passes back verbatim — `parseFindingRef`'s rule and its reason.
 *
 * A bare number is refused rather than guessed at: unlike `world_read` there is no
 * second argument to disambiguate with, and an open-ended ref field is an
 * unqueryable junk drawer.
 */
function parseAboutRef(raw: string): string | null {
  const match = /^(issue|pr):(\d+)(?::[a-z]+)?$/.exec(raw.trim().toLowerCase());
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Validate what the unified intake was handed.
 *
 * `raise` is {@link validateFactProposal} with **every taxonomy question
 * removed** — one validator rather than a second opinion about what a claim may
 * be. What changes is only what the
 * caller has to have decided:
 *
 * - **Lifetime is not asked for.** `until` carries the hours, and *its presence is
 *   the answer*: a claim filed with one is expiring, a claim filed without one
 *   stands. An agent cannot file a notice by picking the wrong word, and cannot
 *   file a standing fleet-wide claim by forgetting the right one — which was the
 *   whole argument the notice tier was ever made separate, met here without
 *   a second door.
 * - **Scope defaults to `fleet` rather than being required.** This is the one
 *   default worth arguing: `goal` would be safer to be wrong about and is the
 *   wrong default anyway, because a claim scoped to a goal dies with it — so an
 *   agent that did not think about scope would have its observation buried on
 *   exactly the run that learned it. What makes `fleet` safe is the gate rather
 *   than the guess: a proposal reaches nobody, two *different* goals agreeing is
 *   itself evidence a claim is not goal-local, and an operator sees the scope on
 *   the row. A default an agent never has to think about, that an agent who has
 *   thought about it can still override, is not a taxonomy question.
 */
export function validateRaise(
  raw: unknown,
  goalRef: string | null,
): { ok: true; proposal: FactProposal } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const until = args.until;
  if (until !== undefined && until !== null && typeof until !== 'number') {
    return { ok: false, error: 'until must be a number of hours: how long you expect what you saw to still be true' };
  }
  const expiring = typeof until === 'number';
  return validateFactProposal(
    {
      ...args,
      scope: typeof args.scope === 'string' && args.scope.trim() ? args.scope : 'fleet',
      lifetime: expiring ? 'expiring' : 'standing',
      // Named `until` at the boundary and `expiresInHours` underneath, because the
      // agent-facing name has to say what the number *is* in the one word an agent
      // reads, while the stored name has to say what the number is measured in.
      expiresInHours: expiring ? until : undefined,
      supersedes: args.supersedes,
    },
    goalRef,
  );
}

/**
 * The intake's other arm: the same call, read as a contradiction because it named
 * a claim it disputes.
 *
 * `contradicts` is routed here rather than folded into `supersedes` because the
 * two are not the same act and the store already knows it. A bare `supersedes`
 * files a sharper claim beside a blunter one and records no disagreement; a
 * contradiction says *the claim you gave me does not fit what I am looking at*,
 * and that dispute is what an operator reads to decide whether the original was
 * ever right. Folding them would file every amendment as an undisputed refinement
 * and leave the contradiction ratio reading zero on a claim the fleet keeps
 * walking into — a silence, and the expensive kind.
 *
 * So the agent's field is one word (`contradicts: <id>`) and the routing is the
 * harness's. The claim it is raising **is** the amendment: an agent that has seen
 * a claim fail has, in the same breath, said what it should say instead.
 */
export function validateRaisedContradiction(
  raw: unknown,
): { ok: true; contradiction: FactContradiction } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  return validateContradiction({ ...args, factId: args.contradicts, amendment: args.claim });
}

/**
 * What a contradiction is for, said to the agent raising one.
 *
 * The amendment is the whole of it. A bare "this claim is wrong" is a count, and
 * nothing in this store is demoted by count — a claim that is right in general and
 * wrong at one edge attracts contradictions **because it is being used**, which
 * makes the most valuable claims in the store the ones a count would kill first.
 * So the tool asks for the sentence that would have been right, and what the fleet
 * gets out of the disagreement is a sharper claim rather than one fewer claim.
 */
const CONTRADICTION_RULE =
  'Say what the claim should say INSTEAD. A contradiction with no amendment is refused: nothing here is ' +
  'demoted by count, so "this is wrong" on its own changes nothing and reaches nobody. A claim that is ' +
  'right in general and wrong at one edge is exactly the claim worth sharpening — write the version that ' +
  'covers what you just saw, and keep whatever of it still holds.';

/** One contradiction, validated — what the store is handed beside the amendment it demands. */
export interface FactContradiction {
  /** The claim being disputed. */
  factId: string;
  /** What it should say instead. Filed as a proposal of its own, naming the original in `supersedes`. */
  amendment: string;
  /** What the agent saw that the claim does not fit. Recorded as the contradiction's own words. */
  evidence: string;
}

/**
 * Validate a contradiction — what `raise` builds when the agent names `contradicts`.
 *
 * The amendment is refused **by name and with the reason** rather than defaulted
 * or dropped: an agent told nothing files the same bare objection again, and an
 * agent whose objection was silently recorded without one believes it has taken a
 * claim off the fleet when it has changed nothing at all.
 */
export function validateContradiction(
  raw: unknown,
): { ok: true; contradiction: FactContradiction } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const factId = typeof args.factId === 'string' ? args.factId.trim() : '';
  if (!factId) {
    return {
      ok: false,
      error:
        'factId is required: the id of the claim you are disputing, as it was given to you — every claim ' +
        'in your prompt and every answer from knowledge_ask carries one',
    };
  }
  const amendment = typeof args.amendment === 'string' ? args.amendment.trim() : '';
  if (!amendment) return { ok: false, error: `amendment is required. ${CONTRADICTION_RULE}` };
  if (amendment.length > MAX_CLAIM_CHARS) {
    return {
      ok: false,
      error: `amendment must be ${MAX_CLAIM_CHARS} characters or fewer — it is a claim, a line or two`,
    };
  }
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
  if (!evidence) {
    return {
      ok: false,
      error:
        'evidence is required: what you actually saw that the claim does not fit — the file, the command, ' +
        'the output. It is what an operator reads to decide between the claim and your amendment',
    };
  }
  return { ok: true, contradiction: { factId, amendment, evidence: evidence.slice(0, MAX_EVIDENCE_CHARS) } };
}

/**
 * Whether this claim is one an agent may contradict, and why not when it is not.
 *
 * **You may contradict what you could have been shown**, which is `askFacts`'
 * answer and not a second opinion about it: `lookup` and `injected`, and not
 * lapsed. The spec says "an injected fact", but a `lookup` fact reaches agents
 * through the task prompt of every dispatch its scope matches and through
 * `knowledge_ask`, and it is contradicted by the same reading of the same code —
 * refusing there would leave the fleet's one way of saying "this is stale" working
 * for some of the claims it was told and not others, with no way for the agent to
 * tell which.
 *
 * A `proposal` reaches nobody, so nothing could have been shown one. A `graduated`
 * claim has left this store for somewhere that carries it better, so what an agent
 * holding a sharper version of one has is a claim in its own right rather than a
 * correction to something it was told — the refusal says so and asks for it in the
 * agent's own words, because pointing at the pull request or the ticket that took
 * it would be pointing at something nobody can file a dispute against. And a
 * `rejected` claim has already been answered: it reaches nobody, an operator has
 * said it is not true, and the sharper version an agent has in hand is a claim in
 * its own right — a `raise` naming it with `contradicts`, which is the one thing
 * that lifts a bar.
 */
export function contradictableFact(fact: KnowledgeFact, now: string): { ok: true } | { ok: false; error: string } {
  if (fact.reach === 'rejected') {
    return {
      ok: false,
      error:
        `an operator has already rejected that claim (${fact.id}), so it reaches no agent and there is ` +
        `nothing to correct. If your sharper version is worth filing in its own right, raise it with ` +
        `contradicts: "${fact.id}" — an amendment is the one thing exempt from a bar.`,
    };
  }
  if (fact.reach === 'proposal') {
    return {
      ok: false,
      error:
        `that claim is still a proposal (${fact.id}): one agent said it and nothing has agreed, so it ` +
        `rides no prompt and is answered to nobody. There is nothing to take off the fleet. Raise what you ` +
        `saw as a claim of its own instead — leave contradicts out.`,
    };
  }
  if (fact.reach === 'retired') {
    return {
      ok: false,
      error:
        `an operator has retired that claim (${fact.id}), so it is out of every prompt and nothing is being ` +
        `told it. Retired is not rejected — it was not judged untrue, it just stopped being carried — so if ` +
        `what you saw is worth the next agent knowing, raise it in your own words. That files a fresh claim ` +
        `with your evidence and today's date, which is what a claim coming back should look like.`,
    };
  }
  if (fact.reach === 'graduated' || fact.reach === 'superseded') {
    return {
      ok: false,
      error:
        `that claim is out of every prompt already (${fact.id}, ${fact.reach}). A graduated claim left this ` +
        `store for somewhere that carries it better — this repository's own documentation, a job, a ticket — ` +
        `so what you have in hand is a claim in its own right rather than a correction to one you were told. ` +
        `Raise it in your own words. A superseded claim has already been replaced. Contradict the claim you ` +
        `were actually shown.`,
    };
  }
  if (fact.expiresAt !== null && fact.expiresAt <= now) {
    return {
      ok: false,
      error:
        `that notice lapsed at ${fact.expiresAt} and is already out of every read — nothing is being told ` +
        `it. A notice ends by itself, which is what makes it a notice.`,
    };
  }
  return { ok: true };
}

/**
 * The proposal an amendment is filed as: the agent's sentence, on the original's
 * own axes.
 *
 * **The axes are the original's and never arguments.** Matching is inside a scope,
 * so an amendment filed in another scope would not be an amendment of anything —
 * and a contradiction of one check's claim that could name `fleet` would be a
 * fleet-wide claim filed off the back of a note about one job. The lifetime is the
 * original's for the same reason, and an expiring claim's amendment inherits what
 * is *left* of its clock: a correction to what is true today is true for as long
 * as the thing it corrects is, and a fresh week would outlive the notice it
 * sharpens.
 */
export function amendmentProposal(fact: KnowledgeFact, contradiction: FactContradiction, now: string): FactProposal {
  const remaining =
    fact.lifetime === 'expiring' && fact.expiresAt !== null
      ? Math.max(1, Math.ceil((new Date(fact.expiresAt).getTime() - new Date(now).getTime()) / 3_600_000))
      : null;
  return {
    claim: contradiction.amendment,
    scope: fact.scope,
    lifetime: fact.lifetime,
    expiresInHours: remaining,
    evidence: contradiction.evidence,
    supersedes: fact.id,
    // An agent never writes a condition, amendment or not: a condition is a
    // mechanism the harness has to keep watching, and nothing watches this one.
    resolvesWhen: null,
    // Inherited rather than taken from the contradicting agent, for the reason the
    // scope and the lifetime are: an amendment is a sharper wording of the same
    // claim about the same thing, so it is about whatever its parent was about. The
    // contradicting agent's own observation is not lost — it is the contradiction's
    // `words`, which is where an operator reads it.
    aboutRef: fact.aboutRef,
    where: fact.where,
  };
}

/**
 * How much of what has been said about a claim disputes it.
 *
 * **Distinct voices on both sides, over the whole life of the claim, and no
 * window.** The count beside it — the one that carries a proposal to `lookup` — is
 * taken over every corroboration a fact ever had, so a ratio taken over a window
 * would be a second number drawn from the same rows under a different rule, free
 * to disagree with the one that governs while looking like the same arithmetic. A
 * claim nobody hit the edge of this week is not a claim nobody has contradicted.
 *
 * It is a **reading and never a trigger**: nothing in this store is demoted,
 * lapsed or deleted by it, and the ratio's whole job is to put the claims worth an
 * operator's attention in front of them.
 */
export function contradictionRatio(corroborators: number, contradictors: number): number {
  const total = corroborators + contradictors;
  return total === 0 ? 0 : contradictors / total;
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
  /**
   * The pool fleet whose document carried this voice, or null for a local agent's.
   *
   * **One fleet is one voice**, however many entries it publishes and however many
   * times it is polled. A pooled row has neither a goal nor a session, so the origin
   * fleet folds into the union below rather than becoming a second count beside it —
   * which is what keeps a fleet that publishes five entries matching one local claim
   * from carrying it five voices further.
   * → `docs/spec/28-cross-fleet-pool.md#what-arriving-means`
   */
  fleetId?: string | null;
}

/**
 * How many independent corroborators these observations came from.
 *
 * Two rows are the same corroborator if they share a goal, a session **or** a pool
 * fleet, and the relation is transitive — a union over the key spaces rather than a
 * pass that collapses one into another, because an agent resumed across two goals
 * would otherwise be counted twice by whichever key was checked second. A row
 * with no goal, no session and no fleet is its own corroborator.
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
    if (row.fleetId) union(key, `fleet:${row.fleetId}`);
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
