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
import type { ColumnMigrations, TableRebuild } from './migrate.js';
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
 * Both tables were keyed on `plan_id` and are now keyed on the goal's
 * `origin_ref`, which is not a change any `ALTER TABLE` can make.
 *
 * The old key resolves through the plans table, and every check has one to
 * resolve through: the funnel is unconditional, so a goal that has checks has a
 * plan ([08](../../docs/spec/08-planning.md)). A row whose plan is *gone* is
 * dropped by the join rather than carried under a made-up key — it can no longer
 * name a goal, and a check keyed on nothing is worse than one that is not there.
 *
 * **`id` and `letter` come across untouched**, which is the whole risk in this
 * rebuild. They are the merge key and the handle a person types; renumbering
 * either would silently invalidate every amendment that names a check and every
 * reading already recorded against one.
 */
export const VALIDATION_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'validation_checks',
    keyedOn: 'plan_id',
    copy: (old) => `
      INSERT INTO validation_checks
        (origin_ref, id, letter, seq, title, check_do, check_expect, uses, covers, fleet_candidate,
         candidate_why, actor, handback_note, claimed_by, claimed_at, state, result_note, result_by,
         result_at, defer_until, superseded_reason, revision, amended_at, amend_note, created_at, updated_at)
      SELECT p.origin_ref, c.id, c.letter, c.seq, c.title, c.check_do, c.check_expect, c.uses, c.covers,
             c.fleet_candidate, c.candidate_why, c.actor, c.handback_note, c.claimed_by, c.claimed_at,
             c.state, c.result_note, c.result_by, c.result_at, c.defer_until, c.superseded_reason,
             c.revision, c.amended_at, c.amend_note, c.created_at, c.updated_at
        FROM ${old} c JOIN plans p ON p.id = c.plan_id`,
  },
  {
    table: 'validation_resources',
    keyedOn: 'plan_id',
    copy: (old) => `
      INSERT INTO validation_resources (origin_ref, name, kind, note, provided, human_task_id)
      SELECT p.origin_ref, r.name, r.kind, r.note, r.provided, r.human_task_id
        FROM ${old} r JOIN plans p ON p.id = r.plan_id`,
  },
];

/**
 * The `validation_checks` and `validation_resources` tables: how anyone checks
 * that a *goal* was met, and what they need in order to. One module because
 * {@link ValidationStore.ingestValidation} writes both halves of one document in
 * one act.
 *
 * **The result is columns on the check, not a table** — exactly one current
 * reading is kept, and a re-run overwrites.
 *
 * Two writers fold a change onto these rows, and the difference is load-bearing:
 * {@link ValidationStore.ingestValidation} declares the **whole** check set, so a
 * check it omits was withdrawn; {@link ValidationStore.amendValidation} declares
 * **only what it changes**, so a check it omits is untouched. Collapsing them
 * would let a two-check correction silently supersede the other six.
 */
export class ValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Fold a document's validation block onto a goal's rows, **merging on check id**,
   * so a re-declaration does not withdraw what somebody already recorded. Three
   * rules, each closing a silent failure:
   *
   * - **A letter is assigned once and never reused**, over every letter the goal has
   *   ever issued, so `284:C` names the same check for the goal's life.
   * - **A reworded check loses its result** — a result carried across a rewording is
   *   a pass against wording nobody read.
   * - **A dropped check is superseded, never deleted**, which is also what keeps its
   *   letter taken.
   */
  ingestValidation(
    originRef: string,
    input: {
      checks: ValidationCheckInput[];
      resources: ValidationResourceInput[];
      supersededReason: string;
      /** What the band says when this ingestion is a *re*-reading rather than the plan's first. */
      amendNote: string;
    },
  ): ValidationCheck[] {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(originRef);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(input.checks.map((c) => c.id));
    // A plan's *first* validation block is a declaration, not an amendment: banding
    // every check would fire "this is not the check you read" on a plan nobody read.
    const amendNote = existing.length === 0 ? null : input.amendNote;

    const rows = input.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      return this.mergeCheck({ originRef, prev, input: check, letter, ts, amendNote });
    });

    const write = this.ctx.db.transaction((all: ValidationCheck[]) => {
      for (const row of all) this.writeCheck(row);
      for (const check of existing) {
        if (declared.has(check.id) || check.supersededReason !== null) continue;
        this.ctx.db
          .prepare(`UPDATE validation_checks SET superseded_reason=?, updated_at=? WHERE origin_ref=? AND id=?`)
          .run(input.supersededReason, ts, originRef, check.id);
      }
    });
    write(rows);
    this.replaceValidationResources(originRef, input.resources);
    return rows;
  }

  /**
   * Apply one agent's correction to a goal's validation block. **Nothing is
   * withdrawn by omission** — unlike `ingestValidation`, which speaks for the whole
   * set — so a terse correction cannot delete the validation plan it is failing.
   * A withdrawal is explicit, carries its reason, and supersedes rather than
   * deletes: **an agent that cannot pass a check must not make it disappear.**
   */
  amendValidation(originRef: string, amendment: ValidationAmendment): ValidationAmendResult {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(originRef);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(amendment.checks.map((c) => c.id));
    let lastSeq = existing.reduce((max, c) => Math.max(max, c.seq), 0);

    const result: ValidationAmendResult = { added: [], reworded: [], unchanged: [], withdrawn: [], unknown: [] };
    const rows = amendment.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      // A re-declared check keeps its position; a new one goes after the last. The
      // amendment's own order would file a two-check correction at the top of nine.
      const seq = prev?.seq ?? (lastSeq += 1);
      const row = this.mergeCheck({
        originRef,
        prev,
        input: { ...check, seq },
        letter,
        ts,
        amendNote: amendment.note,
      });
      // "Now live and was not" covers a new id and a restored one alike — the same
      // news to an operator, and the letter is kept either way.
      if (prev === undefined || prev.supersededReason !== null) result.added.push(row);
      else if (isReworded(prev, check)) result.reworded.push(row);
      else result.unchanged.push(row.id);
      return row;
    });

    const write = this.ctx.db.transaction(() => {
      for (const row of rows) this.writeCheck(row);
      for (const { id, reason } of amendment.withdraw) {
        const prev = byId.get(id);
        // Reported rather than silently ignored, or an agent withdrawing a name this
        // plan never held would believe it landed. Re-declaring and withdrawing one id
        // in a call is refused at the schema, so this cannot contradict the loop above.
        if (!prev || prev.supersededReason !== null || declared.has(id)) {
          result.unknown.push(id);
          continue;
        }
        this.ctx.db
          .prepare(
            `UPDATE validation_checks SET superseded_reason=?, amend_note=?, amended_at=?, updated_at=?
             WHERE origin_ref=? AND id=?`,
          )
          .run(reason, amendment.note, ts, ts, originRef, id);
        result.withdrawn.push(id);
      }
    });
    write();
    this.upsertValidationResources(originRef, amendment.resources);
    return result;
  }

  /**
   * One check as an ingestion or an amendment leaves it — the merge both writers
   * share, so neither develops its own opinion about what rewording costs.
   * `amendNote` null means this reading is the first, which is what keeps a plan's
   * opening declaration from banding every check it contains.
   */
  private mergeCheck(args: {
    originRef: string;
    prev: ValidationCheck | undefined;
    input: ValidationCheckInput;
    letter: string;
    ts: string;
    amendNote: string | null;
  }): ValidationCheck {
    const { originRef, prev, input, letter, ts, amendNote } = args;
    const reworded = prev !== undefined && isReworded(prev, input);
    const keep = prev !== undefined && !reworded;
    // What the operator is owed a word about: a check that appeared, came back, or no
    // longer says what it said. An identical re-declaration is none of those.
    const changed = prev === undefined || reworded || prev.supersededReason !== null;
    const band = amendNote !== null && changed;
    return {
      originRef,
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
      // The hand-over is withdrawn by exactly what withdraws the result: both were
      // operator decisions about wording that no longer exists, and a reworded check
      // still assigned to the fleet would be run by an agent nobody handed it to.
      actor: keep ? prev.actor : 'human',
      handbackNote: keep ? prev.handbackNote : null,
      // Dropped by the same predicate: somebody is running this check right now
      // against wording that no longer exists, and releasing lets them re-take it.
      claimedBy: keep ? prev.claimedBy : null,
      claimedAt: keep ? prev.claimedAt : null,
      state: keep ? prev.state : 'unrun',
      resultNote: keep ? prev.resultNote : null,
      resultBy: keep ? prev.resultBy : null,
      resultAt: keep ? prev.resultAt : null,
      deferUntil: keep ? prev.deferUntil : null,
      // A re-declared check is being asked for again, whatever an earlier amendment did.
      supersededReason: null,
      // Only a *reworded* check has wording to keep; an added one carries no revision.
      revision: band ? (reworded && prev !== undefined ? priorWording(prev) : null) : (prev?.revision ?? null),
      // Carried rather than cleared on an untouched check: an unseen amendment must not
      // be wiped by the next replan that re-states the same words.
      amendedAt: band ? ts : (prev?.amendedAt ?? null),
      amendNote: band ? amendNote : (prev?.amendNote ?? null),
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
  }

  /**
   * Replace a goal's declared resources wholesale — a replace rather than a merge
   * because a resource carries nothing an operator recorded. The ask filed for an
   * unprovided one is carried across by name, so a replan does not file it twice.
   */
  private replaceValidationResources(originRef: string, resources: ValidationResourceInput[]): void {
    const existing = new Map(this.listValidationResources(originRef).map((r) => [r.name, r]));
    const write = this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`DELETE FROM validation_resources WHERE origin_ref=?`).run(originRef);
      for (const resource of resources) {
        this.writeResource(originRef, resource, existing.get(resource.name)?.humanTaskId ?? null);
      }
    });
    write();
  }

  /**
   * Merge an amendment's resources by name, adding and updating but **never
   * removing**: a resource dropped by omission would vanish from under whichever
   * other check still lists it in `uses`, leaving it with no fixture.
   */
  private upsertValidationResources(originRef: string, resources: ValidationResourceInput[]): void {
    if (resources.length === 0) return;
    const existing = new Map(this.listValidationResources(originRef).map((r) => [r.name, r]));
    const write = this.ctx.db.transaction(() => {
      for (const resource of resources) {
        this.writeResource(originRef, resource, existing.get(resource.name)?.humanTaskId ?? null);
      }
    });
    write();
  }

  private writeResource(originRef: string, resource: ValidationResourceInput, humanTaskId: string | null): void {
    this.ctx.db
      .prepare(
        `INSERT INTO validation_resources (origin_ref, name, kind, note, provided, human_task_id)
         VALUES (@originRef, @name, @kind, @note, @provided, @humanTaskId)
         ON CONFLICT(origin_ref, name) DO UPDATE SET kind=excluded.kind, note=excluded.note,
           provided=excluded.provided, human_task_id=excluded.human_task_id`,
      )
      .run({
        originRef,
        name: resource.name,
        kind: resource.kind,
        note: resource.note,
        provided: resource.provided ? 1 : 0,
        humanTaskId,
      });
  }

  /** Remember the ask filed for an unprovided resource, so a replan does not file it twice. */
  linkValidationResourceTask(originRef: string, name: string, humanTaskId: string): void {
    this.ctx.db
      .prepare(`UPDATE validation_resources SET human_task_id=? WHERE origin_ref=? AND name=?`)
      .run(humanTaskId, originRef, name);
  }

  /** A goal's checks in declaration order, superseded ones included — the record is the point. */
  listValidationChecks(originRef: string): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE origin_ref=? ORDER BY seq ASC, letter ASC`)
      .all(originRef) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  /** Every check of every goal — what the snapshot and the close-out sweep both fold. */
  listAllValidationChecks(): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks ORDER BY origin_ref ASC, seq ASC`)
      .all() as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  /**
   * One live check, or null — shared by every writer that must decide before it
   * writes. Live only: a check its plan has withdrawn is not one to hand over, run
   * or report on.
   */
  getValidationCheck(originRef: string, checkId: string): ValidationCheck | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE origin_ref=? AND id=? AND superseded_reason IS NULL`)
      .get(originRef, checkId) as ValidationCheckRow | undefined;
    return row ? rowToCheck(row) : null;
  }

  /**
   * Hand a check to the fleet, or take it back. **The operator's act and nobody
   * else's** — no document, amendment or agent reaches this.
   *
   * Handing it over **keeps** any previous hand-back, so the next dispatch is briefed
   * with it rather than rediscovering the same wall
   * ([20](../../docs/spec/20-validation.md)). The reader (`whoOwesIt`) prefers the
   * actor; the next reading is what clears it.
   */
  setValidationActor(originRef: string, checkId: string, actor: ValidationCheckActor): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
    if (!current) return null;
    const next: ValidationCheck = {
      ...current,
      actor,
      updatedAt: this.ctx.now(),
    };
    this.writeCheck(next);
    return next;
  }

  /**
   * The fleet giving a check back: it could not run this, and here is why.
   * **It records no reading** — an agent that could not reach the environment has
   * found nothing out about the goal, and `failed` would flag it for a reason that
   * has nothing to do with the code.
   */
  recordValidationHandback(originRef: string, checkId: string, note: string): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
    if (!current) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...current,
      actor: 'human',
      handbackNote: note,
      // Whoever gave it back is done with it, so the claim goes too: a standing claim
      // would block the one thing the check now waits for — somebody else taking it.
      claimedBy: null,
      claimedAt: null,
      updatedAt: ts,
    };
    this.writeCheck(next);
    return next;
  }

  /**
   * Take the one live desktop claim for a check, or say who already holds it.
   * **One claim at a time, across every goal** — not a lock per check, since the
   * operator can only run one branch at once. Search, decision and write in one
   * synchronous method, so two racing sessions cannot both read "nothing is
   * claimed". `staleBefore` is the caller's clock policy: a claim taken before it
   * holds nothing.
   */
  claimValidationCheck(
    originRef: string,
    checkId: string,
    holder: string,
    staleBefore: string,
  ):
    | { ok: true; check: ValidationCheck; tookOverFrom: string | null }
    | { ok: false; reason: 'gone' }
    | { ok: false; reason: 'held'; by: ValidationCheck } {
    const target = this.getValidationCheck(originRef, checkId);
    if (!target) return { ok: false, reason: 'gone' };
    const live = this.liveClaims(staleBefore);
    const other = live.find((c) => c.originRef !== originRef || c.id !== checkId);
    if (other) return { ok: false, reason: 'held', by: other };
    // Re-claiming what you already hold is not a conflict: a session whose bridge
    // reconnected mid-run would otherwise be locked out by its own claim.
    const tookOverFrom = target.claimedBy !== null && target.claimedBy !== holder ? target.claimedBy : null;
    const ts = this.ctx.now();
    const next: ValidationCheck = { ...target, claimedBy: holder, claimedAt: ts, updatedAt: ts };
    this.writeCheck(next);
    return { ok: true, check: next, tookOverFrom };
  }

  /** Give a claimed check back, whoever holds it. Idempotent — releasing an unclaimed check is a no-op. */
  releaseValidationClaim(originRef: string, checkId: string): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
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

  listValidationResources(originRef: string): ValidationResource[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_resources WHERE origin_ref=? ORDER BY name ASC`)
      .all(originRef) as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  listAllValidationResources(): ValidationResource[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_resources ORDER BY origin_ref ASC, name ASC`)
      .all() as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  /**
   * Record what somebody concluded about a check — a result, a deferral, a waiver, or
   * the return to `unrun`. One method for all five because they are one write: a
   * check has exactly one current reading, and everything not carried is cleared
   * here rather than in a caller that has to remember.
   *
   * **A result is declared, never derived** — nothing infers a pass from a green
   * build or a merged pull request. Refuses a superseded check (returns null).
   */
  recordValidationResult(
    originRef: string,
    checkId: string,
    input: {
      state: ValidationCheckState;
      note: string | null;
      by: ValidationCheckResultBy | null;
      until?: string | null;
    },
  ): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
    if (!current) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...current,
      state: input.state,
      resultNote: input.note,
      resultBy: input.by,
      // Cleared with the reading: an `unrun` check carrying a timestamp reads as one
      // that was run and forgotten.
      resultAt: input.state === 'unrun' ? null : ts,
      deferUntil: input.state === 'deferred' ? (input.until ?? null) : null,
      // The band is answered, not just seen: whoever recorded a reading against the
      // current wording has been told. A reset counts too.
      revision: null,
      amendedAt: null,
      amendNote: null,
      // Answered for the band's reason: it says why the last dispatch came to nothing,
      // and a later reading has moved past it.
      handbackNote: null,
      // The reading is in, so the run is over: a held claim would spend the operator's
      // one-at-a-time budget on a check nobody is running.
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
        // `check_do` rather than `do`: DO is a SQLite keyword (UPSERT), and unquoted it
        // is a syntax error at prepare time. `check_expect` follows so the pair reads as one.
        `INSERT INTO validation_checks (origin_ref, id, letter, seq, title, check_do, check_expect, uses, covers,
           fleet_candidate, candidate_why, actor, handback_note, claimed_by, claimed_at, state, result_note,
           result_by, result_at, defer_until, superseded_reason, revision, amended_at, amend_note, created_at,
           updated_at)
         VALUES (@originRef, @id, @letter, @seq, @title, @do, @expect, @uses, @covers,
           @fleetCandidate, @candidateWhy, @actor, @handbackNote, @claimedBy, @claimedAt, @state, @resultNote,
           @resultBy, @resultAt, @deferUntil, @supersededReason, @revision, @amendedAt, @amendNote, @createdAt,
           @updatedAt)
         ON CONFLICT(origin_ref, id) DO UPDATE SET letter=excluded.letter, seq=excluded.seq, title=excluded.title,
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
 * Whether an amendment changed **what running this check involves**. Deliberately
 * not `uses`/`covers`/`fleetCandidate` — widening this would withdraw a result
 * every time a planner fixed a mistyped resource name.
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
    // `unrun` is not a reading: an amendment to one withdrew nothing.
    state: prev.state === 'unrun' ? null : prev.state,
    note: prev.resultNote,
  };
}

interface ValidationCheckRow {
  origin_ref: string;
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
  origin_ref: string;
  name: string;
  kind: string | null;
  note: string | null;
  provided: number;
  human_task_id: string | null;
}

function rowToCheck(r: ValidationCheckRow): ValidationCheck {
  return {
    originRef: r.origin_ref,
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
    // Anything but the word `fleet` is a human's check — the direction an unreadable
    // value must fail in, or it would dispatch an agent nobody asked for.
    actor: r.actor === 'fleet' ? 'fleet' : 'human',
    handbackNote: r.handback_note ?? null,
    // A claim needs both halves — holder and timestamp — so a row with one is read as
    // claimed by nobody: an unreadable claim becoming live would block a check forever.
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
 * Narrowed rather than cast, and not a type guard the compiler checks against the
 * union: **a new {@link ValidationCheckState} must be added here too**, or it is
 * written to SQLite, read back as `unrun`, and a passed check flags its goal forever.
 */
function checkStateOf(raw: string): ValidationCheckState {
  return raw === 'passed' || raw === 'failed' || raw === 'waived' || raw === 'deferred' ? raw : 'unrun';
}

/**
 * Narrowed for {@link checkStateOf}'s reason: a word this does not know reads as
 * null, which draws no marker — and no marker means "a person ran this". A new
 * {@link ValidationCheckResultBy} missing from here upgrades an agent's reading.
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
    originRef: r.origin_ref,
    name: r.name,
    kind: resourceKindOf(r.kind),
    note: r.note,
    provided: r.provided === 1,
    humanTaskId: r.human_task_id,
  };
}

/**
 * The revision column, degrading to null rather than throwing: a throw here would
 * take the whole plan sheet with it.
 */
function parseRevision(raw: string | null): ValidationRevision | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.title !== 'string' || typeof r.do !== 'string' || typeof r.expect !== 'string') return null;
    // `unrun` is not a reading, so it is not one this reads back either: normalising
    // keeps the invariant true of rows however they got there.
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
