import { nextCheckLetter } from '../validation/checkDocument.js';
import type {
  ValidationAmendment,
  ValidationAmendResult,
  ValidationCheck,
  ValidationCheckActor,
  ValidationCheckInput,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceInput,
  ValidationResourceKind,
  ValidationRevision,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `validation_checks` gained the revision band — the wording an amendment
 * replaced, the reading it withdrew and why — after both tables shipped, which
 * is exactly the case the empty declaration here was written for: `CREATE TABLE
 * IF NOT EXISTS` never alters an existing table, so without these three entries
 * every database from before the amendment tool would read `undefined` for all
 * of them and silently draw no band at all.
 *
 * `actor` and `handback_note` arrived the change after that, with the fleet
 * hand-over, and fail the same way without an entry: every existing check would
 * read `undefined` for `actor`, and a column whose absence means "human" is one
 * whose absence is invisible — the hand-over control would simply never take.
 *
 * `claimed_by` and `claimed_at` arrived with the desktop channel and are the
 * quietest of the three. Their absence reads as "nothing is claimed", which is
 * true of every database that predates them and stays true forever afterwards:
 * the claim would never be written, so the fleet would keep dispatching checks a
 * person was in the middle of running — the exact collision the claim exists to
 * prevent, on precisely the deployments that upgraded rather than started fresh.
 */
export const VALIDATION_COLUMNS: ColumnMigrations = {
  validation_checks: {
    revision: 'TEXT',
    amended_at: 'TEXT',
    amend_note: 'TEXT',
    actor: 'TEXT',
    handback_note: 'TEXT',
    claimed_by: 'TEXT',
    claimed_at: 'TEXT',
  },
  validation_resources: {},
};

/**
 * The `validation_checks` and `validation_resources` tables: how anyone checks
 * that a *goal* was met, and what they need in order to.
 *
 * One module rather than two because a check names its resources by name and
 * {@link ValidationStore.ingestValidation} writes both halves of one document in
 * one act — splitting them would put a single write across a module boundary and
 * buy nothing.
 *
 * **The result is columns on the check, not a table.** One row per report would
 * be an audit trail, and that trail already exists: every result is a tool call
 * or a route call in the record beside it. Exactly one current reading is kept,
 * `note_progress`'s argument — and a re-run overwrites, which is what a re-run
 * means.
 *
 * Two writers fold a change onto these rows, and the difference between them is
 * the load-bearing one:
 *
 * - {@link ValidationStore.ingestValidation} reads a plan document, which declares
 *   the **whole** check set. A check it omits was withdrawn.
 * - {@link ValidationStore.amendValidation} reads one agent's correction, which
 *   declares **only what it is changing**. A check it omits is untouched, and a
 *   withdrawal is said out loud with a reason.
 *
 * Collapsing them would mean an agent sending a two-check correction silently
 * supersedes the other six.
 */
export class ValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Fold a document's validation block onto a plan's rows, **merging on check
   * id** — the same discipline `upsertPlanParts` applies to a part's slug, for
   * the same reason: an amendment must be able to re-declare a check without
   * withdrawing what somebody already recorded about it.
   *
   * Three rules do the work, and each is the answer to a way this goes wrong
   * silently:
   *
   * - **A letter is assigned once and never reused.** New checks take the next
   *   free letter over every letter this plan has ever issued, superseded ones
   *   included, so `284:C` names the same check for the life of the goal.
   * - **A reworded check loses its result.** `acceptanceCriteria`'s rule exactly:
   *   an amendment that changes what a pass means has withdrawn the thing that
   *   was confirmed. Rewording is also how a check quietly becomes easier, and a
   *   result carried across one is a pass against wording nobody read.
   * - **A dropped check is superseded, never deleted.** It stays, out of the
   *   verdict and greyed, exactly as a part an amended plan no longer declares is
   *   retired rather than removed — and it is what keeps its letter taken.
   */
  ingestValidation(
    planId: string,
    input: {
      checks: ValidationCheckInput[];
      resources: ValidationResourceInput[];
      supersededReason: string;
      /** What the band says when this ingestion is a *re*-reading rather than the plan's first. */
      amendNote: string;
    },
  ): ValidationCheck[] {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(planId);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(input.checks.map((c) => c.id));
    // A plan's *first* validation block is a declaration, not an amendment: every
    // check in it is new, and banding all of them would make the one signal that
    // says "this is not the check you read" fire on a plan nobody has read yet.
    const amendNote = existing.length === 0 ? null : input.amendNote;

    const rows = input.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      return this.mergeCheck({ planId, prev, input: check, letter, ts, amendNote });
    });

    const write = this.ctx.db.transaction((all: ValidationCheck[]) => {
      for (const row of all) this.writeCheck(row);
      for (const check of existing) {
        if (declared.has(check.id) || check.supersededReason !== null) continue;
        this.ctx.db
          .prepare(`UPDATE validation_checks SET superseded_reason=?, updated_at=? WHERE plan_id=? AND id=?`)
          .run(input.supersededReason, ts, planId, check.id);
      }
    });
    write(rows);
    this.replaceValidationResources(planId, input.resources);
    return rows;
  }

  /**
   * Apply one agent's correction to a plan's validation block.
   *
   * **Nothing is withdrawn by omission.** That is the one rule, and it is what
   * makes this safe to hand to an agent that has not read the whole plan: a
   * correction names the checks it is changing, and every check it does not name
   * is left exactly as it is. `ingestValidation` reads a document that speaks for
   * the whole set and may therefore supersede by silence; an agent halfway
   * through a part cannot, because it would only have to be terse to delete the
   * validation plan it is failing.
   *
   * A withdrawal is therefore explicit and carries its own reason, and it
   * supersedes rather than deletes for `ingestValidation`'s reason: **an agent
   * that cannot pass a check must not be able to make it disappear.**
   */
  amendValidation(planId: string, amendment: ValidationAmendment): ValidationAmendResult {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(planId);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(amendment.checks.map((c) => c.id));
    let lastSeq = existing.reduce((max, c) => Math.max(max, c.seq), 0);

    const result: ValidationAmendResult = { added: [], reworded: [], unchanged: [], withdrawn: [], unknown: [] };
    const rows = amendment.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      // A re-declared check keeps its position; a new one goes after the last.
      // Reading the position off the amendment's own order instead would file a
      // two-check correction at the top of a nine-check plan.
      const seq = prev?.seq ?? (lastSeq += 1);
      const row = this.mergeCheck({
        planId,
        prev,
        input: { ...check, seq },
        letter,
        ts,
        amendNote: amendment.note,
      });
      // "Now live and was not" covers both a new id and one an earlier amendment
      // had withdrawn: from the operator's side those are the same news, and the
      // restored check keeps its letter either way.
      if (prev === undefined || prev.supersededReason !== null) result.added.push(row);
      else if (isReworded(prev, check)) result.reworded.push(row);
      else result.unchanged.push(row.id);
      return row;
    });

    const write = this.ctx.db.transaction(() => {
      for (const row of rows) this.writeCheck(row);
      for (const { id, reason } of amendment.withdraw) {
        const prev = byId.get(id);
        // Reported rather than silently ignored: an agent that withdrew a check
        // by a name this plan has never held would otherwise believe it landed.
        // Re-declaring and withdrawing the same id in one call is refused at the
        // schema, so this arm cannot contradict the loop above.
        if (!prev || prev.supersededReason !== null || declared.has(id)) {
          result.unknown.push(id);
          continue;
        }
        this.ctx.db
          .prepare(
            `UPDATE validation_checks SET superseded_reason=?, amend_note=?, amended_at=?, updated_at=?
             WHERE plan_id=? AND id=?`,
          )
          .run(reason, amendment.note, ts, ts, planId, id);
        result.withdrawn.push(id);
      }
    });
    write();
    this.upsertValidationResources(planId, amendment.resources);
    return result;
  }

  /**
   * One check as an ingestion or an amendment leaves it — the merge both writers
   * share, so neither can develop its own opinion about what rewording costs.
   *
   * `amendNote` null means "this reading is the first", and is what keeps a
   * plan's opening declaration from banding every check it contains.
   */
  private mergeCheck(args: {
    planId: string;
    prev: ValidationCheck | undefined;
    input: ValidationCheckInput;
    letter: string;
    ts: string;
    amendNote: string | null;
  }): ValidationCheck {
    const { planId, prev, input, letter, ts, amendNote } = args;
    const reworded = prev !== undefined && isReworded(prev, input);
    const keep = prev !== undefined && !reworded;
    // What the operator is owed a word about: a check that appeared, one that came
    // back, and one that no longer says what it said. A re-declaration with
    // identical wording is none of those, and banding it would make a replan that
    // changed one check shout about all nine.
    const changed = prev === undefined || reworded || prev.supersededReason !== null;
    const band = amendNote !== null && changed;
    return {
      planId,
      id: input.id,
      letter,
      seq: input.seq,
      title: input.title,
      do: input.do,
      expect: input.expect,
      uses: input.uses,
      covers: input.covers,
      fleetCandidate: input.fleetCandidate,
      candidateWhy: input.candidateWhy,
      // The hand-over is withdrawn by exactly what withdraws the result, and for
      // the same reason: both were decisions an operator made about wording that
      // no longer exists. A check reworded to say "log into the test environment"
      // and still assigned to the fleet would be run by an agent nobody handed it
      // to — and the amendment band is already in front of the operator, saying
      // what changed, which is where the decision to hand it over again belongs.
      actor: keep ? prev.actor : 'human',
      handbackNote: keep ? prev.handbackNote : null,
      // Dropped by the same predicate, and it is the same argument one step
      // further on: somebody is running this check *right now* against wording
      // that no longer exists. Releasing the claim is what lets them re-take it
      // against the current wording and see the amendment band while they do.
      claimedBy: keep ? prev.claimedBy : null,
      claimedAt: keep ? prev.claimedAt : null,
      state: keep ? prev.state : 'unrun',
      resultNote: keep ? prev.resultNote : null,
      resultBy: keep ? prev.resultBy : null,
      resultAt: keep ? prev.resultAt : null,
      deferUntil: keep ? prev.deferUntil : null,
      // A re-declared check is being asked for again, whatever an earlier
      // amendment did with it.
      supersededReason: null,
      // Only a *reworded* check has wording to keep; an added one has none, and
      // its band says so by carrying no revision.
      revision: band ? (reworded && prev !== undefined ? priorWording(prev) : null) : (prev?.revision ?? null),
      // Carried rather than cleared on an untouched check: an operator who has not
      // yet seen the last amendment must not have it wiped by the next replan that
      // happens to re-state the same words.
      amendedAt: band ? ts : (prev?.amendedAt ?? null),
      amendNote: band ? amendNote : (prev?.amendNote ?? null),
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
  }

  /**
   * Replace a plan's declared resources wholesale.
   *
   * A replace rather than a merge, unlike the checks above, because a resource
   * carries nothing an operator recorded — it is a declaration and only a
   * declaration. The one thing it does accumulate is the ask filed for an
   * unprovided one, and that is carried across by name so a replan does not file
   * the same request twice.
   */
  private replaceValidationResources(planId: string, resources: ValidationResourceInput[]): void {
    const existing = new Map(this.listValidationResources(planId).map((r) => [r.name, r]));
    const write = this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`DELETE FROM validation_resources WHERE plan_id=?`).run(planId);
      for (const resource of resources) {
        this.writeResource(planId, resource, existing.get(resource.name)?.humanTaskId ?? null);
      }
    });
    write();
  }

  /**
   * Merge an amendment's resources by name, adding and updating but never
   * removing — an amendment speaks only for what it names, `amendValidation`'s
   * rule, and here it is load-bearing twice over: a resource dropped by omission
   * would be dropped out from under whichever *other* check still lists it in
   * `uses`, and that check would then render with no fixture and no explanation.
   */
  private upsertValidationResources(planId: string, resources: ValidationResourceInput[]): void {
    if (resources.length === 0) return;
    const existing = new Map(this.listValidationResources(planId).map((r) => [r.name, r]));
    const write = this.ctx.db.transaction(() => {
      for (const resource of resources) {
        this.writeResource(planId, resource, existing.get(resource.name)?.humanTaskId ?? null);
      }
    });
    write();
  }

  private writeResource(planId: string, resource: ValidationResourceInput, humanTaskId: string | null): void {
    this.ctx.db
      .prepare(
        `INSERT INTO validation_resources (plan_id, name, kind, note, provided, human_task_id)
         VALUES (@planId, @name, @kind, @note, @provided, @humanTaskId)
         ON CONFLICT(plan_id, name) DO UPDATE SET kind=excluded.kind, note=excluded.note,
           provided=excluded.provided, human_task_id=excluded.human_task_id`,
      )
      .run({
        planId,
        name: resource.name,
        kind: resource.kind,
        note: resource.note,
        provided: resource.provided ? 1 : 0,
        humanTaskId,
      });
  }

  /** Remember the ask filed for an unprovided resource, so a replan does not file it twice. */
  linkValidationResourceTask(planId: string, name: string, humanTaskId: string): void {
    this.ctx.db
      .prepare(`UPDATE validation_resources SET human_task_id=? WHERE plan_id=? AND name=?`)
      .run(humanTaskId, planId, name);
  }

  /** A plan's checks in declaration order, superseded ones included — the record is the point. */
  listValidationChecks(planId: string): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE plan_id=? ORDER BY seq ASC, letter ASC`)
      .all(planId) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  /** Every check of every plan — what the snapshot and the close-out sweep both fold. */
  listAllValidationChecks(): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks ORDER BY plan_id ASC, seq ASC`)
      .all() as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  /**
   * One live check, or null — the read every writer that has to *decide* before
   * it writes shares, so the hand-over route and the reporting tool cannot come
   * to different conclusions about what a check currently says.
   *
   * Live only, on {@link ValidationStore.recordValidationResult}'s terms: a check
   * its plan has withdrawn is not one to hand over, run or report on.
   */
  getValidationCheck(planId: string, checkId: string): ValidationCheck | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE plan_id=? AND id=? AND superseded_reason IS NULL`)
      .get(planId, checkId) as ValidationCheckRow | undefined;
    return row ? rowToCheck(row) : null;
  }

  /**
   * Hand a check to the fleet, or take it back. **The operator's act and nobody
   * else's** — no document, no amendment and no agent reaches this, which is what
   * keeps "an agent may run this" a statement about the deployment rather than a
   * planner's guess about it.
   *
   * Handing it over clears any previous hand-back: the operator has read why the
   * fleet gave it up and is sending it again anyway, so leaving the old reason
   * standing beside a check that is now in flight would describe the wrong
   * attempt.
   */
  setValidationActor(planId: string, checkId: string, actor: ValidationCheckActor): ValidationCheck | null {
    const current = this.getValidationCheck(planId, checkId);
    if (!current) return null;
    const next: ValidationCheck = {
      ...current,
      actor,
      handbackNote: actor === 'fleet' ? null : current.handbackNote,
      updatedAt: this.ctx.now(),
    };
    this.writeCheck(next);
    return next;
  }

  /**
   * The fleet giving a check back: it could not run this, and here is why.
   *
   * **It records no reading.** The state is left exactly as it was, because that
   * is the honest answer — an agent that could not reach the environment has not
   * found anything out about the goal, and `failed` would flag it for a reason
   * that has nothing to do with the code. That refusal is the whole point of
   * having a third answer: without it the only ways to end a dispatch are a lie
   * and silence.
   */
  recordValidationHandback(planId: string, checkId: string, note: string): ValidationCheck | null {
    const current = this.getValidationCheck(planId, checkId);
    if (!current) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...current,
      actor: 'human',
      handbackNote: note,
      // Whoever gave it back is done with it, so the claim goes with them. A
      // hand-back that left the claim standing would block the check against the
      // one thing it is now waiting for — somebody else picking it up.
      claimedBy: null,
      claimedAt: null,
      updatedAt: ts,
    };
    this.writeCheck(next);
    return next;
  }

  /**
   * Take the one live desktop claim for a check, or say who already holds it.
   *
   * **One claim at a time, across every plan.** Not a lock per check: the
   * operator's constraint is that they can only run one branch at once, so a
   * second check claimed while the first is live is two things reaching for the
   * same working copy. The refusal names the check that holds it, which is the
   * only thing the caller needs in order to fix it.
   *
   * Whole thing in one synchronous method for the store's usual reason — the
   * search, the decision and the write happen with nothing between them, so two
   * sessions racing cannot both read "nothing is claimed".
   *
   * `staleBefore` is the caller's clock policy, not this method's: a claim taken
   * before it holds nothing, because the session that took it is gone in a way no
   * socket close reported.
   */
  claimValidationCheck(
    planId: string,
    checkId: string,
    holder: string,
    staleBefore: string,
  ):
    | { ok: true; check: ValidationCheck; tookOverFrom: string | null }
    | { ok: false; reason: 'gone' }
    | { ok: false; reason: 'held'; by: ValidationCheck } {
    const target = this.getValidationCheck(planId, checkId);
    if (!target) return { ok: false, reason: 'gone' };
    const live = this.liveClaims(staleBefore);
    const other = live.find((c) => c.planId !== planId || c.id !== checkId);
    if (other) return { ok: false, reason: 'held', by: other };
    // Re-claiming what you already hold is not a conflict, and saying so beats
    // refusing: a session whose bridge reconnected mid-run would otherwise be
    // locked out by its own claim.
    const tookOverFrom = target.claimedBy !== null && target.claimedBy !== holder ? target.claimedBy : null;
    const ts = this.ctx.now();
    const next: ValidationCheck = { ...target, claimedBy: holder, claimedAt: ts, updatedAt: ts };
    this.writeCheck(next);
    return { ok: true, check: next, tookOverFrom };
  }

  /** Give a claimed check back, whoever holds it. Idempotent — releasing an unclaimed check is a no-op. */
  releaseValidationClaim(planId: string, checkId: string): ValidationCheck | null {
    const current = this.getValidationCheck(planId, checkId);
    if (!current || current.claimedBy === null) return current;
    const next: ValidationCheck = { ...current, claimedBy: null, claimedAt: null, updatedAt: this.ctx.now() };
    this.writeCheck(next);
    return next;
  }

  /**
   * Every check whose claim is still live at `staleBefore` — live rows only, and
   * expired claims excluded, so a caller never has to decide what "claimed" means
   * for itself. Normally at most one; more than one is only reachable from a
   * database edited by hand, and the caller that cares takes the first.
   */
  liveClaims(staleBefore: string): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM validation_checks
         WHERE claimed_by IS NOT NULL AND claimed_at > ? AND superseded_reason IS NULL
         ORDER BY claimed_at ASC`,
      )
      .all(staleBefore) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  listValidationResources(planId: string): ValidationResource[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_resources WHERE plan_id=? ORDER BY name ASC`)
      .all(planId) as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  listAllValidationResources(): ValidationResource[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_resources ORDER BY plan_id ASC, name ASC`)
      .all() as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  /**
   * Record what somebody concluded about a check — a result, a deferral, a
   * waiver, or the return to `unrun` that undoes any of them.
   *
   * One method for all five transitions because they are one write: a check has
   * exactly one current reading, and a state change that left the previous
   * state's note standing would render "passed — the environment is rebuilt on
   * Thursday". Everything not carried is cleared, in the write rather than in a
   * caller that has to remember.
   *
   * **A result is declared, never derived.** Nothing here infers a pass from a
   * green build, a merged pull request or an absence of errors — the refusal
   * `conclude_part` makes about `code`, for its reason: a positive terminal
   * inferred from incidental evidence is a check nobody ran, recorded as one that
   * passed.
   *
   * Refuses a superseded check (returns null): its plan has withdrawn it, so
   * there is nothing left to report about.
   */
  recordValidationResult(
    planId: string,
    checkId: string,
    input: {
      state: ValidationCheckState;
      note: string | null;
      by: ValidationCheckResultBy | null;
      until?: string | null;
    },
  ): ValidationCheck | null {
    const current = this.getValidationCheck(planId, checkId);
    if (!current) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...current,
      state: input.state,
      resultNote: input.note,
      resultBy: input.by,
      // The instant a reading was taken, and cleared with it: an `unrun` check
      // carrying a timestamp reads as one that was run and forgotten.
      resultAt: input.state === 'unrun' ? null : ts,
      deferUntil: input.state === 'deferred' ? (input.until ?? null) : null,
      // The band is answered, not just seen. It exists to say "this is not the
      // check you ran", and somebody who has just recorded a reading against the
      // current wording has been told — including on a reset, which is still an
      // operator act on the check as it now reads.
      revision: null,
      amendedAt: null,
      amendNote: null,
      // Answered for the band's reason, and the same one: it says why the last
      // dispatch came to nothing, and somebody who has since recorded a reading
      // has moved past it.
      handbackNote: null,
      // The reading is in; the run is over. Held open, the claim would keep the
      // operator's one-at-a-time budget spent on a check nobody is running.
      claimedBy: null,
      claimedAt: null,
      updatedAt: ts,
    };
    this.writeCheck(next);
    return next;
  }

  private writeCheck(check: ValidationCheck): void {
    this.ctx.db
      .prepare(
        // `check_do` rather than `do`: DO is a SQLite keyword (UPSERT), and an
        // unquoted column named for one is a syntax error at prepare time.
        // `check_expect` follows it so the pair reads as a pair.
        `INSERT INTO validation_checks (plan_id, id, letter, seq, title, check_do, check_expect, uses, covers,
           fleet_candidate, candidate_why, actor, handback_note, claimed_by, claimed_at, state, result_note,
           result_by, result_at, defer_until, superseded_reason, revision, amended_at, amend_note, created_at,
           updated_at)
         VALUES (@planId, @id, @letter, @seq, @title, @do, @expect, @uses, @covers,
           @fleetCandidate, @candidateWhy, @actor, @handbackNote, @claimedBy, @claimedAt, @state, @resultNote,
           @resultBy, @resultAt, @deferUntil, @supersededReason, @revision, @amendedAt, @amendNote, @createdAt,
           @updatedAt)
         ON CONFLICT(plan_id, id) DO UPDATE SET letter=excluded.letter, seq=excluded.seq, title=excluded.title,
           check_do=excluded.check_do, check_expect=excluded.check_expect, uses=excluded.uses,
           covers=excluded.covers, fleet_candidate=excluded.fleet_candidate,
           candidate_why=excluded.candidate_why, actor=excluded.actor,
           handback_note=excluded.handback_note, claimed_by=excluded.claimed_by,
           claimed_at=excluded.claimed_at, state=excluded.state, result_note=excluded.result_note,
           result_by=excluded.result_by, result_at=excluded.result_at, defer_until=excluded.defer_until,
           superseded_reason=excluded.superseded_reason, revision=excluded.revision,
           amended_at=excluded.amended_at, amend_note=excluded.amend_note, updated_at=excluded.updated_at`,
      )
      .run({
        ...check,
        uses: JSON.stringify(check.uses),
        covers: JSON.stringify(check.covers),
        fleetCandidate: check.fleetCandidate ? 1 : 0,
        revision: check.revision === null ? null : JSON.stringify(check.revision),
      });
  }
}

/**
 * Whether an amendment changed **what running this check involves**.
 *
 * Deliberately not `uses`/`covers`/`fleetCandidate`: those are references and a
 * suggestion, and a plan that fixed a mistyped resource name has not changed what
 * a pass means. Widening this would withdraw a result every time a planner
 * tidied a bibliography.
 */
function isReworded(prev: ValidationCheck, next: ValidationCheckAmendmentLike): boolean {
  return prev.title !== next.title || prev.do !== next.do || prev.expect !== next.expect;
}

/** The wording half of {@link isReworded}'s comparison — every writer of a check has these. */
interface ValidationCheckAmendmentLike {
  title: string;
  do: string;
  expect: string;
}

/** What a check said, and what somebody had concluded from it, at the moment it was rewritten. */
function priorWording(prev: ValidationCheck): ValidationRevision {
  return {
    title: prev.title,
    do: prev.do,
    expect: prev.expect,
    // `unrun` is not a reading, so an amendment to one withdrew nothing and the
    // band must not claim it did.
    state: prev.state === 'unrun' ? null : prev.state,
    note: prev.resultNote,
  };
}

interface ValidationCheckRow {
  plan_id: string;
  id: string;
  letter: string;
  seq: number;
  title: string;
  check_do: string;
  check_expect: string;
  uses: string;
  covers: string;
  fleet_candidate: number;
  candidate_why: string | null;
  /** Added with the fleet hand-over — `undefined` on a database that predates it; see {@link VALIDATION_COLUMNS}. */
  actor: string | null | undefined;
  handback_note: string | null | undefined;
  /** Added with the desktop channel — `undefined` on a database that predates it. */
  claimed_by: string | null | undefined;
  claimed_at: string | null | undefined;
  state: string;
  result_note: string | null;
  result_by: string | null;
  result_at: string | null;
  defer_until: string | null;
  superseded_reason: string | null;
  /** Added after the table shipped — `undefined` on a database that predates `VALIDATION_COLUMNS`' entry. */
  revision: string | null | undefined;
  amended_at: string | null | undefined;
  amend_note: string | null | undefined;
  created_at: string;
  updated_at: string;
}

interface ValidationResourceRow {
  plan_id: string;
  name: string;
  kind: string | null;
  note: string | null;
  provided: number;
  human_task_id: string | null;
}

function rowToCheck(r: ValidationCheckRow): ValidationCheck {
  return {
    planId: r.plan_id,
    id: r.id,
    letter: r.letter,
    seq: r.seq,
    title: r.title,
    do: r.check_do,
    expect: r.check_expect,
    uses: parseStringArray(r.uses),
    covers: parseStringArray(r.covers),
    fleetCandidate: r.fleet_candidate === 1,
    candidateWhy: r.candidate_why,
    // Anything that is not the word `fleet` is a human's check, which is the
    // direction a value this does not recognise must fail in: an unreadable
    // column becoming a hand-over would dispatch an agent nobody asked for.
    actor: r.actor === 'fleet' ? 'fleet' : 'human',
    handbackNote: r.handback_note ?? null,
    // A claim needs both halves to mean anything — the holder to name it and the
    // timestamp to expire it — so a row carrying one without the other is read as
    // claimed by nobody. That is the safe direction here: an unreadable claim
    // becoming live would block the fleet from a check forever.
    claimedBy: r.claimed_by !== null && r.claimed_by !== undefined && r.claimed_at ? r.claimed_by : null,
    claimedAt: r.claimed_by !== null && r.claimed_by !== undefined && r.claimed_at ? r.claimed_at : null,
    state: checkStateOf(r.state),
    resultNote: r.result_note,
    resultBy: resultByOf(r.result_by),
    resultAt: r.result_at,
    deferUntil: r.defer_until,
    supersededReason: r.superseded_reason,
    revision: parseRevision(r.revision ?? null),
    amendedAt: r.amended_at ?? null,
    amendNote: r.amend_note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Narrowed rather than cast, `partOutcomeKindOf`'s discipline and its sharp edge:
 * this is not a type guard the compiler checks against the union, so **a new
 * {@link ValidationCheckState} must be added here too**. One missing from it is
 * written to SQLite, read back as `unrun`, and a check somebody passed silently
 * flags its goal forever.
 */
function checkStateOf(raw: string): ValidationCheckState {
  return raw === 'passed' || raw === 'failed' || raw === 'waived' || raw === 'deferred' ? raw : 'unrun';
}

/**
 * Narrowed for {@link checkStateOf}'s reason, and the failure is the one the
 * attribution exists to prevent: a word this does not know reads as null, which
 * draws *no* marker — and no marker means "a person ran this". A new
 * {@link ValidationCheckResultBy} missing from here silently upgrades an agent's
 * reading to a human's.
 */
function resultByOf(raw: string | null): ValidationCheckResultBy | null {
  return raw === 'operator' || raw === 'agent' || raw === 'desktop' ? raw : null;
}

/** Narrowed for {@link checkStateOf}'s reason; null is the honest reading of a word this does not know. */
function resourceKindOf(raw: string | null): ValidationResourceKind | null {
  return raw === 'fixture' || raw === 'access' || raw === 'reference' || raw === 'data' ? raw : null;
}

function rowToResource(r: ValidationResourceRow): ValidationResource {
  return {
    planId: r.plan_id,
    name: r.name,
    kind: resourceKindOf(r.kind),
    note: r.note,
    provided: r.provided === 1,
    humanTaskId: r.human_task_id,
  };
}

/**
 * The revision column, degrading to null rather than throwing — `parseStringArray`'s
 * rule. A band nobody can draw is a band that is not drawn; a throw here would take
 * the whole plan sheet with it.
 */
function parseRevision(raw: string | null): ValidationRevision | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.title !== 'string' || typeof r.do !== 'string' || typeof r.expect !== 'string') return null;
    // `unrun` is not a reading, so it is not one this can read back either —
    // {@link priorWording} never writes it, and normalising rather than trusting
    // the column keeps the invariant true of rows however they got there.
    const state = typeof r.state === 'string' ? checkStateOf(r.state) : null;
    return {
      title: r.title,
      do: r.do,
      expect: r.expect,
      state: state === 'unrun' ? null : state,
      note: typeof r.note === 'string' ? r.note : null,
    };
  } catch {
    return null;
  }
}

/** A JSON string array column, degrading to empty rather than throwing — `parseStringArray`'s rule. */
function parseStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
