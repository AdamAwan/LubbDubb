import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { claimKey, claimsMatch } from '../claims.js';
import {
  amendmentProposal,
  contradictableFact,
  contradictionRatio,
  distinctCorroborators,
  questionScore,
  type FactContradiction,
  type FactProposal,
} from '../knowledge/knowledge.js';
import type {
  ContradictionResolution,
  ContradictionRuling,
  FactExit,
  FactObservation,
  FactReach,
  FactResolution,
  GraduationExit,
  GraduationOutcome,
  GraduationTarget,
  KnowledgeContradiction,
  KnowledgeCorroboration,
  KnowledgeFact,
  KnowledgeGraduation,
} from '../types.js';
import { tableColumns, type ColumnMigrations, type TableRebuild } from './migrate.js';
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
 * `knowledge_graduations` (phase 6) is a **new table** and so needs no entry at
 * all — `CREATE TABLE IF NOT EXISTS` creates it whole on every database that does
 * not have it. Being new *once* is what stops keeping it exempt: the first column
 * added to it later belongs here, exactly as the two above do.
 *
 * `about_ref` and `where_at` arrive with the unified intake, and are the third
 * addition with no backfill behind it — for the plainest reason of the three.
 * Nothing before `raise` could name the item a claim was about or where it was
 * seen, so null is not merely tolerable on an older row: it is the only true
 * value, and a backfill could only guess a locator for an observation nobody
 * recorded one for. What makes the absence safe to leave is that both are
 * *optional at the boundary too* — a fact with neither reads and renders exactly
 * as every fact did before them.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const KNOWLEDGE_COLUMNS: ColumnMigrations = {
  knowledge_facts: {
    ruled_at: 'TEXT',
    resolves_when: 'TEXT',
    about_ref: 'TEXT',
    where_at: 'TEXT',
    project: 'TEXT',
    keep_local: 'INTEGER',
  },
  knowledge_corroborations: { fleet_id: 'TEXT' },
  knowledge_graduations: { exit: 'TEXT', ticket_ref: 'TEXT' },
};

/**
 * The pool's two columns, and the one of them whose **null means something**.
 *
 * `project` is the project name at the moment the fact was written, so what is
 * recorded is what was true when the claim was learned rather than what is true
 * when it is published. Null there spells *no project*, which would exclude every
 * claim the store already holds from ever being published — and every one of them
 * was in fact learned about the deployment's current project. So it is stamped,
 * **gated on `ensureColumns` reporting that it added the column**: run on every
 * boot instead, this would relabel every claim written since the day an operator
 * pointed the harness at a second project.
 *
 * A deployment with no project name configured stamps nothing, which is the honest
 * answer: there is no name to assert, and the rows stay null until there is one.
 *
 * `keep_local` needs no backfill beside it, for the plainest reason of the pair:
 * nothing before this could withhold anything, so null is not merely tolerable on
 * an older row — it is the only true value.
 * → `docs/spec/14-persistence.md#when-a-null-means-something`
 */
export function stampFactsWithProject(db: Database.Database, project: string): void {
  db.prepare(`UPDATE knowledge_facts SET project=? WHERE project IS NULL`).run(project);
}

/**
 * The one shape change here that **no `ALTER TABLE` can express**.
 *
 * The exits merged (#506's `f07ddda`) changed `knowledge_graduations` twice at
 * once. Gaining `exit` is additive and has its entry in {@link KNOWLEDGE_COLUMNS}
 * above. **Relaxing `target` from `NOT NULL` to nullable is not**, and nothing
 * carries a relaxation: `ADD COLUMN` cannot express one and SQLite has no
 * `ALTER COLUMN`, so on every database created in that window the column is still
 * `NOT NULL` — permanently, while `SCHEMA` says otherwise and every reader
 * believes it.
 *
 * Both halves of what that costs are the reason this is a rebuild rather than a
 * note. A `job` or a `ticket` exit writes `target = NULL`, so `recordGraduation`'s
 * plain `INSERT` **throws** for two of the three exits and succeeds for the third,
 * which reads as two broken buttons rather than as a schema. And the fold's
 * `INSERT OR IGNORE` — there for the primary-key collision with the lessons
 * mirror — swallows `SQLITE_CONSTRAINT_NOTNULL` just as quietly, so every folded
 * finding's graduation was dropped without a trace on a pass `runOnce` then
 * stamped as done.
 *
 * Detected on the constraint rather than on a column's presence, which is what
 * `detect` exists for: nothing is named differently between the two shapes. It is
 * false the moment the rebuild has run, so a second boot is a no-op.
 *
 * The rebuild closes the mirror-image drift for free: `exit` is `NOT NULL` in
 * `SCHEMA` and nullable on every migrated database, because `ALTER` cannot add a
 * `NOT NULL` column without a default. Low impact — the backfill stamps every
 * pre-existing row and every writer supplies one — but it is the same table
 * disagreeing with the same file.
 * → `docs/spec/14-persistence.md#rebuilding-a-table-whose-key-changed`
 */
export const KNOWLEDGE_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'knowledge_graduations',
    detect: (db) => tableColumns(db, 'knowledge_graduations').some((c) => c.name === 'target' && c.notnull === 1),
    // The two old shapes differ, and the rebuild runs *before* `ensureColumns`: a
    // database that has booted a post-merge build already carries `exit` and
    // `ticket_ref`, and one straight out of the window has neither. Naming them
    // unconditionally would throw on exactly the oldest databases this is for, so
    // the missing ones are supplied as the constants they can only be — `docs`,
    // which is what every graduation written before there were three exits was,
    // and the same assertion {@link stampGraduationsBeforeExits} makes.
    copy: (old, db) => {
      const has = new Set(tableColumns(db, old).map((c) => c.name));
      const exit = has.has('exit') ? `COALESCE(exit, 'docs')` : `'docs'`;
      const ticket = has.has('ticket_ref') ? 'ticket_ref' : 'NULL';
      return `
      INSERT INTO knowledge_graduations
        (id, fact_id, exit, job_id, target, bar, pr_ref, ticket_ref, outcome, settled_at, created_at)
      SELECT id, fact_id, ${exit}, job_id, target, bar, pr_ref, ${ticket}, outcome, settled_at, created_at
        FROM ${old}`;
    },
  },
];

/**
 * The one column here whose **null means something**, and so the one that needs a
 * backfill as well as an `ALTER TABLE`.
 *
 * Every graduation written before the exits merged was a documentation pull
 * request, because that was the only kind there was. Left null, those rows read as
 * an exit nothing recognises: the sweep would not know whether to watch the work
 * graph for them, and the page would draw a claim that went to the repository as
 * one that went nowhere nameable. So they are stamped `docs`, which is what they
 * are — the migration asserts history rather than guessing at it.
 *
 * **Gated on `ensureColumns` reporting that it added the column**, which is the
 * whole discipline: run on every boot instead, this would rewrite the exit of every
 * job and ticket graduation written since, and a wrong exit is silent in both
 * directions. `ticket_ref` needs no backfill beside it — null there is the only
 * true value on a row that never had a ticket.
 * → `docs/spec/14-persistence.md#when-a-null-means-something`
 */
export function stampGraduationsBeforeExits(db: Database.Database): void {
  db.prepare(`UPDATE knowledge_graduations SET exit='docs' WHERE exit IS NULL`).run();
}

/**
 * The `knowledge_facts` and `knowledge_corroborations` tables: what the fleet
 * knows about working this repository, who says so, who disputes it and who has
 * asked for it.
 *
 * The tables were new in phase 1 and have gained one column since, which is what
 * {@link KNOWLEDGE_COLUMNS} above is: being new *once* does not keep a table
 * exempt, and `CREATE TABLE IF NOT EXISTS` never alters an existing one.
 * `knowledge_asks` (phase 7) is new here and so has no entry — and is no more
 * exempt than the two above were on the day they shipped.
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
  /**
   * @param project The project name this deployment declares (`pool.project`), stamped
   * on every fact as it is written. Null on a deployment that declares none, which is
   * every deployment with the pool off — and null there spells *no project*, not
   * *some project nobody named*.
   */
  constructor(
    private readonly ctx: StoreContext,
    private readonly project: string | null = null,
  ) {}

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
    //
    // Lapsed rows are out of the match, for `retired`'s reason and by `askFacts`'
    // rule: a row a re-raise may join is a row somebody could still be told. A
    // notice that ran out its clock — or that `resolveNotice` lapsed because its
    // condition was met — is out of every read, so joining it would bury the
    // second occurrence on a claim the fleet is never told again, wearing the
    // first one's date and its spent clock.
    const existing =
      this.matchingFacts(proposal.scope, key, LIVE_REACHES, this.ctx.now()).find((f) => f.id !== proposal.supersedes) ??
      null;
    // A rejected claim bars a re-proposal — **unless what this proposal matches is
    // a live fact descended from that rejection**. An amendment is exempt by naming
    // its parent, and a later agent restating the amendment's own words has no id
    // to name: without this, the bar swallows the corrected claim through exactly
    // the containment that makes it an amendment, and the fleet is refused by the
    // name of a claim nobody is being told.
    //
    // No `liveAt` here, deliberately: a rejection is a ruling with no clock on it
    // and bars the claim by name however old the row is. Filtering it by
    // `expires_at` would leak the bar the moment a rejected notice's clock went by.
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

  /**
   * Record that this agent saw what a claim already says — an agreement made **on
   * purpose** rather than by accident (`raise` naming `agreeWith`).
   *
   * The most useful call an agent can make here is agreement, and until this it
   * could only be made by typing a sentence that happened to contain, or be
   * contained by, one somebody else had already typed. An agent that has read a
   * claim in its own prompt, hit exactly that wall, and wants to say so had no way
   * to say it.
   *
   * **The matcher is not consulted at all**, because there is nothing left for it
   * to guess: the agent named the row. What is *not* skipped is the bar — a
   * rejected claim is refused by name exactly as raising its words would be, since
   * the bar is about the claim and never about the spelling of the call that
   * reaches for it.
   *
   * **The gate is untouched.** An agreement is a corroboration from the caller's
   * own goal, and two *different* goals are still what carries a claim to
   * `lookup` — so an agent agreeing with its own earlier claim moves nothing.
   * → `docs/spec/27-knowledge.md#agreeing-on-purpose`
   */
  agreeWithFact(id: string, observer: FactObservation): FactAgreementOutcome {
    const fact = this.getFact(id);
    if (!fact) return { outcome: 'unknown' };
    if (fact.reach === 'rejected') {
      return {
        outcome: 'refused',
        error:
          `An operator has rejected that claim, so agreeing with it changes nothing: "${fact.claim}" (${fact.id}). ` +
          `Rejected means it was judged not true. If what you saw genuinely differs from it, raise the sharper ` +
          `version with contradicts: "${fact.id}" — an amendment is exempt from its parent's bar.`,
      };
    }
    // The reaches a re-raise may not join either, and refused in the same words:
    // a claim nobody is being told is not a claim a voice can carry anywhere, and
    // an agent that believes it has agreed with one has been told something untrue
    // about what it just did. Raising it afresh re-dates it, with its own evidence,
    // which is the rule `retired` exists to state.
    if (fact.reach === 'superseded' || fact.reach === 'retired') {
      return {
        outcome: 'refused',
        error:
          `That claim is ${fact.reach} and reaches nobody, so a voice on it carries nothing: "${fact.claim}" ` +
          `(${fact.id}). If you saw it yourself, raise it as its own claim — that files a fresh row with your ` +
          `evidence and today's date rather than resurrecting a judgement nobody has revisited.`,
      };
    }
    this.recordCorroboration(fact.id, observer);
    const corroborations = distinctCorroborators(this.listCorroborations(fact.id));
    return { outcome: 'recorded', fact: this.promoteOnCorroboration(fact, corroborations), corroborations };
  }

  /**
   * The facts this fleet may publish to the cross-fleet pool.
   *
   * Four conditions, and each of the three refusals behind them is a decision
   * rather than a filter:
   *
   * - **Reach is `lookup` or `injected`.** A proposal is one agent's claim nobody
   *   has agreed with; `graduated` is in the repository now, where git already
   *   carries it for a fleet on the same repository and where it was a claim about
   *   a repository a fleet on another one does not have.
   * - **`ruled_at` is not null.** *The vouch*, and reading it is what makes the gate
   *   mechanical: it is stamped on any move an operator makes, so "a person has read
   *   this sentence and ruled on it" is a column rather than a policy somebody has to
   *   keep true. The awkward case closes by construction — a claim two agents carried
   *   to `lookup` that no person has seen carries a null here and does not leave the
   *   machine.
   * - **The lifetime is standing.** A notice never crosses: it is a report on today,
   *   and its resolution condition names a check on a pull request in a repository
   *   the reader cannot see, so nothing at the far end can evaluate it and the clock
   *   silently becomes the whole mechanism on the one kind written to have more.
   * - **Scope is `fleet`.** A `goal:` scope dies with its goal, and a `check:` scope
   *   names another fleet's pipeline.
   *
   * `keep_local` is the operator's own opt-out on top of all four.
   * → `docs/spec/28-cross-fleet-pool.md#what-leaves`
   */
  listPublishableFacts(): KnowledgeFact[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_facts
          WHERE scope = 'fleet'
            AND reach IN ('lookup','injected')
            AND lifetime = 'standing'
            AND ruled_at IS NOT NULL
            AND (keep_local IS NULL OR keep_local = 0)
          ORDER BY ruled_at ASC, rowid ASC`,
      )
      .all() as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Withhold one claim from the pool, or put it back.
   *
   * Not a reach and not a ruling: it changes nothing about who this fleet tells,
   * only about who else may read it. So `ruled_at` is deliberately left alone — a
   * claim withheld is still a claim the operator ruled on, and stamping it here
   * would move it out of the page's **Needs you** section for a click that answered
   * a different question.
   */
  setFactKeepLocal(id: string, keepLocal: boolean): KnowledgeFact | null {
    const result = this.ctx.db
      .prepare(`UPDATE knowledge_facts SET keep_local=?, updated_at=? WHERE id=?`)
      .run(keepLocal ? 1 : 0, this.ctx.now(), id);
    if (result.changes === 0) return null;
    return this.getFact(id);
  }

  getFact(id: string): KnowledgeFact | null {
    const row = this.ctx.db.prepare(`SELECT * FROM knowledge_facts WHERE id=?`).get(id) as FactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * Every fact, newest first — including the rejected ones, for the reason
   * the retired ones are kept too: a governance surface that draws only what it
   * let through cannot show what it stopped.
   */
  listFacts(limit = 200): KnowledgeFact[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_facts ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * The claims raised on one goal, newest first — its `issue:<n>` root and
   * everything under it, the subtree `retroBriefing`'s `mine` predicate selects.
   *
   * The goal-scoped twin of {@link listFacts}, and for the reason {@link factLabels}
   * is by id: that read's `LIMIT` is fleet-wide and lands **before** a client-side
   * filter, so a goal's claims survived it only while the rest of the fleet stayed
   * quiet. The dossier's section is gated on the list being non-empty, so what a
   * busy fleet cost was the whole heading.
   * → `docs/spec/05-dispatcher.md#what-it-is-bounded-by`
   *
   * The ref is `issue:<n>`, so it carries no `LIKE` wildcards.
   */
  listFactsForGoal(goalRef: string, limit = 200): KnowledgeFact[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_facts
         WHERE origin_ref = ? OR origin_ref LIKE ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(goalRef, `${goalRef}:%`, limit) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * The claim each of these facts makes, by id — the pets panel's label for a
   * `claim` origin. By id rather than off {@link listFacts}, whose cap is the
   * reason a client-side join would leave the oldest pets unnamed. A missing id is
   * absent from the map, never an error.
   * → `docs/spec/22-pets.md#the-sources`
   */
  factLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, claim FROM knowledge_facts WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      claim: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.claim]));
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
   * door. `graduated` is unreachable for the opposite reason: the claim left this
   * store for somewhere that carries it better — the repository, a job, a ticket —
   * so answering an ask with one would pay context for a sentence the fleet is
   * deliberately no longer told.
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
   * Record that an agent asked for these claims and was answered with them — the
   * only writer of `knowledge_asks`.
   *
   * **Not in {@link askFacts}, and that is the whole of the design.** That method
   * is a read path, and `stateSnapshot` calls it *twice on every poll* to project
   * the delivery view — so a count kept inside it would count the operator's own
   * browser as fleet demand, growing fastest while nobody was looking at the page
   * and fastest of all on the claims nobody asks for. What keeps the cockpit out
   * is not a filter somebody has to remember but the argument below: an ask is
   * attributed to an asker, resolved from the credential the way every other write
   * in the tool channel is, and the cockpit has none to give.
   *
   * **Delivery by scope is not an ask.** A `lookup` claim also reaches agents
   * through the task-prompt append of every dispatch its scope matches, and
   * counting that would make this a count of *dispatches matching a scope* — a
   * fact about the fleet's shape rather than about the claim, under a label that
   * says otherwise. A `check:format:check` claim would score highest in the week
   * `format:check` happened to fail most, and a fleet-scoped claim, which no
   * scoped append ever carries, could never score at all.
   *
   * Rows rather than a counter for {@link recordCorroboration}'s reason with one
   * word changed: a corroboration is a row because the *words* are what an
   * operator reads, and an ask has none — so what it carries instead is who and
   * when, which is what separates a claim forty agents wanted from one an agent
   * asked for forty times in a loop.
   */
  recordFactAsks(factIds: readonly string[], asker: FactAsker): void {
    if (factIds.length === 0) return;
    const at = this.ctx.now();
    const insert = this.ctx.db.prepare(
      `INSERT INTO knowledge_asks (id, fact_id, agent_id, task_id, goal_ref, session_id, created_at)
       VALUES (@id, @factId, @agentId, @taskId, @goalRef, @sessionId, @createdAt)`,
    );
    for (const factId of factIds) {
      insert.run({ id: `kna_${nanoid(10)}`, factId, ...asker, createdAt: at });
    }
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
   * Record that an operator has opened work to take a claim somewhere — a
   * documentation pull request, a job that works it, or a ticket that files it.
   *
   * **The fact is not touched.** Its reach stays exactly where it was, so it goes
   * on being answered, injected and contradicted while the pull request sits in
   * review — which is the whole of what makes the state between the click and the
   * landing safe. A reach that moved here would stop the fleet being told a claim
   * nobody has acted on and nobody can read yet, and an attempt that never landed
   * would leave it that way with nothing red.
   *
   * The job is created by the caller that holds both tables — `Store.exitFact`,
   * in one transaction with this row — because a store module may not reach a
   * sibling's tables (`test/storeModules.test.ts`) and a job with no graduation
   * naming it is work that lands and takes nothing out of any prompt.
   */
  recordGraduation(factId: string, jobId: string, exit: FactExit): KnowledgeGraduation {
    const row: KnowledgeGraduation = {
      id: `kng_${nanoid(10)}`,
      factId,
      exit: exit.exit,
      jobId,
      // The document is the `docs` exit's own question. A job and a ticket have
      // none, and a defaulted `spec` on one would be a target nothing writes into
      // wearing a name that says an agent will.
      target: exit.exit === 'docs' ? exit.target : null,
      bar: exit.exit === 'docs' && exit.target === 'claudeMd' ? exit.bar : null,
      prRef: null,
      ticketRef: null,
      outcome: null,
      settledAt: null,
      createdAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_graduations
           (id, fact_id, exit, job_id, target, bar, pr_ref, ticket_ref, outcome, settled_at, created_at)
         VALUES (@id, @factId, @exit, @jobId, @target, @bar, @prRef, @ticketRef, @outcome, @settledAt, @createdAt)`,
      )
      .run(row);
    return row;
  }

  /**
   * Every graduation, newest first — the abandoned ones included, for the reason
   * {@link listFacts} keeps the rejected claims: an operator deciding whether to
   * send a claim somewhere again needs to know one was tried and did not land.
   */
  listGraduations(limit = 200): KnowledgeGraduation[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM knowledge_graduations ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as GraduationRow[];
    return rows.map(rowToGraduation);
  }

  /**
   * The graduations still going that the **work graph** can settle: what the sweep
   * has something to ask about.
   *
   * A `ticket` exit is deliberately out. What settles one is the filing agent
   * reporting the item it created through `link_ticket` — there is no pull request
   * to watch, and a sweep that read one anyway would call every open filing job
   * `waiting` forever while a second reader settled it, which is two answers to
   * one question with nothing to say they agree.
   */
  openGraduations(): KnowledgeGraduation[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_graduations
           WHERE outcome IS NULL AND exit <> 'ticket' ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as GraduationRow[];
    return rows.map(rowToGraduation);
  }

  /**
   * The graduation a job was opened for, if it was opened for one — how
   * `link_ticket` finds the claim back from a filing agent's credential
   * (`agent -> task -> its job:<id> origin -> this row`), so the tool takes no
   * argument naming what it is filing.
   */
  findGraduationByJobId(jobId: string): KnowledgeGraduation | null {
    const row = this.ctx.db.prepare(`SELECT * FROM knowledge_graduations WHERE job_id=?`).get(jobId) as
      | GraduationRow
      | undefined;
    return row ? rowToGraduation(row) : null;
  }

  /**
   * Record the tracker item a filing agent created, and end the graduation with it:
   * the `ticket` exit's own landing, and the claim reaches `graduated` in the same
   * transaction.
   *
   * **The ticket existing is the exit being taken**, which is why this is one write
   * and not two. A ticket recorded over a claim still injected pays context for a
   * sentence the backlog now carries, and a claim at `graduated` with no ticket ref
   * beside it is a row out of every prompt pointing nowhere.
   *
   * Guarded in the write (`WHERE ... outcome IS NULL`) rather than by a
   * read-then-check, the discipline `decideProposal` uses and the one
   * `linkFindingTicket` had before the stores merged — an agent that calls
   * `link_ticket` twice links once, with no caller obliged to look first. Null
   * means there was nothing open to settle, which the tool turns into an error the
   * agent can read.
   */
  linkGraduationTicket(id: string, ticketRef: string): KnowledgeGraduation | null {
    const at = this.ctx.now();
    const write = this.ctx.db.transaction((): KnowledgeGraduation | null => {
      const result = this.ctx.db
        .prepare(
          `UPDATE knowledge_graduations SET ticket_ref=?, outcome='landed', settled_at=?
             WHERE id=? AND exit='ticket' AND outcome IS NULL`,
        )
        .run(ticketRef, at, id);
      if (result.changes === 0) return null;
      const row = this.getGraduation(id);
      // Ruled, and by the operator: they said the claim belongs in the tracker, and
      // the item existing is that decision arriving rather than a second one.
      // `moveReach` refuses a rejected or superseded claim, so a fact an operator
      // killed while the filing agent was writing stays killed and the graduation
      // still ends — the honest reading of both.
      if (row !== null) this.moveReach(row.factId, 'graduated', at);
      return row;
    });
    return write();
  }

  getGraduation(id: string): KnowledgeGraduation | null {
    const row = this.ctx.db.prepare(`SELECT * FROM knowledge_graduations WHERE id=?`).get(id) as
      | GraduationRow
      | undefined;
    return row ? rowToGraduation(row) : null;
  }

  /**
   * Stamp the pull request the job produced, the first time the work graph shows
   * one.
   *
   * Written down rather than re-derived on every read, because the graph's memory
   * of the job that produced a pull request is only as long as `listJobs`' window:
   * the edge is folded from the job's own branch, and an aged-out job stops being
   * offered to the fold. The ref is what the page draws — a row naming a pull
   * request and offering no way there is the cockpit's most repeated bug — and it
   * has to survive the graduation itself.
   *
   * Guarded on the row still being open and on nothing having been stamped yet, so
   * a second pull request opened on the same branch never displaces the one this
   * graduation is actually waiting on.
   */
  noteGraduationPr(id: string, prRef: string): void {
    this.ctx.db
      .prepare(`UPDATE knowledge_graduations SET pr_ref=? WHERE id=? AND pr_ref IS NULL AND outcome IS NULL`)
      .run(prRef, id);
  }

  /**
   * End a graduation — and, for the one outcome that means the claim is in the
   * claim is somewhere else now, move the fact to `graduated` **in the same
   * transaction**.
   *
   * One write, because they are one event. Two would half-land in both directions
   * and both are silent: a fact at `graduated` with no graduation saying where it
   * went is a claim out of every prompt pointing nowhere, and a graduation marked
   * landed over a fact still injected pays context for a sentence somebody else is
   * already carrying.
   *
   * `abandoned` moves nothing. An attempt that did not land means nobody took the
   * claim anywhere, so it stays exactly where it was, goes on being delivered, and
   * can be sent again.
   *
   * Idempotent through the guard on `outcome IS NULL`, so a sweep that runs twice
   * over one pulse cannot re-settle a row or re-move a reach.
   */
  settleGraduation(id: string, outcome: GraduationOutcome): KnowledgeGraduation | null {
    const at = this.ctx.now();
    const write = this.ctx.db.transaction((): KnowledgeGraduation | null => {
      const result = this.ctx.db
        .prepare(`UPDATE knowledge_graduations SET outcome=?, settled_at=? WHERE id=? AND outcome IS NULL`)
        .run(outcome, at, id);
      if (result.changes === 0) return null;
      const row = this.getGraduation(id);
      // Ruled, and by the operator: they said the claim belongs in the repository,
      // and the pull request landing is that decision arriving rather than a second
      // one. `moveReach` refuses a rejected or superseded claim, so a fact an
      // operator killed while its pull request was in review stays killed and the
      // graduation still ends — which is the honest reading of both.
      if (row !== null && outcome === 'landed') this.moveReach(row.factId, 'graduated', at);
      return row;
    });
    return write();
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
    // The ask count is a third read on the same batching argument, and it lands
    // here rather than in a method of its own for the reason the ratio did: one
    // read producing every number on a row is one read the page cannot draw two
    // disagreeing halves of.
    const asked = new Map<string, { asks: number; lastAskedAt: string }>();
    for (const row of this.ctx.db
      .prepare(
        `SELECT fact_id, COUNT(*) AS asks, MAX(created_at) AS last_asked_at
           FROM knowledge_asks GROUP BY fact_id`,
      )
      .all() as { fact_id: string; asks: number; last_asked_at: string }[]) {
      asked.set(row.fact_id, { asks: row.asks, lastAskedAt: row.last_asked_at });
    }
    const counts = new Map<string, FactCounts>();
    for (const factId of new Set([...agreed.keys(), ...disputed.keys(), ...asked.keys()])) {
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
        // Rows and not voices, and no window. Rows because the question is how
        // often the claim was *wanted* rather than how many independent parties
        // will vouch for it — independence is what a count needs when it carries a
        // claim somewhere, and this one carries nothing. No window for the ratio's
        // reason: a second span over the same rows would be a second rule.
        asks: asked.get(factId)?.asks ?? 0,
        lastAskedAt: asked.get(factId)?.lastAskedAt ?? null,
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
        //
        // `retired` is deliberately **not** guarded with them. It is the prune, and
        // a prune has to be the cheap act on this surface — an operator who has to
        // be sure before tidying is an operator who does not tidy, and the store
        // this whole design fears is the one nobody prunes. Bringing one back is an
        // ordinary ruling; what a retired claim does not do is come back by itself,
        // through an agent raising it again.
        `UPDATE knowledge_facts SET reach=?, updated_at=?, ruled_at=COALESCE(?, ruled_at)
           WHERE id=? AND reach NOT IN ('rejected','superseded')`,
      )
      .run(reach, updatedAt, ruledAt, id);
    if (result.changes === 0) return null;
    return this.getFact(id);
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
   * The shape `findings` used for the same job, and the list is short for its reason.
   */
  private matchingFacts(scope: string, key: string, reaches: readonly FactReach[], liveAt?: string): KnowledgeFact[] {
    const holes = reaches.map(() => '?').join(',');
    const lapse = liveAt === undefined ? '' : ' AND (expires_at IS NULL OR expires_at > ?)';
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM knowledge_facts WHERE scope=? AND reach IN (${holes})${lapse} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(scope, ...reaches, ...(liveAt === undefined ? [] : [liveAt])) as FactRow[];
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
      aboutRef: proposal.aboutRef,
      where: proposal.where,
      // Stamped as the fact is written rather than read at publish time: what is
      // worth recording is the project the claim was *learned* about, and a
      // deployment repointed at a second repository would otherwise relabel its
      // whole history.
      project: this.project,
      keepLocal: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_facts
           (id, claim, scope, lifetime, expires_at, reach, supersedes, origin_ref, ruled_at, resolves_when,
            about_ref, where_at, project, keep_local, created_at, updated_at)
         VALUES (@id, @claim, @scope, @lifetime, @expiresAt, @reach, @supersedes, @originRef, @ruledAt,
                 @resolvesWhen, @aboutRef, @where, @project, 0, @createdAt, @updatedAt)`,
      )
      .run({
        ...fact,
        // Dropped from the binding rather than bound: `keep_local` is written as
        // the literal 0 above (better-sqlite3 refuses a JS boolean), and the driver
        // throws on a named parameter the statement does not use.
        keepLocal: undefined,
        resolvesWhen: fact.resolvesWhen === null ? null : JSON.stringify(fact.resolvesWhen),
      });
    return fact;
  }

  /**
   * One voice on a claim.
   *
   * **A pooled voice is upserted on `(fact_id, fleet_id)` and never appended**, and
   * that is the silent one. The poller re-reads whole documents forever, so an
   * append would add a corroboration on every pulse — some two hundred and
   * eighty-eight a day against every pooled claim, with nothing erroring, every
   * pooled claim crossing to `lookup` within one pulse and then going on climbing.
   * It looks *exactly* like the design working.
   * → `docs/spec/28-cross-fleet-pool.md#the-one-that-is-silent`
   */
  private recordCorroboration(factId: string, observer: FactObservation): void {
    const fleetId = observer.fleetId ?? null;
    if (fleetId !== null) {
      const existing = this.ctx.db
        .prepare(`SELECT id FROM knowledge_corroborations WHERE fact_id=? AND fleet_id=?`)
        .get(factId, fleetId) as { id: string } | undefined;
      if (existing) {
        // The words are refreshed rather than left: the origin's evidence is what an
        // operator reads before promoting, and a document that has been rewritten
        // since carries the corroborators it has now.
        this.ctx.db.prepare(`UPDATE knowledge_corroborations SET words=? WHERE id=?`).run(observer.words, existing.id);
        return;
      }
    }
    this.ctx.db
      .prepare(
        `INSERT INTO knowledge_corroborations
           (id, fact_id, agent_id, task_id, goal_ref, session_id, words, fleet_id, created_at)
         VALUES (@id, @factId, @agentId, @taskId, @goalRef, @sessionId, @words, @fleetId, @createdAt)`,
      )
      .run({ id: `knc_${nanoid(10)}`, factId, ...observer, fleetId, createdAt: this.ctx.now() });
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

/**
 * What an agreement did.
 *
 * `refused` carries its reason in the words the agent is given, for
 * {@link FactContradictionOutcome}'s reason: an agent that believes it has carried
 * a claim the fleet is not being told stops looking at it.
 */
export type FactAgreementOutcome =
  | { outcome: 'recorded'; fact: KnowledgeFact; corroborations: number }
  | { outcome: 'refused'; error: string }
  | { outcome: 'unknown' };

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
  /**
   * How often an agent asked for this claim and was answered with it — every ask,
   * over the whole life of the claim.
   *
   * The reading a `lookup` claim has that an injected one cannot: an injected line
   * is in front of every agent whether it wanted it or not, and there is no way to
   * measure whether one was read. This is demand, and it is measurable.
   *
   * **A reading and never a trigger.** Nothing is demoted, lapsed or dropped from
   * the block because nobody asked for it: a claim nobody wanted this month may be
   * the one that saves the next agent a day.
   */
  asks: number;
  /** The most recent ask, so the count can be dated. Null when there has been none. */
  lastAskedAt: string | null;
}

/**
 * Who asked — {@link FactObservation} with the words taken out, because an ask has
 * none to give.
 *
 * Every field is resolved from the credential, which is what structurally keeps
 * the cockpit's own reads of {@link KnowledgeStore.askFacts} out of the count:
 * there is no uncredentialed ask, so a poll has nothing to write with.
 */
type FactAsker = Omit<FactObservation, 'words'>;

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

/**
 * The reaches a live claim can be in — everything a re-raise may join.
 *
 * `retired` is **not** here, and that absence is what makes retiring a prune
 * rather than a quieter bar: a raised claim that matches a retired row files a
 * fresh one instead of joining it, which re-dates the claim and brings its own
 * evidence with it. Joining the old row would resurrect a judgement nobody has
 * revisited, wearing the date it was made on.
 */
const LIVE_REACHES: readonly FactReach[] = ['proposal', 'lookup', 'injected', 'graduated'];

/**
 * The fact a `findings` or `lessons` row became when the stores merged — derived
 * from the old row's id rather than minted.
 *
 * The derivation is what made the fold idempotent by construction, so the named
 * one-shot gate is not the only thing standing between a database and a second copy
 * of every claim it holds. And it is what makes the mapping **reversible**, which is
 * the reason it is exported rather than inlined: a pet hatched from a triaged
 * finding carries that finding's id in its seed, and putting the derivation back is
 * how its label is found now that the row it came from is gone. A second spelling of
 * it anywhere would be a label about a claim that might not be the one the creature
 * came from.
 */
export function foldedFactId(rowId: string): string {
  return `fact_${rowId}`;
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
  /** Nullable and possibly absent, for {@link FactRow.ruled_at}'s reason. */
  about_ref: string | null;
  /** Nullable and possibly absent, for {@link FactRow.ruled_at}'s reason. */
  where_at: string | null;
  /** The project the claim was learned about; nullable and possibly absent, for {@link FactRow.ruled_at}'s reason. */
  project: string | null;
  /** 1 when the operator has withheld this claim from the pool. Nullable and possibly absent. */
  keep_local: number | null;
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
    // `?? null` rather than the bare read: on a database from before the intake
    // landed these columns exist (`ensureColumns` added them) but an older row
    // carries SQL NULL, and a driver that hands back `undefined` for a column a
    // prepared statement never wrote would put `undefined` on a domain type whose
    // field is `string | null`. It renders as absent either way — which is the
    // failure being closed here, since absent is also the correct answer.
    aboutRef: r.about_ref ?? null,
    where: r.where_at ?? null,
    project: r.project ?? null,
    // `=== 1` rather than a truthiness read: the column is nullable and possibly
    // absent, and both of those are "not withheld" — the one value that must be
    // true is the explicit 1 an operator's click writes.
    keepLocal: r.keep_local === 1,
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
  /** The pool fleet whose document carried this voice; null for a local agent's own. */
  fleet_id: string | null | undefined;
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

interface GraduationRow {
  id: string;
  fact_id: string;
  /** Nullable *and* possibly absent on a row written before the exits merged; `docs` is what those were. */
  exit: string | null | undefined;
  job_id: string;
  target: string | null;
  bar: string | null;
  pr_ref: string | null;
  /** Nullable and possibly absent, for {@link GraduationRow.exit}'s reason. */
  ticket_ref: string | null | undefined;
  outcome: string | null;
  settled_at: string | null;
  created_at: string;
}

function rowToGraduation(r: GraduationRow): KnowledgeGraduation {
  return {
    id: r.id,
    factId: r.fact_id,
    // `?? 'docs'` and not a bare read: `stampGraduationsBeforeExits` writes the
    // word onto every row that predates the column, but a database that has the
    // column and a row the driver hands back as `undefined` would otherwise put
    // `undefined` on a domain field typed as a closed union — and every row this
    // could be true of is a documentation pull request, which is what the backfill
    // says in SQL and this says in the reader.
    exit: (r.exit ?? 'docs') as GraduationExit,
    jobId: r.job_id,
    target: r.target as GraduationTarget | null,
    bar: r.bar,
    prRef: r.pr_ref,
    ticketRef: r.ticket_ref ?? null,
    outcome: r.outcome as GraduationOutcome | null,
    settledAt: r.settled_at,
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
    // `?? null` for `rowToFact`'s reason: nullable *and* possibly absent on a
    // database from before the pool, where absent and null both mean "a local
    // agent said this".
    fleetId: r.fleet_id ?? null,
    createdAt: r.created_at,
  };
}
