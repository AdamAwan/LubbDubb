import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { liveParts, partSettled } from '../plans/parts.js';
import type {
  PartOutcomeKind,
  PartSize,
  Plan,
  PlanEvidence,
  PlanNarrative,
  PlanPart,
  PlanPartBlocker,
  PlanPartInput,
  PlanRevision,
  PlanStatus,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const PLAN_COLUMNS: ColumnMigrations = {
  // `plans`/`plan_parts` were introduced as fresh `CREATE TABLE`s and needed no
  // entry here. Columns added to them *now* do: `CREATE TABLE IF NOT EXISTS`
  // never alters an existing table, so without these the fields are invisible
  // on every database that predates them.
  plans: {
    diagnosis: 'TEXT',
    approach: 'TEXT',
    risks: 'TEXT',
    out_of_scope: 'TEXT',
    alternatives: 'TEXT',
    open_questions: 'TEXT',
    verification: 'TEXT',
    evidence: 'TEXT',
    document: 'TEXT',
    discussing: 'INTEGER NOT NULL DEFAULT 0',
  },
  plan_parts: {
    touches: 'TEXT',
    rationale: 'TEXT',
    acceptance: 'TEXT',
    acceptance_met: 'TEXT',
    size: 'TEXT',
    expected_kind: 'TEXT',
    /** The profile this part's work runs on — see {@link PlanPart.profile}. */
    profile: 'TEXT',
    outcome_kind: 'TEXT',
    outcome_ref: 'TEXT',
    outcome_summary: 'TEXT',
    blocked_reason: 'TEXT',
    /**
     * Which blocker — see {@link PlanPart.blockedBy}. Null on an older database's
     * standing blocked row, and that is the safe reading: an unattributed block
     * counts toward the wedge exactly as it did before this column existed.
     */
    blocked_by: 'TEXT',
  },
  // `plan_revisions` is a brand-new table, so `CREATE TABLE IF NOT EXISTS` is the
  // whole migration and it needs no entry. That is true *once*: a column added to
  // it later needs one here like any other.
};

/**
 * The `plans` and `plan_parts` tables: the multi-PR issue funnel.
 *
 * One module rather than two because {@link PlanStore.rollUpPlanStatus} reads the
 * parts and writes the plan — a fold across a module boundary would buy nothing
 * and would put half of it out of reach.
 */
export class PlanStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write (or refresh) an issue's plan, keyed by its `issue:<n>` origin. Upsert
   * rather than insert: a replan amends the verdict in place, keeping the plan id
   * its parts hang off. `createdAt` survives a refresh; `updatedAt` moves.
   */
  upsertPlan(input: {
    originRef: string;
    title: string;
    status: PlanStatus;
    diagnosis?: string | null;
    approach?: string | null;
    reason?: string | null;
    risks?: string | null;
    outOfScope?: string | null;
    alternatives?: string | null;
    openQuestions?: string | null;
    verification?: string | null;
    evidence?: PlanEvidence[] | null;
    document?: string | null;
    statusCommentRef?: string | null;
  }): Plan {
    const existing = this.getPlanByOrigin(input.originRef);
    const ts = this.ctx.now();
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      // Preserved on absence for the same reason `statusCommentRef` is: a caller
      // that writes a status without re-stating the narrative must not erase it.
      diagnosis: input.diagnosis ?? existing?.diagnosis ?? null,
      approach: input.approach ?? existing?.approach ?? null,
      risks: input.risks ?? existing?.risks ?? null,
      outOfScope: input.outOfScope ?? existing?.outOfScope ?? null,
      alternatives: input.alternatives ?? existing?.alternatives ?? null,
      openQuestions: input.openQuestions ?? existing?.openQuestions ?? null,
      verification: input.verification ?? existing?.verification ?? null,
      // Preserved on absence like the prose beside it, and on *absence* rather
      // than on emptiness: a planner that cited nothing this time has not
      // withdrawn what the last one cited, and `ingestPlanDocument` passes the
      // list it actually parsed either way.
      evidence: input.evidence ?? existing?.evidence ?? [],
      document: input.document ?? existing?.document ?? null,
      // Preserve a comment ref an earlier write established unless one is given —
      // the plan's status comment is edited in place, so losing the id orphans it.
      statusCommentRef: input.statusCommentRef ?? existing?.statusCommentRef ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO plans (id, origin_ref, title, status, diagnosis, approach, reason, risks, out_of_scope,
           alternatives, open_questions, verification, evidence, document, status_comment_ref,
           created_at, updated_at)
         VALUES (@id, @originRef, @title, @status, @diagnosis, @approach, @reason, @risks, @outOfScope,
           @alternatives, @openQuestions, @verification, @evidence, @document, @statusCommentRef,
           @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, status=excluded.status,
           diagnosis=excluded.diagnosis, approach=excluded.approach,
           reason=excluded.reason, risks=excluded.risks, out_of_scope=excluded.out_of_scope,
           alternatives=excluded.alternatives, open_questions=excluded.open_questions,
           verification=excluded.verification, evidence=excluded.evidence,
           document=excluded.document, status_comment_ref=excluded.status_comment_ref, updated_at=excluded.updated_at`,
      )
      .run({ ...plan, evidence: JSON.stringify(plan.evidence) });
    return plan;
  }

  /**
   * Record the plan a document carried, as its own revision.
   *
   * Append-only, and numbered off what is already there rather than off the plan —
   * a plan re-planned three times has three revisions whatever its status has done
   * in between. Called from {@link ingestPlanDocument} alone, which is the one
   * place a document becomes rows, so a revision cannot exist for a plan that was
   * never persisted or be missing for one that was.
   */
  recordPlanRevision(planId: string, input: { narrative: PlanNarrative; parts: PlanPartInput[] }): PlanRevision {
    const at = this.ctx.now();
    const row = this.ctx.db.prepare(`SELECT MAX(seq) AS seq FROM plan_revisions WHERE plan_id=?`).get(planId) as
      | { seq: number | null }
      | undefined;
    const revision: PlanRevision = {
      id: `rev_${nanoid(10)}`,
      planId,
      seq: (row?.seq ?? 0) + 1,
      narrative: input.narrative,
      parts: input.parts,
      at,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO plan_revisions (id, plan_id, seq, verdict, narrative, parts, at)
         VALUES (@id, @planId, @seq, @verdict, @narrative, @parts, @at)`,
      )
      .run({
        ...revision,
        // Vestigial: the column is `NOT NULL` on every existing database and every
        // plan is a `parts` plan now, so it is written and never read back. Dropping
        // it would be a table reshape for a value no reader consults.
        verdict: 'parts',
        narrative: JSON.stringify(revision.narrative),
        parts: JSON.stringify(revision.parts),
      });
    return revision;
  }

  /** Every verdict submitted for a plan, oldest first. */
  listPlanRevisions(planId: string): PlanRevision[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY seq ASC`)
      .all(planId) as PlanRevisionRow[];
    return rows.map(rowToRevision);
  }

  getPlan(id: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  /**
   * The title of each of these plans, by id — the pets panel's label for a
   * `plan` origin. A missing id is absent from the map, never an error.
   * → `docs/spec/22-pets.md#the-sources`
   */
  planLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, title FROM plans WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      title: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  getPlanByOrigin(originRef: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE origin_ref=?`).get(originRef) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlans(): Plan[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plans ORDER BY created_at ASC`).all() as PlanRow[];
    return rows.map(rowToPlan);
  }

  /**
   * Fold a plan's declared parts onto its rows, **merging on slug**: an existing
   * part keeps its branch, PR, status and task (it may already be in flight) and
   * only its declaration — seq/title/scope/dependsOn — is refreshed. Parts absent
   * from the amended plan are left alone rather than deleted; retiring one is a
   * status transition, not a disappearance.
   */
  upsertPlanParts(planId: string, parts: PlanPartInput[]): PlanPart[] {
    const ts = this.ctx.now();
    const existing = new Map(this.listPlanParts(planId).map((p) => [p.slug, p]));
    const rows = parts.map((input) => {
      const prev = existing.get(input.slug);
      const part: PlanPart = {
        id: `${planId}:${input.slug}`,
        planId,
        slug: input.slug,
        seq: input.seq,
        title: input.title,
        scope: input.scope,
        touches: input.touches,
        rationale: input.rationale,
        acceptance: input.acceptance,
        // A reviewer's confirmations, not the planner's declaration — so they
        // survive an amendment the way branch and PR do. What withdraws one is the
        // criterion itself changing, which the text key handles without a rule here.
        acceptanceMet: prev?.acceptanceMet ?? [],
        size: input.size,
        expectedKind: input.expectedKind,
        profile: input.profile,
        // Progress, not declaration — an amendment re-declaring a part must not
        // wipe an outcome it already reached. Same split as branch/prNumber below.
        outcomeKind: prev?.outcomeKind ?? null,
        outcomeRef: prev?.outcomeRef ?? null,
        outcomeSummary: prev?.outcomeSummary ?? null,
        dependsOn: input.dependsOn,
        branch: prev?.branch ?? null,
        prNumber: prev?.prNumber ?? null,
        // `retired` is the one status that is a *declaration verdict* rather than
        // progress: it says this document stopped declaring the slug. A document
        // that declares it again is delivering it again, so the retirement lifts —
        // otherwise a replan, which must reuse slugs, merges onto retired rows and
        // releases a plan with no live parts. Every other status is progress.
        status: prev?.status === 'retired' ? 'pending' : (prev?.status ?? 'pending'),
        // Progress like the outcome columns: it explains a status this call is not
        // allowed to change, so an amendment re-declaring a part leaves it alone —
        // except across the un-retirement above, where the status it explains is gone.
        blockedReason: prev?.status === 'retired' ? null : (prev?.blockedReason ?? null),
        blockedBy: prev?.status === 'retired' ? null : (prev?.blockedBy ?? null),
        taskId: prev?.taskId ?? null,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
      };
      return part;
    });
    const stmt = this.ctx.db.prepare(
      // The outcome columns are deliberately absent from DO UPDATE SET: they are
      // progress, and an amendment re-declaring a part must leave what it produced
      // alone. `expected_kind` is part of the declaration, so it does update, and so
      // do `touches` and `size`. `acceptance_met` is not a declaration at all — it
      // is a reviewer's confirmations — so it sits with the outcome columns.
      // `status` and `blocked_reason` *do* update, which is safe only because the
      // computed row already carries `prev`'s values for every case but the
      // un-retirement above: this write is the declaration lifting a retirement,
      // never the scheduler's progress being overwritten.
      `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, rationale, acceptance,
         acceptance_met, size, expected_kind, profile,
         outcome_kind, outcome_ref, outcome_summary, depends_on, branch, pr_number, status, blocked_reason,
         blocked_by, task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @touches, @rationale, @acceptance,
         @acceptanceMet, @size, @expectedKind, @profile,
         @outcomeKind, @outcomeRef, @outcomeSummary, @dependsOn, @branch, @prNumber, @status, @blockedReason,
         @blockedBy, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         touches=excluded.touches, rationale=excluded.rationale, acceptance=excluded.acceptance,
         size=excluded.size, expected_kind=excluded.expected_kind, profile=excluded.profile,
         depends_on=excluded.depends_on, status=excluded.status,
         blocked_reason=excluded.blocked_reason, blocked_by=excluded.blocked_by,
         updated_at=excluded.updated_at`,
    );
    const insertAll = this.ctx.db.transaction((all: PlanPart[]) => {
      for (const p of all)
        stmt.run({
          ...p,
          dependsOn: JSON.stringify(p.dependsOn),
          touches: JSON.stringify(p.touches),
          acceptanceMet: JSON.stringify(p.acceptanceMet),
        });
    });
    insertAll(rows);
    return rows;
  }

  listPlanParts(planId: string): PlanPart[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_parts WHERE plan_id=? ORDER BY seq ASC, slug ASC`)
      .all(planId) as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  /** Every part of every plan — what the dispatcher and the reconciler both walk. */
  listAllPlanParts(): PlanPart[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plan_parts ORDER BY plan_id ASC, seq ASC`).all() as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  /**
   * Move a part's *progress* — status, branch, PR, task — leaving its declaration
   * (seq/title/scope/dependsOn) to {@link upsertPlanParts}. The two halves of a part
   * row have different authors: the planner declares, the scheduler and the
   * reconciler record what happened. Returns null when the part is gone.
   */
  updatePlanPart(
    id: string,
    patch: {
      status?: PlanPart['status'];
      branch?: string | null;
      prNumber?: number | null;
      taskId?: string | null;
      blockedReason?: string | null;
    },
  ): PlanPart | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const next: PlanPart = {
      ...rowToPlanPart(row),
      ...patch,
      updatedAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status=@status, branch=@branch, pr_number=@prNumber, task_id=@taskId,
           blocked_reason=@blockedReason, blocked_by=@blockedBy, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        branch: next.branch,
        prNumber: next.prNumber,
        taskId: next.taskId,
        blockedReason: next.blockedReason,
        blockedBy: next.blockedBy,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  /**
   * Record which of a part's acceptance criteria a reviewer has confirmed.
   *
   * The whole set is written rather than one criterion toggled, for
   * `decideProposal`'s reason: the caller has the list it is looking at, and a
   * per-criterion toggle would have to agree with a text key it did not compute.
   * Returns null when the part is gone.
   */
  setPartAcceptanceMet(id: string, criteria: string[]): PlanPart | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE plan_parts SET acceptance_met=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(criteria), updatedAt, id);
    return { ...rowToPlanPart(row), acceptanceMet: criteria, updatedAt };
  }

  /**
   * Override which model profile one part's work runs on (issue #342) — the
   * operator's arm of a claim the planner made.
   *
   * Null clears it, and clearing is not the same as naming the goal's profile: a
   * cleared part *inherits*, so a later re-pin of the goal moves it too, while a
   * named one stays where it was put. That is the distinction a two-state
   * "overridden or not" flag would lose.
   *
   * Deliberately not guarded on status. A part already dispatched keeps the
   * profile its task row stored — resolution happened once, at dispatch — so
   * writing this only ever changes what a *future* dispatch of it costs, which is
   * exactly what an operator re-pricing a retry is asking for.
   */
  setPartProfile(id: string, profile: string | null): PlanPart | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE plan_parts SET profile=?, updated_at=? WHERE id=?`).run(profile, updatedAt, id);
    return { ...rowToPlanPart(row), profile, updatedAt };
  }

  /**
   * A part's agent actually spawned. Called from the executor *after* the spawn, for
   * the same reason `markJobDispatched` is: a dispatch the cap/pause gate holds
   * must leave the part `ready` for a later cycle, not claim it started.
   */
  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.updatePlanPart(id, { status: 'dispatched', taskId, branch });
  }

  /**
   * A part finished without a pull request — it produced a report, or determined
   * that nothing needed building.
   *
   * Its own method rather than an {@link updatePlanPart} patch, because the guard
   * *is* the point: the write is conditional on the part still being worked, so a
   * second call changes nothing and a merged or retired part cannot be re-labelled.
   * Idempotence in the write, not in a read-then-check somebody has to remember —
   * the same discipline as `decideProposal` and `link_ticket`.
   */
  concludePlanPart(
    id: string,
    outcome: { kind: PartOutcomeKind; ref: string | null; summary: string },
  ): PlanPart | null {
    const result = this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind=?, outcome_ref=?, outcome_summary=?, updated_at=?
         WHERE id=? AND status IN ('dispatched','in_review')`,
      )
      .run(outcome.kind, outcome.ref, outcome.summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  /**
   * A part a person owns finished, because the operator marked its human task
   * done. `concluded`, with `outcome_kind='human'` — the record of *what* closed
   * it, which is the whole reason `human` is a kind rather than a flag.
   *
   * Its own method rather than a {@link PlanStore.concludePlanPart} call, because
   * the guards are opposites and both are load-bearing. That one insists the part
   * was `dispatched` or `in_review`, which is exactly right for a part an agent
   * worked and exactly wrong here: a human part is never dispatched at all, so it
   * settles from `pending`, `ready` or `blocked`. Widening the other guard would
   * have let an agent conclude a part nobody had started.
   */
  concludeHumanPart(id: string, summary: string): PlanPart | null {
    const result = this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind='human', outcome_summary=?, blocked_reason=NULL,
           blocked_by=NULL, updated_at=? WHERE id=? AND status IN ('pending','ready','blocked')`,
      )
      .run(summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  /**
   * Move a plan to a new status, optionally rewriting the reason that goes with it.
   *
   * `reason` is optional and **preserved on absence**, like every other narrative
   * field on a plan: the planner's own words are what a replan amends, so a
   * transition that had no opinion about them must not clear them. The one caller
   * that passes it is a shortfall's replan arm (issue #159), which appends what an
   * assessment found — the summary reaches the replanning agent through
   * `currentPlanSummary`, which already renders this field, rather than through a
   * new prompt placeholder an operator override could silently drop.
   */
  setPlanStatus(id: string, status: PlanStatus, reason?: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    const next = reason ?? row.reason;
    this.ctx.db
      .prepare(`UPDATE plans SET status=?, reason=?, updated_at=? WHERE id=?`)
      .run(status, next, updatedAt, id);
    return { ...rowToPlan(row), status, reason: next, updatedAt };
  }

  /** Remember the provider comment id so the plan's status comment is edited, never re-posted. */
  setPlanStatusComment(id: string, ref: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE plans SET status_comment_ref=?, updated_at=? WHERE id=?`).run(ref, updatedAt, id);
    return { ...rowToPlan(row), statusCommentRef: ref, updatedAt };
  }

  /**
   * Fold a plan's part statuses back onto the plan: every part merged => `complete`,
   * anything outstanding after that => back to `active` (a replan can add work to a
   * finished plan). Returns the plan **only when the roll-up moved it**, so a caller
   * can treat the return as the "the plan just completed" edge rather than re-deriving
   * it. A partless plan — the single-PR arm, or one still `planning` — is never
   * touched: what finishes that arm is the issue's own delivery, not a roll-up. A
   * retired part is not outstanding work — an amended plan that dropped its last
   * unstarted part is complete, not stuck.
   */
  rollUpPlanStatus(planId: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRow | undefined;
    if (!row) return null;
    const plan = rowToPlan(row);
    if (plan.status !== 'active' && plan.status !== 'complete') return null;
    const parts = liveParts(this.listPlanParts(planId));
    if (parts.length === 0) return null;
    // Every terminal, not just merges: a part that concluded with a report or a
    // determination is finished, and counting only merges is what held a whole
    // decomposition open on the one part that found nothing to build.
    const next: PlanStatus = parts.every(partSettled) ? 'complete' : 'active';
    if (next === plan.status) return null;
    return this.setPlanStatus(planId, next);
  }
}

/**
 * Absorb the retired `single` plan status into `active`.
 *
 * `single` was a *shape* wearing a lifecycle status, and the two are not
 * exclusive: a plan being delivered as one pull request is still being delivered.
 * Every consumer that switched on status therefore had to know about the shape,
 * and the one that forgot — `PlanReconciler`, which lists only `active`,
 * `complete` and `awaiting_approval` — quietly excluded single-PR plans from
 * reconciliation, so their status comment was never written. The shape is now read
 * off the live parts (`planShape`), which every one of those rows already carries:
 * a `single` plan has none.
 *
 * A data migration rather than an `ensureColumns` entry — no column changes, the
 * values in one do. Unconditional and idempotent: a database with no such rows
 * updates none, and a second boot finds none left.
 */
export function absorbSinglePlanStatus(db: Database.Database): void {
  db.prepare(`UPDATE plans SET status='active' WHERE status='single'`).run();
}

/**
 * Give every partless plan the one part it always was.
 *
 * A plan delivering one pull request used to carry **no parts at all** — that was
 * the encoding of "single", and rule `issue-pickup` worked the issue whole on the
 * flat `issue/<n>` branch instead. Every plan has parts now, so those rows would
 * otherwise be scheduled by nothing: rule `issue-pickup` no longer looks at them
 * (the route is `parts`), rule `plan-part` finds no part to dispatch, and the
 * issue stops dead with no error anywhere. That silence is the whole reason this
 * exists — the migration is not a tidy-up, it is what stops a live goal parking
 * itself on the deploy that ships this.
 *
 * The backfilled part is an ordinary one in every respect but its branch:
 *
 * - **`branch` is the flat `issue/<n>`** for a plan that was already being
 *   delivered, because that is where the work is. Every reader resolves a part's
 *   branch as `part.branch ?? partBranch(n, slug)`, so pointing the column at the
 *   existing branch is enough to carry an open PR, a pushed commit and a running
 *   agent onto the part — the reconciler's `foldPr` picks the PR up on the next
 *   pulse and writes `in_review` or `merged` without being told. It also keeps the
 *   ref-collision guard quiet, which reads a part on the flat branch as being what
 *   is on it rather than as colliding with it.
 * - **`branch` is null before anything was scheduled** (`awaiting_approval`,
 *   `planning`), where no branch exists yet and the part should be cut in the
 *   normal namespace like any other.
 * - **`merged`** on a `complete` plan, so the roll-up that already decided the
 *   plan was finished still agrees; **`ready`** otherwise, so the part is picked
 *   up on the next pulse. A `ready` part on a branch an unplanned pickup is still
 *   working is held by the executor's existing branch lock rather than doubled.
 *
 * `abandoned` plans are skipped: nothing schedules them, so there is no silence to
 * fix, and inventing a part for work somebody stopped would put a row in the graph
 * claiming the opposite.
 *
 * A data migration rather than an `ensureColumns` entry — no column changes, the
 * rows in one do. Idempotent: a plan with any part row, retired ones included, is
 * left alone, so a second boot backfills nothing.
 */
export function backfillWholePlanParts(db: Database.Database, now: string): void {
  const orphans = db
    .prepare(
      `SELECT id, origin_ref, title, status FROM plans
        WHERE status <> 'abandoned'
          AND id NOT IN (SELECT DISTINCT plan_id FROM plan_parts)`,
    )
    .all() as { id: string; origin_ref: string; title: string; status: string }[];
  const insert = db.prepare(
    `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, rationale, acceptance,
       acceptance_met, size, expected_kind, profile, outcome_kind, outcome_ref, outcome_summary,
       depends_on, branch, pr_number, status, blocked_reason, blocked_by, task_id, created_at, updated_at)
     VALUES (@id, @planId, @slug, 1, @title, @scope, '[]', NULL, NULL,
       '[]', NULL, NULL, NULL, NULL, NULL, NULL,
       '[]', @branch, NULL, @status, NULL, NULL, NULL, @at, @at)`,
  );
  for (const plan of orphans) {
    const issueNumber = Number(/^issue:(\d+)$/.exec(plan.origin_ref)?.[1]);
    // A plan whose origin is not an issue has no flat branch to inherit and no
    // scheduler either; leaving it alone is the honest answer.
    if (!Number.isFinite(issueNumber)) continue;
    const started = plan.status === 'active' || plan.status === 'complete';
    insert.run({
      id: `${plan.id}:${WHOLE_PART_SLUG}`,
      planId: plan.id,
      slug: WHOLE_PART_SLUG,
      title: plan.title,
      scope: 'The whole issue — this plan was written before a plan had parts.',
      branch: started ? `issue/${issueNumber}` : null,
      status: plan.status === 'complete' ? 'merged' : 'ready',
      at: now,
    });
  }
}

/**
 * The slug a backfilled part gets. Fixed rather than derived so a plan the
 * migration touched is recognisable, and short enough to read in a branch name if
 * one is ever cut for it.
 */
const WHOLE_PART_SLUG = 'whole';

interface PlanRow {
  id: string;
  origin_ref: string;
  title: string;
  status: string;
  reason: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  diagnosis: string | null | undefined;
  approach: string | null | undefined;
  risks: string | null | undefined;
  out_of_scope: string | null | undefined;
  alternatives: string | null | undefined;
  open_questions: string | null | undefined;
  verification: string | null | undefined;
  evidence: string | null | undefined;
  document: string | null | undefined;
  status_comment_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRevisionRow {
  id: string;
  plan_id: string;
  seq: number;
  verdict: string;
  narrative: string;
  parts: string;
  at: string;
}

interface PlanPartRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  touches: string | null | undefined;
  rationale: string | null | undefined;
  acceptance: string | null | undefined;
  acceptance_met: string | null | undefined;
  size: string | null | undefined;
  expected_kind: string | null | undefined;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  profile: string | null | undefined;
  outcome_kind: string | null | undefined;
  outcome_ref: string | null | undefined;
  outcome_summary: string | null | undefined;
  depends_on: string;
  branch: string | null;
  pr_number: number | null;
  status: string;
  blocked_reason: string | null | undefined;
  blocked_by: string | null | undefined;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    originRef: r.origin_ref,
    title: r.title,
    status: r.status as PlanStatus,
    diagnosis: r.diagnosis ?? null,
    approach: r.approach ?? null,
    reason: r.reason,
    risks: r.risks ?? null,
    outOfScope: r.out_of_scope ?? null,
    alternatives: r.alternatives ?? null,
    openQuestions: r.open_questions ?? null,
    verification: r.verification ?? null,
    evidence: parseEvidence(r.evidence),
    document: r.document ?? null,
    statusCommentRef: r.status_comment_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToPlanPart(r: PlanPartRow): PlanPart {
  return {
    id: r.id,
    planId: r.plan_id,
    slug: r.slug,
    seq: r.seq,
    title: r.title,
    scope: r.scope,
    touches: parseStringArray(r.touches),
    rationale: r.rationale ?? null,
    acceptance: r.acceptance ?? null,
    acceptanceMet: parseStringArray(r.acceptance_met),
    size: partSizeOf(r.size),
    expectedKind: partOutcomeKindOf(r.expected_kind),
    profile: r.profile ?? null,
    outcomeKind: partOutcomeKindOf(r.outcome_kind),
    outcomeRef: r.outcome_ref ?? null,
    outcomeSummary: r.outcome_summary ?? null,
    // Written as JSON by upsertPlanParts; a corrupt value degrades to "no deps"
    // rather than throwing the whole snapshot away.
    dependsOn: parseDependsOn(r.depends_on),
    branch: r.branch,
    prNumber: r.pr_number,
    status: r.status as PlanPart['status'],
    blockedReason: r.blocked_reason ?? null,
    blockedBy: partBlockerOf(r.blocked_by),
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Narrowed rather than cast: these two columns are absent on older databases and
 * are the only part of the row a *human* can edit by hand, so an unrecognised
 * value degrades to "unstated" instead of putting a status nothing switches on
 * into the type.
 *
 * **A new {@link PartOutcomeKind} must be added here too**, and that is a sharp
 * edge rather than a chore: this narrowing is not a type guard the compiler
 * checks against the union, so a kind missing from it is written to SQLite, read
 * back as `null`, and silently reads as `code` everywhere downstream — a step for
 * a person would be handed to an agent. It cost one test to find and would have
 * cost a fleet to find in production.
 */
function partOutcomeKindOf(raw: string | null | undefined): PartOutcomeKind | null {
  return raw === 'code' || raw === 'report' || raw === 'determination' || raw === 'human' ? raw : null;
}

/** Narrowed for {@link partOutcomeKindOf}'s reason — absent on older databases, and hand-editable. */
function partSizeOf(raw: string | null | undefined): PartSize | null {
  return raw === 's' || raw === 'm' || raw === 'l' ? raw : null;
}

/**
 * Narrowed for {@link partOutcomeKindOf}'s reason, and the null it degrades to is
 * the reading a database from before the column has: *blocked, attribution
 * unstated*. {@link planIsWedged} counts one toward the wedge exactly as it did
 * when there was nothing to count — an unattributed block is the pre-column
 * behaviour, which is the direction that keeps a real collision escalating.
 */
function partBlockerOf(raw: string | null | undefined): PlanPartBlocker | null {
  return raw === 'collision' || raw === 'declined' ? raw : null;
}

function parseDependsOn(raw: string): string[] {
  return parseStringArray(raw);
}

/**
 * A JSON string array column, degrading to empty rather than throwing. Absent
 * (an older database) and corrupt reach the same answer deliberately: neither is
 * worth taking a whole snapshot down for, and "declared nothing" is the truthful
 * reading of both.
 */
function parseStringArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** The citation list, degrading per entry: one malformed row must not lose the rest. */
function parseEvidence(raw: string | null | undefined): PlanEvidence[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PlanEvidence[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { path, line, note } = entry as Record<string, unknown>;
      if (typeof path !== 'string' || path === '') return [];
      return [
        {
          path,
          line: typeof line === 'number' ? line : null,
          note: typeof note === 'string' ? note : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function rowToRevision(r: PlanRevisionRow): PlanRevision {
  return {
    id: r.id,
    planId: r.plan_id,
    seq: r.seq,
    narrative: parseNarrative(r.narrative),
    parts: parseRevisionParts(r.parts),
    at: r.at,
  };
}

/**
 * A revision's stored prose. Every field degrades independently: these rows are
 * written by one function and read by a view, so a shape that surprises the reader
 * should cost that field rather than the history.
 */
function parseNarrative(raw: string): PlanNarrative {
  const empty: PlanNarrative = {
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    document: null,
    evidence: [],
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const bag = parsed as Record<string, unknown>;
    const text = (key: keyof PlanNarrative): string | null => (typeof bag[key] === 'string' ? bag[key] : null);
    return {
      reason: text('reason'),
      diagnosis: text('diagnosis'),
      approach: text('approach'),
      risks: text('risks'),
      outOfScope: text('outOfScope'),
      alternatives: text('alternatives'),
      openQuestions: text('openQuestions'),
      verification: text('verification'),
      document: text('document'),
      evidence: parseEvidence(JSON.stringify(bag.evidence ?? [])),
    };
  } catch {
    return empty;
  }
}

/** A revision's declared parts, per entry, for {@link parseEvidence}'s reason. */
function parseRevisionParts(raw: string): PlanPartInput[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry, index): PlanPartInput[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const bag = entry as Record<string, unknown>;
      if (typeof bag.slug !== 'string' || bag.slug === '') return [];
      const text = (key: string): string | null => (typeof bag[key] === 'string' ? bag[key] : null);
      return [
        {
          slug: bag.slug,
          seq: typeof bag.seq === 'number' ? bag.seq : index + 1,
          title: text('title') ?? bag.slug,
          scope: text('scope') ?? '',
          touches: parseStringArray(JSON.stringify(bag.touches ?? [])),
          dependsOn: parseStringArray(JSON.stringify(bag.dependsOn ?? [])),
          rationale: text('rationale'),
          acceptance: text('acceptance'),
          size: partSizeOf(text('size')),
          expectedKind: partOutcomeKindOf(text('expectedKind')),
          profile: text('profile'),
        },
      ];
    });
  } catch {
    return [];
  }
}
