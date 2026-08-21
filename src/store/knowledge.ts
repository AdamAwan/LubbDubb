import { nanoid } from 'nanoid';
import { claimKey, claimsMatch } from '../claims.js';
import { corroborationGoal, distinctCorroborators, questionScore, type FactProposal } from '../knowledge/knowledge.js';
import type { FactObservation, FactReach, KnowledgeCorroboration, KnowledgeFact, Lesson } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `ruled_at` arrived with the cockpit page (phase 2): the table shipped in phase
 * 1, so it is an `ALTER TABLE` rather than a line in the `CREATE`, and every
 * database from that build needs it added.
 *
 * **Null is the right value on every row it is added to, so there is no backfill.**
 * Null spells *no operator has ruled on this*, and phase 1 shipped no operator
 * surface at all — every fact on an older database reached where it is by being
 * proposed or corroborated, which is exactly what null says.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const KNOWLEDGE_COLUMNS: ColumnMigrations = {
  knowledge_facts: { ruled_at: 'TEXT' },
};

/**
 * The `knowledge_facts` and `knowledge_corroborations` tables: what the fleet
 * knows about working this repository, and who says so.
 *
 * The tables were new in phase 1 and have gained one column since, which is what
 * {@link KNOWLEDGE_COLUMNS} above is: being new *once* does not keep a table
 * exempt, and `CREATE TABLE IF NOT EXISTS` never alters an existing one.
 *
 * **Nothing in the dispatcher reads any of this.** No rule, desk or gate consults
 * a fact: nothing is dispatched, held or ranked because of one. A fact feeds
 * prompts and a panel, which is `RemedyStore`'s stance and survives here unchanged.
 *
 * The two rules worth reading this file for are both about what *cannot* happen:
 * a claim an operator rejected cannot come back (except as an amendment that names
 * it), and nothing auto-promotes past `lookup` — which is as far as two agents
 * agreeing can carry anything.
 *
 * → `docs/spec/27-knowledge.md`
 */
export class KnowledgeStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a claim, or record that somebody else saw the same thing.
   *
   * One entry point for both because they are one act from the agent's side: an
   * agent writes down what it learned, and whether that is the first time anybody
   * has is not something it can know. The same call therefore lands a proposal, or
   * joins the standing fact for that claim as a corroboration — {@link claimsMatch}
   * decides which, so this store and `findings` agree about what one claim is
   * rather than growing a second matcher free to disagree.
   *
   * **Matching is inside a scope.** The same sentence about one check and about
   * the fleet are two claims: they carry different costs to be wrong and are
   * delivered to different agents, so folding them would let a note about one job
   * be corroborated into a fleet-wide instruction.
   *
   * Three outcomes, and the third is the one with teeth: a claim an operator has
   * **rejected** is refused rather than re-filed, and refused *by name* — the
   * agent is told what was rejected and how to amend it, because a silent refusal
   * teaches the fleet nothing and it will file the claim again tomorrow.
   */
  proposeFact(proposal: FactProposal, observer: FactObservation): FactProposalOutcome {
    const key = claimKey(proposal.claim);
    const barredBy = this.matchingFacts(proposal.scope, key, ['rejected']).find((f) => f.id !== proposal.supersedes);
    if (barredBy) return { outcome: 'barred', barredBy };
    // An amendment always lands as its own row. It usually *contains* the claim it
    // sharpens — that is what amending is — so folding it into its parent as a
    // corroboration would silently discard the correction and leave the blunter
    // claim standing with one more voice behind it.
    const existing = proposal.supersedes ? null : (this.matchingFacts(proposal.scope, key, LIVE_REACHES)[0] ?? null);
    // The standing claim's own axes win: an agent agreeing with a fact does not get
    // to restate its scope or put a clock on it, which would let a re-proposal
    // quietly convert a standing claim into an expiring one and back.
    const fact = existing ?? this.insertFact(proposal, observer);
    this.recordCorroboration(fact.id, observer);
    const corroborations = distinctCorroborators(this.listCorroborations(fact.id));
    return {
      outcome: existing ? 'corroborated' : 'filed',
      fact: this.promoteOnCorroboration(fact, corroborations),
      corroborations,
    };
  }

  getFact(id: string): KnowledgeFact | null {
    const row = this.ctx.db.prepare(`SELECT * FROM knowledge_facts WHERE id=?`).get(id) as FactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * Every fact, newest first — including the rejected ones, for the reason
   * `listLessons` keeps its retired rows: a governance surface that draws only
   * what it let through cannot show what it stopped.
   */
  listFacts(limit = 200): KnowledgeFact[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_facts ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as FactRow[];
    return rows.map(rowToFact);
  }

  /** One fact's observations, oldest first — the order they were made in. */
  listCorroborations(factId: string): KnowledgeCorroboration[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_corroborations WHERE fact_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(factId) as CorroborationRow[];
    return rows.map(rowToCorroboration);
  }

  /**
   * What an agent asking gets back: the facts that have reached at least `lookup`,
   * in the scopes it can see, that have not lapsed.
   *
   * A `proposal` is deliberately unreachable here — it is one agent's claim and
   * nothing has agreed with it, so answering an ask with one would be the
   * auto-promotion the whole design is built to prevent, arriving by the back
   * door. `committed` is unreachable for the opposite reason: the fact is in the
   * repository now, and reading it out of a tool would pay context twice for one
   * sentence.
   */
  askFacts(query: FactQuery): KnowledgeFact[] {
    const now = this.ctx.now();
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_facts WHERE reach IN ('lookup','injected') ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as FactRow[];
    const scopes = query.scopes ? new Set<string>(query.scopes) : null;
    const visible = rows
      .map(rowToFact)
      .filter((f) => !scopes || scopes.has(f.scope))
      .filter((f) => !f.expiresAt || f.expiresAt > now);
    const question = query.question?.trim();
    const limit = query.limit ?? 20;
    if (!question) return visible.slice(0, limit);
    return (
      visible
        .map((fact) => ({ fact, score: questionScore(question, fact.claim) }))
        .filter((row) => row.score > 0)
        // Best answer first, and — because `sort` is stable — newest first within a
        // score, which is the order `visible` already carries.
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((row) => row.fact)
    );
  }

  /**
   * Where a claim stands, on an operator's say-so — and the record that they said
   * so, which is the second half of this call rather than a detail of it.
   *
   * **Naming the reach a fact is already at is a ruling, not a no-op.** "True, but
   * not worth every agent's context" is `lookup`, and it is the same reach two
   * agents agreeing carries a claim to — so an operator who has read a corroborated
   * claim and decided it belongs exactly where it is has to have a way to say that,
   * or the cockpit's **Needs you** section asks them again forever and the only way
   * to silence it is the wrong decision. That is why the guard below is on
   * `rejected` alone.
   *
   * `rejected` is terminal in both directions. Nothing un-rejects a claim, because
   * the bar is what stops two agents re-proposing next week what an operator
   * killed today — an un-reject would be a way to lift that bar without reading
   * the amendment that should have lifted it. Null means exactly that and nothing
   * else.
   */
  setFactReach(id: string, reach: FactReach): KnowledgeFact | null {
    return this.moveReach(id, reach, this.ctx.now());
  }

  /**
   * How many independent corroborators every fact has, in one read.
   *
   * The count the page draws, and it is {@link distinctCorroborators}' — never
   * `rows.length`. A second count in the view layer is free to disagree with the
   * one that promotes, and the disagreement would be invisible: both numbers look
   * like counts of the same rows.
   *
   * Batched rather than a `listCorroborations` per fact because the snapshot is
   * polled: one query grouped in memory, rather than a query per row per poll per
   * connected cockpit.
   */
  corroborationCounts(): Map<string, number> {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_corroborations ORDER BY created_at ASC, rowid ASC`)
      .all() as CorroborationRow[];
    const byFact = new Map<string, KnowledgeCorroboration[]>();
    for (const row of rows) {
      const list = byFact.get(row.fact_id) ?? [];
      list.push(rowToCorroboration(row));
      byFact.set(row.fact_id, list);
    }
    return new Map([...byFact].map(([factId, list]) => [factId, distinctCorroborators(list)]));
  }

  /**
   * The guarded write both arms of the state machine go through, and the one
   * place `ruled_at` is written.
   *
   * The stamp is what tells the page's **Needs you** section from its **On
   * lookup** one: a fact two agents carried to `lookup` is waiting on the one
   * decision that is an operator's, and a fact an operator *left* at `lookup` —
   * true, but not worth every agent's context — has already had it. Both are the
   * same reach, and without the stamp the page would nag forever about a call
   * that was already made.
   */
  private moveReach(id: string, reach: FactReach, ruledAt: string | null): KnowledgeFact | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE knowledge_facts SET reach=?, updated_at=?, ruled_at=COALESCE(?, ruled_at)
           WHERE id=? AND reach<>'rejected'`,
      )
      .run(reach, updatedAt, ruledAt, id);
    if (result.changes === 0) return null;
    return this.getFact(id);
  }

  /**
   * Mirror the fleet's promoted lessons into this store, and unmirror the ones an
   * operator has since retired.
   *
   * A promoted lesson **is** a fleet-scoped standing fact an operator has vouched
   * for, reaching every agent's system prompt — which is `injected`, exactly. So
   * the migration is the identity, not a translation.
   *
   * Run on **every** boot rather than once, and idempotent because the fact's id
   * is derived from the lesson's. Once is not enough: lessons keep their own
   * surface until delivery moves (phase 3), so a lesson promoted between the two
   * phases would be a claim that silently stopped reaching agents on the boot the
   * operator took that build. The unmirror is the same argument backwards — a
   * lesson retired after it was adopted would otherwise be pruned from one surface
   * and injected from the other.
   *
   * An adopted row is only ever removed while it is still **untouched**: nobody
   * has corroborated it, nothing amends it, and no operator has moved it. Past
   * that it is a fact in its own right with its own record, and the lessons panel
   * is not where it is governed.
   *
   * The lessons are passed in rather than read: `src/store/lessons.ts` owns that
   * table, and a store module that reached a sibling's tables is the cross-domain
   * read `test/storeModules.test.ts` exists to refuse. The composition root holds
   * both, so it does the joining.
   */
  adoptLessons(lessons: readonly Lesson[]): void {
    for (const lesson of lessons) {
      if (lesson.status === 'promoted') this.adoptLesson(lesson);
      else if (lesson.status === 'retired') this.releaseLesson(lesson);
    }
  }

  private adoptLesson(lesson: Lesson): void {
    const id = adoptedFactId(lesson.id);
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_facts
           (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, created_at, updated_at)
         VALUES (?, ?, 'fleet', 'standing', NULL, 'injected', NULL, ?, ?, ?, ?)`,
      )
      // Ruled, and by the operator who promoted the lesson: the mirror is the
      // identity, so the moment they vouched for it is the moment it was ruled on.
      .run(id, lesson.text, lesson.originRef, lesson.updatedAt, lesson.createdAt, lesson.updatedAt);
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_corroborations
           (id, fact_id, agent_id, task_id, goal_ref, session_id, words, created_at)
         VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        `knc_${lesson.id}`,
        id,
        corroborationGoal(lesson.originRef),
        'An operator vouched for this as a lesson, before the knowledge base held it.',
        lesson.updatedAt,
      );
  }

  private releaseLesson(lesson: Lesson): void {
    const id = adoptedFactId(lesson.id);
    const fact = this.getFact(id);
    if (!fact || fact.reach !== 'injected') return;
    if (this.listCorroborations(id).length > 1) return;
    const amended = this.ctx.db.prepare(`SELECT id FROM knowledge_facts WHERE supersedes=?`).get(id);
    if (amended) return;
    this.ctx.db.prepare(`DELETE FROM knowledge_corroborations WHERE fact_id=?`).run(id);
    this.ctx.db.prepare(`DELETE FROM knowledge_facts WHERE id=?`).run(id);
  }

  /**
   * The facts in one scope whose claim is this claim, oldest first — so a
   * restatement joins the row an operator has been looking at rather than the
   * newest near-copy of it.
   *
   * Narrowed in SQL to the scope and the reaches asked for; the claim comparison
   * is in TypeScript because it is normalisation, not a predicate SQL can index.
   * `FindingStore.findStandingClaim`'s shape, and the list is short for its reason.
   */
  private matchingFacts(scope: string, key: string, reaches: readonly FactReach[]): KnowledgeFact[] {
    const holes = reaches.map(() => '?').join(',');
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_facts WHERE scope=? AND reach IN (${holes}) ORDER BY created_at ASC, rowid ASC`)
      .all(scope, ...reaches) as FactRow[];
    return rows.map(rowToFact).filter((f) => claimsMatch(key, claimKey(f.claim)));
  }

  private insertFact(proposal: FactProposal, observer: FactObservation): KnowledgeFact {
    const ts = this.ctx.now();
    const fact: KnowledgeFact = {
      id: `fact_${nanoid(10)}`,
      claim: proposal.claim,
      scope: proposal.scope,
      lifetime: proposal.lifetime,
      expiresAt: proposal.expiresInHours === null ? null : lapsesAt(ts, proposal.expiresInHours),
      reach: 'proposal',
      supersedes: proposal.supersedes,
      originRef: observer.goalRef,
      ruledAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_facts
           (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, created_at, updated_at)
         VALUES (@id, @claim, @scope, @lifetime, @expiresAt, @reach, @supersedes, @originRef, @ruledAt,
                 @createdAt, @updatedAt)`,
      )
      .run(fact);
    return fact;
  }

  private recordCorroboration(factId: string, observer: FactObservation): void {
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_corroborations
           (id, fact_id, agent_id, task_id, goal_ref, session_id, words, created_at)
         VALUES (@id, @factId, @agentId, @taskId, @goalRef, @sessionId, @words, @createdAt)`,
      )
      .run({ id: `knc_${nanoid(10)}`, factId, ...observer, createdAt: this.ctx.now() });
  }

  /**
   * Two corroborations from two different goals carry a proposal to `lookup`, and
   * **no further**.
   *
   * That ceiling is the safety argument of the whole design rather than a
   * conservative default: `lookup` costs nothing until somebody asks or the scope
   * matches, while `injected` is in front of every agent before it reads any code,
   * where a stale line is a false instruction that fails silently. Two agents
   * agreeing is not evidence enough for that, and they are not necessarily
   * independent — the second may have read the first.
   */
  private promoteOnCorroboration(fact: KnowledgeFact, corroborations: number): KnowledgeFact {
    if (fact.reach !== 'proposal' || corroborations < CORROBORATIONS_TO_LOOKUP) return fact;
    // No stamp: two agents agreeing is not an operator ruling, and the page's
    // **Needs you** section is exactly the facts that arrived here this way.
    return this.moveReach(fact.id, 'lookup', null) ?? fact;
  }
}

/** What a proposal did. `barred` carries the rejected claim that refused it, so the agent can amend it. */
export type FactProposalOutcome =
  | { outcome: 'filed' | 'corroborated'; fact: KnowledgeFact; corroborations: number }
  | { outcome: 'barred'; barredBy: KnowledgeFact };

/** What an agent (or the cockpit) is asking the knowledge base for. */
export interface FactQuery {
  /** The scopes the caller can see. Omitted means every scope — the cockpit's read, not an agent's. */
  scopes?: readonly string[];
  /** Free text to match claims against. Omitted returns the scope's facts, newest first. */
  question?: string | null;
  limit?: number;
}

/** How many distinct goals must have seen it before a proposal is answerable on a lookup. */
const CORROBORATIONS_TO_LOOKUP = 2;

/** The reaches a live claim can be in — everything a re-proposal may join. */
const LIVE_REACHES: readonly FactReach[] = ['proposal', 'lookup', 'injected', 'committed'];

/**
 * The fact a promoted lesson becomes. Derived from the lesson's id rather than
 * minted, which is the whole of the adoption's idempotence: the second boot
 * inserts nothing, and the row can still be found again when the lesson is retired.
 *
 * Exported because the cockpit needs the same answer from the other side: since
 * delivery moved (phase 3) a lesson reaches agents *as its fact*, so whether a
 * promoted lesson is being sent is the knowledge block's answer looked up under
 * this id. A second spelling of the derivation in the view layer would make the
 * Lessons panel's chip a claim about a row that might not be the one delivered.
 */
export function adoptedFactId(lessonId: string): string {
  return `fact_${lessonId}`;
}

function lapsesAt(from: string, hours: number): string {
  return new Date(new Date(from).getTime() + hours * 3_600_000).toISOString();
}

interface FactRow {
  id: string;
  claim: string;
  scope: string;
  lifetime: string;
  expires_at: string | null;
  reach: string;
  supersedes: string | null;
  origin_ref: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  ruled_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToFact(r: FactRow): KnowledgeFact {
  return {
    id: r.id,
    claim: r.claim,
    scope: r.scope as KnowledgeFact['scope'],
    lifetime: r.lifetime as KnowledgeFact['lifetime'],
    expiresAt: r.expires_at,
    reach: r.reach as FactReach,
    supersedes: r.supersedes,
    originRef: r.origin_ref,
    ruledAt: r.ruled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface CorroborationRow {
  id: string;
  fact_id: string;
  agent_id: string | null;
  task_id: string | null;
  goal_ref: string | null;
  session_id: string | null;
  words: string;
  created_at: string;
}

function rowToCorroboration(r: CorroborationRow): KnowledgeCorroboration {
  return {
    id: r.id,
    factId: r.fact_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    goalRef: r.goal_ref,
    sessionId: r.session_id,
    words: r.words,
    createdAt: r.created_at,
  };
}
