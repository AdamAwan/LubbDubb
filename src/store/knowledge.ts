import { nanoid } from 'nanoid';
import { claimKey, claimsMatch } from '../claims.js';
import {
  amendmentProposal,
  contradictableFact,
  contradictionRatio,
  corroborationGoal,
  distinctCorroborators,
  questionScore,
  type FactContradiction,
  type FactProposal,
} from '../knowledge/knowledge.js';
import type {
  ContradictionResolution,
  ContradictionRuling,
  FactObservation,
  FactReach,
  FactResolution,
  KnowledgeContradiction,
  KnowledgeCorroboration,
  KnowledgeFact,
  Lesson,
} from '../types.js';
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
 *
 * `resolves_when` (phase 4) is the same shape of addition and the same absence of
 * a backfill, for a stronger reason: null spells *nothing but the clock settles
 * this*, and nothing before phase 4 could write a condition — so null is not
 * merely acceptable on an older row, it is the only true value. The rows that
 * carry one are written by the harness's own notice desk from the pulse it lands
 * on, and a backfill could only invent conditions for notices nobody was watching.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const KNOWLEDGE_COLUMNS: ColumnMigrations = {
  knowledge_facts: { ruled_at: 'TEXT', resolves_when: 'TEXT' },
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
    // An amendment always lands as its own row *rather than its parent's*. It
    // usually **contains** the claim it sharpens — that is what amending is — so
    // folding it into its parent as a corroboration would silently discard the
    // correction and leave the blunter claim standing with one more voice behind it.
    //
    // Which is the parent alone, and not everything: the second agent to hit the
    // same edge writes the same sharper sentence, and that call is agreement with
    // the amendment already standing. Skipping the match entirely — as this did
    // until amendments began arriving in volume — files each of them as its own
    // one-voice proposal, so three agents sharpening a claim carry nothing anywhere.
    const existing =
      this.matchingFacts(proposal.scope, key, LIVE_REACHES).find((f) => f.id !== proposal.supersedes) ?? null;
    // A rejected claim bars a re-proposal — **unless what this proposal matches is
    // a live fact descended from that rejection**. An amendment is exempt by naming
    // its parent, and a later agent restating the amendment's own words has no id
    // to name: without this, the bar swallows the corrected claim through exactly
    // the containment that makes it an amendment, and the fleet is refused by the
    // name of a claim nobody is being told.
    const barredBy = this.matchingFacts(proposal.scope, key, ['rejected']).find(
      (f) => f.id !== proposal.supersedes && !(existing !== null && this.descendsFrom(existing, f.id)),
    );
    if (barredBy) return { outcome: 'barred', barredBy };
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
   * The notices the sweep has something to ask about: expiring, still live, and
   * carrying a condition somebody can evaluate.
   *
   * Narrow on purpose. A notice whose clock is the whole of it needs no sweep —
   * {@link askFacts} already answers nobody with a lapsed row — so widening this
   * to "every notice" would hand the desk rows it can do nothing with and invite a
   * second opinion about lapsing beside the one this store already holds.
   *
   * Rejected rows are out for the reason they are out of every other read: a claim
   * an operator killed is not something the harness goes on tending.
   */
  listResolvableNotices(): KnowledgeFact[] {
    const now = this.ctx.now();
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_facts
           WHERE lifetime='expiring' AND reach<>'rejected' AND resolves_when IS NOT NULL AND expires_at > ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all(now) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * End a notice now, because what it reported has been settled.
   *
   * **Lapsing it, not deleting or demoting it.** A lapsed expiring fact is already
   * out of every read while its row stays saying what it said, so resolution rides
   * the mechanism the lifetime axis already has rather than adding a second way to
   * be out of a prompt — and the page can still show what the fleet was told and
   * when it stopped being told it. The reach is deliberately untouched: `rejected`
   * means *not true*, and a notice that was true this morning is not that.
   *
   * Idempotent, and guarded on the row still being live so a sweep that runs twice
   * cannot walk a lapse backwards or forwards.
   */
  resolveNotice(id: string): KnowledgeFact | null {
    const at = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE knowledge_facts SET expires_at=?, updated_at=?
           WHERE id=? AND lifetime='expiring' AND expires_at > ?`,
      )
      .run(at, at, id, at);
    if (result.changes === 0) return null;
    return this.getFact(id);
  }

  /**
   * An agent says an injected claim is contradicted by the code in front of it —
   * **and says what it should say instead**.
   *
   * The amendment is the whole of the call. A contradiction count punishes exactly
   * the wrong claims: one that is right in general and wrong at one edge attracts
   * contradictions *because it is being used*, so under a count the most valuable
   * claims in the store are the first to go. What comes out of a disagreement here
   * is therefore a sharper claim rather than one fewer claim, and the fact named is
   * left exactly where it was — nothing below demotes, lapses or deletes it, and
   * only an operator or its own clock ever will.
   *
   * The amendment is filed **through {@link proposeFact}** with `supersedes` set,
   * never a hand-rolled insert: the bar exemption, the claim matching that lets a
   * second agent's identical sharpening land as agreement rather than as a third
   * one-voice proposal, and the corroboration row are all that call's, and a second
   * writer would get one of the three wrong without failing anything.
   *
   * One transaction, because a contradiction with no amendment is refused and an
   * amendment with no contradiction behind it is a proposal nobody asked for.
   */
  contradictFact(input: FactContradiction, observer: FactObservation): FactContradictionOutcome {
    const fact = this.getFact(input.factId);
    if (!fact) return { outcome: 'unknown' };
    const allowed = contradictableFact(fact, this.ctx.now());
    if (!allowed.ok) return { outcome: 'refused', error: allowed.error };
    const write = this.ctx.db.transaction((): FactContradictionOutcome => {
      const amended = this.proposeFact(amendmentProposal(fact, input, this.ctx.now()), observer);
      // The amendment is exempt from its *parent's* bar and from nothing else, so a
      // sharper version an operator has separately killed is still refused — and
      // refused before any contradiction row names it, since a row pointing at an
      // amendment that was never filed is a dispute with nothing behind it.
      if (amended.outcome === 'barred') {
        return {
          outcome: 'refused',
          error:
            `an operator has rejected that amendment already: "${amended.barredBy.claim}" ` +
            `(${amended.barredBy.id}). Rejected means it was judged not true, so writing it again as a ` +
            `contradiction does not change the answer.`,
        };
      }
      this.ctx.db
        .prepare(
          `INSERT INTO knowledge_contradictions
             (id, fact_id, amendment_id, agent_id, task_id, goal_ref, session_id, words, resolution,
              resolved_at, created_at)
           VALUES (@id, @factId, @amendmentId, @agentId, @taskId, @goalRef, @sessionId, @words, NULL,
                   NULL, @createdAt)`,
        )
        .run({
          id: `knx_${nanoid(10)}`,
          factId: fact.id,
          amendmentId: amended.fact.id,
          agentId: observer.agentId,
          taskId: observer.taskId,
          goalRef: observer.goalRef,
          sessionId: observer.sessionId,
          // What the agent saw that the claim does not fit — the same words the
          // amendment's own corroboration carries, because they are the same
          // observation read from the two sides it speaks to.
          words: observer.words,
          createdAt: this.ctx.now(),
        });
      return {
        outcome: 'recorded',
        fact,
        amendment: amended.fact,
        contradictions: distinctCorroborators(this.listContradictions(fact.id)),
      };
    });
    return write();
  }

  /** One claim's contradictions, oldest first — resolved ones included, for `listFacts`' reason. */
  listContradictions(factId: string): KnowledgeContradiction[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_contradictions WHERE fact_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(factId) as ContradictionRow[];
    return rows.map(rowToContradiction);
  }

  /**
   * The operator's answer to a contradiction — and, for two of the three, the move
   * it makes on the claim, in **one call**.
   *
   * One call rather than two because adopting an amendment is one act: the
   * amendment reaching the original's reach and the original leaving it are two
   * halves of a single decision, and a pair of calls can half-land — the sharper
   * claim injected beside the blunter one it was written to replace, both in the
   * same block, saying different things to every agent until somebody notices.
   *
   * `amended` and `narrowed` answer **every** open contradiction on the claim,
   * because both move the claim itself and a dispute about a sentence that no
   * longer stands is not a decision anybody can still make. `dismissed` answers one
   * row and touches nothing else — the only move that leaves the fact where it was.
   */
  resolveContradiction(id: string, input: ContradictionRuling): ContradictionOutcome {
    const row = this.ctx.db.prepare(`SELECT * FROM knowledge_contradictions WHERE id=?`).get(id) as
      | ContradictionRow
      | undefined;
    if (!row) return { outcome: 'unknown' };
    if (row.resolution !== null) return { outcome: 'refused', error: 'this contradiction has already been answered' };
    const fact = this.getFact(row.fact_id);
    if (!fact) return { outcome: 'unknown' };
    if (fact.reach === 'rejected' || fact.reach === 'superseded') {
      return {
        outcome: 'refused',
        error: `the claim this disputes is ${fact.reach} — it reaches no agent, so there is nothing left to decide`,
      };
    }
    const at = this.ctx.now();
    // Read out here rather than inside the transaction: narrowing a parameter does
    // not survive into a closure, and the alternative is a cast over the one field
    // whose absence would make this call silently do nothing.
    const narrowedTo = input.resolution === 'narrowed' ? input.claim : null;
    const write = this.ctx.db.transaction((): ContradictionOutcome => {
      if (input.resolution === 'dismissed') {
        this.stampContradiction(row.id, 'dismissed', at);
        // The amendment is left exactly where it is — a proposal reaching nobody.
        // Rejecting it here would look tidy and would bar the claim it sharpens: an
        // amendment usually *contains* its original, and `claimsMatch` is
        // containment, so the next agent to corroborate the standing claim would be
        // refused by the name of the amendment nobody is being told. An operator who
        // wants it killed has the ordinary control, and pays that cost knowingly.
        return { outcome: 'resolved', fact };
      }
      if (input.resolution === 'amended') {
        const amendment = this.getFact(row.amendment_id);
        if (!amendment) return { outcome: 'refused', error: 'the amendment behind this contradiction is gone' };
        if (amendment.reach === 'rejected' || amendment.reach === 'superseded') {
          return { outcome: 'refused', error: `that amendment is ${amendment.reach} and cannot be adopted` };
        }
        // The amendment takes the claim's place *exactly* — the same reach, so
        // adopting a sharper version of an injected claim does not quietly promote
        // a lookup one into every agent's prompt, or quietly demote an injected one
        // out of it. Ruled, because an operator did it.
        this.moveReach(amendment.id, fact.reach, at);
        // Superseded and never rejected: the claim was not judged untrue, and a
        // rejection would bar the amendment's own words — which contain it — from
        // ever being restated by the next agent to hit the same edge.
        this.moveReach(fact.id, 'superseded', at);
        this.stampOpenContradictions(fact.id, 'amended', at);
        return { outcome: 'resolved', fact: this.getFact(fact.id) ?? fact };
      }
      this.ctx.db
        .prepare(`UPDATE knowledge_facts SET claim=?, updated_at=?, ruled_at=? WHERE id=?`)
        .run(narrowedTo, at, at, fact.id);
      // Every amendment the narrowing answered is superseded by it: the operator
      // has written the sentence themselves, so those proposals are replaced rather
      // than untrue — and leaving them live would grow a near-duplicate of the
      // narrowed claim that a later agent can corroborate into a second version of it.
      for (const open of this.listContradictions(fact.id).filter((c) => c.resolution === null)) {
        const amendment = this.getFact(open.amendmentId);
        if (amendment && amendment.reach !== 'rejected') this.moveReach(amendment.id, 'superseded', at);
      }
      this.stampOpenContradictions(fact.id, 'narrowed', at);
      return { outcome: 'resolved', fact: this.getFact(fact.id) ?? fact };
    });
    return write();
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
   * What has been said about every fact, in one read: how many independent voices
   * agree, how many dispute it, and what fraction of them that is.
   *
   * **One method rather than two, because the ratio's denominator is the
   * agreement count.** Two methods each scanning the corroboration table would
   * produce two corroborator counts under one name, and the page would draw one
   * beside a ratio computed from the other — the disagreement invisible, since
   * both are counts of the same rows.
   *
   * Every count here is {@link distinctCorroborators}' — never `rows.length`, on
   * either table: two observations are one voice if they share a goal or a
   * session, which is as true of a dispute as of an agreement, and an agent that
   * contradicted its own predecessor across a re-dispatch is one voice twice.
   *
   * Batched rather than a query per fact because the snapshot is polled: two
   * queries grouped in memory, rather than three per row per poll per connected
   * cockpit.
   */
  factCounts(): Map<string, FactCounts> {
    const agreed = this.groupVoices(
      this.ctx.db
        .prepare(`SELECT * FROM knowledge_corroborations ORDER BY created_at ASC, rowid ASC`)
        .all() as CorroborationRow[],
    );
    const disputes = this.ctx.db
      .prepare(`SELECT * FROM knowledge_contradictions ORDER BY created_at ASC, rowid ASC`)
      .all() as ContradictionRow[];
    const disputed = this.groupVoices(disputes);
    const counts = new Map<string, FactCounts>();
    for (const factId of new Set([...agreed.keys(), ...disputed.keys()])) {
      const corroborations = distinctCorroborators(agreed.get(factId) ?? []);
      const contradictions = distinctCorroborators(disputed.get(factId) ?? []);
      counts.set(factId, {
        corroborations,
        contradictions,
        contradictionRatio: contradictionRatio(corroborations, contradictions),
        // The queue rather than the reading, and a raw row count rather than a
        // count of voices: what an operator has left to answer is a number of
        // decisions, and two agents on one goal disputing a claim are still two
        // rows to read before ruling on it.
        openContradictions: disputes.filter((d) => d.fact_id === factId && d.resolution === null).length,
      });
    }
    return counts;
  }

  private groupVoices<T extends { fact_id: string; id: string; goal_ref: string | null; session_id: string | null }>(
    rows: readonly T[],
  ): Map<string, { id: string; goalRef: string | null; sessionId: string | null }[]> {
    const byFact = new Map<string, { id: string; goalRef: string | null; sessionId: string | null }[]>();
    for (const row of rows) {
      const list = byFact.get(row.fact_id) ?? [];
      list.push({ id: row.id, goalRef: row.goal_ref, sessionId: row.session_id });
      byFact.set(row.fact_id, list);
    }
    return byFact;
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
        // Both terminal states are guarded, for the same reason and two different
        // ones: a rejection is the bar, and nothing lifts it but an amendment; a
        // superseded claim has a sharper version standing in its place, and moving
        // it back would put the two in one block saying different things.
        `UPDATE knowledge_facts SET reach=?, updated_at=?, ruled_at=COALESCE(?, ruled_at)
           WHERE id=? AND reach NOT IN ('rejected','superseded')`,
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
           (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
            created_at, updated_at)
         VALUES (?, ?, 'fleet', 'standing', NULL, 'injected', NULL, ?, ?, NULL, ?, ?)`,
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

  private stampContradiction(id: string, resolution: ContradictionResolution, at: string): void {
    this.ctx.db
      .prepare(`UPDATE knowledge_contradictions SET resolution=?, resolved_at=? WHERE id=? AND resolution IS NULL`)
      .run(resolution, at, id);
  }

  private stampOpenContradictions(factId: string, resolution: ContradictionResolution, at: string): void {
    this.ctx.db
      .prepare(`UPDATE knowledge_contradictions SET resolution=?, resolved_at=? WHERE fact_id=? AND resolution IS NULL`)
      .run(resolution, at, factId);
  }

  /**
   * Whether one fact is an amendment of another, at any depth.
   *
   * The chain is walked rather than the one link read, because an amendment can
   * itself be amended — and a `seen` set rather than a depth bound, because a
   * cycle in `supersedes` is a corrupt row and this must return an answer rather
   * than spin on the delivery path.
   */
  private descendsFrom(fact: KnowledgeFact, ancestorId: string): boolean {
    const seen = new Set<string>([fact.id]);
    let current: KnowledgeFact | null = fact;
    while (current !== null && current.supersedes !== null) {
      if (current.supersedes === ancestorId) return true;
      if (seen.has(current.supersedes)) return false;
      seen.add(current.supersedes);
      current = this.getFact(current.supersedes);
    }
    return false;
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
      // A condition on a standing claim would be a condition nothing ever
      // evaluates — the sweep reads notices — so it is dropped rather than stored
      // where it would sit looking like a mechanism.
      resolvesWhen: proposal.lifetime === 'expiring' ? proposal.resolvesWhen : null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_facts
           (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
            created_at, updated_at)
         VALUES (@id, @claim, @scope, @lifetime, @expiresAt, @reach, @supersedes, @originRef, @ruledAt,
                 @resolvesWhen, @createdAt, @updatedAt)`,
      )
      .run({ ...fact, resolvesWhen: fact.resolvesWhen === null ? null : JSON.stringify(fact.resolvesWhen) });
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
   * Two corroborations from two different goals carry a proposal as far as
   * {@link autoReach} says, and **no further**.
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
    return this.moveReach(fact.id, autoReach(fact), null) ?? fact;
  }
}

/** What a proposal did. `barred` carries the rejected claim that refused it, so the agent can amend it. */
export type FactProposalOutcome =
  | { outcome: 'filed' | 'corroborated'; fact: KnowledgeFact; corroborations: number }
  | { outcome: 'barred'; barredBy: KnowledgeFact };

/**
 * What a contradiction did. `refused` carries the reason in the words the agent is
 * given: a contradiction the store will not take is one the agent would otherwise
 * believe it had made, and an agent that believes it has taken a stale claim off
 * the fleet stops looking at it.
 */
export type FactContradictionOutcome =
  | { outcome: 'recorded'; fact: KnowledgeFact; amendment: KnowledgeFact; contradictions: number }
  | { outcome: 'refused'; error: string }
  | { outcome: 'unknown' };

/** What resolving one did, and the claim as it now stands. */
export type ContradictionOutcome =
  | { outcome: 'resolved'; fact: KnowledgeFact }
  | { outcome: 'refused'; error: string }
  | { outcome: 'unknown' };

/**
 * What has been said about one claim: the count that promotes it, the count that
 * disputes it, the fraction that is, and how many of the disputes are still an
 * operator's to answer.
 *
 * All four taken together in `factCounts`, and all four shipped on the row, so
 * nothing in the browser divides one by another.
 */
export interface FactCounts {
  corroborations: number;
  /** Distinct voices disputing it, over the whole life of the claim — resolved disputes included. */
  contradictions: number;
  /** {@link contradictionRatio}'s answer: disputing voices over every voice that has spoken. */
  contradictionRatio: number;
  /** Disputes nobody has ruled on. The queue, where the ratio above is the reading. */
  openContradictions: number;
}

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

/**
 * As far as agreement *alone* carries a claim — and the one place in this store
 * where that is further than `lookup`.
 *
 * A notice may reach `injected` on corroboration because its blast radius is
 * capped by its own clock, and that is the whole of the safety argument: a claim
 * in front of every agent before it reads any code is a false instruction handed
 * to the whole fleet if it is wrong, and the only thing that makes accepting the
 * risk sane is that it ends by itself. A **standing** claim has nothing that ends
 * it, so nothing but an operator puts one there.
 *
 * Which is why the clock is read here rather than the lifetime alone: an expiring
 * fact with no `expiresAt` would be a standing claim wearing the word, and it is
 * one missed validation away from being the thing this function exists to refuse.
 */
function autoReach(fact: KnowledgeFact): FactReach {
  return fact.lifetime === 'expiring' && fact.expiresAt !== null ? 'injected' : 'lookup';
}

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

function parseResolution(raw: string | null | undefined): FactResolution | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FactResolution;
  } catch {
    return null;
  }
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
  /** Nullable and possibly absent, for {@link FactRow.ruled_at}'s reason. JSON, or null. */
  resolves_when: string | null;
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
    // Written by the harness and read by the harness, so a row that will not parse
    // is a bug in this file rather than in the world — but it is read on the
    // delivery path, where a throw would take the launch down with it. Null is the
    // safe reading: the clock still settles the notice.
    resolvesWhen: parseResolution(r.resolves_when),
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

interface ContradictionRow {
  id: string;
  fact_id: string;
  amendment_id: string;
  agent_id: string | null;
  task_id: string | null;
  goal_ref: string | null;
  session_id: string | null;
  words: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

function rowToContradiction(r: ContradictionRow): KnowledgeContradiction {
  return {
    id: r.id,
    factId: r.fact_id,
    amendmentId: r.amendment_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    goalRef: r.goal_ref,
    sessionId: r.session_id,
    words: r.words,
    resolution: r.resolution as ContradictionResolution | null,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
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
