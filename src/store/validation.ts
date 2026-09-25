import type Database from 'better-sqlite3';
import { nextCheckLetter } from '../validation/checkDocument.js';
import type {
  ValidationAmendment,
  ValidationStep,
  ValidationPlanRecord,
  ValidationAmendResult,
  ValidationCheck,
  ValidationCheckActor,
  ValidationCheckInput,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceInput,
} from '../types.js';
import { columnNames, type ColumnMigrations, type TableRebuild } from './migrate.js';
import type { StoreContext } from './context.js';
import {
  rowToCheck,
  rowToPlanRecord,
  rowToResource,
  type ValidationCheckRow,
  type ValidationPlanRow,
  type ValidationResourceRow,
} from './rows/validation.js';
import { isReworded, mergeCheck } from '../validation/checkMerge.js';

// → docs/spec/14-persistence.md

export const VALIDATION_COLUMNS: ColumnMigrations = {
  validation_checks: {
    revision: 'TEXT',
    amended_at: 'TEXT',
    amend_note: 'TEXT',
    actor: 'TEXT',
    handback_note: 'TEXT',
    claimed_by: 'TEXT',
    claimed_at: 'TEXT',
    // The check's test plan, JSON. Null means *no steps* — true of every row written before the
    // column existed and of every check whose author declared only prose, and it stays true, so
    // nothing is backfilled. A null read as `[]` and a null read as "unknown" are the same answer
    // here, which is why this one needs no reading rule beside it.
    steps: 'TEXT',
    // The screen a `screenshot` step handed back — a file name in the goal's validation directory.
    // Null means *no capture*, true of every row written before the column existed and of every
    // check nobody ever pointed a camera at, so nothing is backfilled. A capture is **not** the
    // run's artefact URL: that one is swept on the runner's own schedule and this one outlives the
    // run, because somebody still has to look at it.
    // → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
    capture: 'TEXT',
    // What a pass must hand back, prose, written by the check's author. Null means *no evidence was
    // demanded*, which is true of every row written before the column existed and of every check
    // whose assertion is the whole of its evidence — so nothing is backfilled, and null must never
    // be read as "evidence was demanded and none came". → docs/spec/20-validation.md#proof
    proof: 'TEXT',
    // The goal criteria the check answers, JSON. Null reads as none, which is true of every row
    // written before the column and needs no backfill. → docs/spec/20-validation.md#satisfies-and-the-goals-criteria
    satisfies: 'TEXT',
  },
  validation_resources: {},
  // Shipped as a fresh CREATE TABLE and declared here anyway: a table being new once does not keep
  // it exempt, and `validation_checks` collected that debt one change later.
  // `released_at` arrived with the acceptance gate. Null on a row written before it means "authored
  // and never proposed", which the gate would read as a set still waiting on an operator — every
  // deployment's live sets held at once. `releaseValidationPlansFromBeforeTheGate` is the backfill,
  // gated on this report. → docs/spec/14-persistence.md#when-a-null-means-something
  validation_plans: { released_at: 'TEXT' },
};

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
    table: 'validation_checks',
    detect: (db) => {
      const columns = columnNames(db, 'validation_checks');
      return (columns.includes('area') || columns.includes('expects')) && !columns.includes('plan_id');
    },
    copy: (old, db) => {
      const carried = new Set(columnNames(db, old));
      const columns = columnNames(db, 'validation_checks')
        .filter((c) => carried.has(c))
        .join(', ');
      return `INSERT INTO validation_checks (${columns}) SELECT ${columns} FROM ${old}`;
    },
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

export class ValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  ingestValidation(
    originRef: string,
    input: {
      checks: ValidationCheckInput[];
      resources: ValidationResourceInput[];
      supersededReason: string;
      amendNote: string;
    },
  ): ValidationCheck[] {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(originRef);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(input.checks.map((c) => c.id));
    const amendNote = existing.length === 0 ? null : input.amendNote;

    const rows = input.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      return mergeCheck({ originRef, prev, input: check, letter, ts, amendNote });
    });

    const write = this.ctx.db.transaction((all: ValidationCheck[]) => {
      for (const row of all) this.writeCheck(row);
      for (const check of existing) {
        if (declared.has(check.id) || check.supersededReason !== null) continue;
        this.ctx
          .prep(`UPDATE validation_checks SET superseded_reason=?, updated_at=? WHERE origin_ref=? AND id=?`)
          .run(input.supersededReason, ts, originRef, check.id);
      }
    });
    write(rows);
    this.replaceValidationResources(originRef, input.resources);
    return rows;
  }

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
      const seq = prev?.seq ?? (lastSeq += 1);
      const row = mergeCheck({
        originRef,
        prev,
        input: { ...check, seq },
        letter,
        ts,
        amendNote: amendment.note,
      });
      if (prev === undefined || prev.supersededReason !== null) result.added.push(row);
      else if (isReworded(prev, check)) result.reworded.push(row);
      else result.unchanged.push(row.id);
      return row;
    });

    const write = this.ctx.db.transaction(() => {
      for (const row of rows) this.writeCheck(row);
      for (const { id, reason } of amendment.withdraw) {
        const prev = byId.get(id);
        if (!prev || prev.supersededReason !== null || declared.has(id)) {
          result.unknown.push(id);
          continue;
        }
        this.ctx
          .prep(
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

  private replaceValidationResources(originRef: string, resources: ValidationResourceInput[]): void {
    const existing = new Map(this.listValidationResources(originRef).map((r) => [r.name, r]));
    const write = this.ctx.db.transaction(() => {
      this.ctx.prep(`DELETE FROM validation_resources WHERE origin_ref=?`).run(originRef);
      for (const resource of resources) {
        this.writeResource(originRef, resource, existing.get(resource.name)?.humanTaskId ?? null);
      }
    });
    write();
  }

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
    this.ctx
      .prep(
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

  linkValidationResourceTask(originRef: string, name: string, humanTaskId: string): void {
    this.ctx
      .prep(`UPDATE validation_resources SET human_task_id=? WHERE origin_ref=? AND name=?`)
      .run(humanTaskId, originRef, name);
  }

  /**
   * The plan document's half of the goal's validation plan: prose intent, written before the code
   * exists, binding nothing. It is handed to the validation planner as input and read by an operator
   * at the approval gate. Writing it never touches the authoring half — a replan re-states an intent
   * and does not un-write a check set. → docs/spec/20-validation.md#the-document-block
   */
  recordValidationHint(originRef: string, hint: string | null): ValidationPlanRecord {
    const ts = this.ctx.now();
    this.ctx
      .prep(
        `INSERT INTO validation_plans (origin_ref, hint, note, empty_reason, authored_at, released_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?)
         ON CONFLICT(origin_ref) DO UPDATE SET hint=excluded.hint, updated_at=excluded.updated_at`,
      )
      .run(originRef, hint, ts);
    return this.getValidationPlanRecord(originRef) as ValidationPlanRecord;
  }

  /**
   * The validation planner's half: its account of the set it just wrote, and — where it wrote none —
   * why nothing was worth running. The `authored_at` stamp is what sheet assembly waits on, which is
   * why it is written even for an empty set: null with no account of itself is indistinguishable
   * from a planner that never ran, and a sheet assembled on that reads as a misconfiguration and is
   * not one. → docs/spec/20-validation.md#when-the-check-set-is-written
   */
  recordValidationAuthoring(
    originRef: string,
    input: { note: string; emptyReason: string | null },
  ): ValidationPlanRecord {
    const ts = this.ctx.now();
    this.ctx
      .prep(
        `INSERT INTO validation_plans (origin_ref, hint, note, empty_reason, authored_at, released_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, NULL, ?)
         ON CONFLICT(origin_ref) DO UPDATE SET note=excluded.note, empty_reason=excluded.empty_reason,
           authored_at=excluded.authored_at, released_at=NULL, updated_at=excluded.updated_at`,
      )
      .run(originRef, input.note, input.emptyReason, ts, ts);
    return this.getValidationPlanRecord(originRef) as ValidationPlanRecord;
  }

  /**
   * The operator's accept on the authored set: the release stamp, and nothing else. Authoring wrote
   * the rows and the note; this is the press that lets anything read them as work — sheet assembly,
   * and rule `validate-check`. A set that is not authored cannot be released, so a call on one
   * answers null rather than stamping a release over nothing.
   * → docs/spec/20-validation.md#the-check-set-is-proposed-before-it-is-work
   */
  releaseValidationPlan(originRef: string): ValidationPlanRecord | null {
    const record = this.getValidationPlanRecord(originRef);
    if (record === null || record.authoredAt === null) return null;
    if (record.releasedAt !== null) return record;
    const ts = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE validation_plans SET released_at=?, updated_at=? WHERE origin_ref=?`)
      .run(ts, ts, originRef);
    return this.getValidationPlanRecord(originRef);
  }

  /**
   * The operator's reject: the stamp comes off, and the rows the planner wrote stay where they are.
   * They are the account of what was refused and the next planner's starting point — `ingestValidation`
   * merges on `id`, so a re-authored set amends them rather than doubling them. Nothing was ever
   * released, so nobody is halfway through the set this clears the stamp on.
   * → docs/spec/20-validation.md#when-an-operator-sends-a-check-set-back
   */
  withdrawValidationAuthoring(originRef: string): ValidationPlanRecord | null {
    const record = this.getValidationPlanRecord(originRef);
    if (record === null || record.authoredAt === null) return null;
    const ts = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE validation_plans SET authored_at=NULL, released_at=NULL, updated_at=? WHERE origin_ref=?`)
      .run(ts, originRef);
    return this.getValidationPlanRecord(originRef);
  }

  listValidationPlanRecords(): ValidationPlanRecord[] {
    const rows = this.ctx.prep(`SELECT * FROM validation_plans ORDER BY origin_ref ASC`).all() as ValidationPlanRow[];
    return rows.map(rowToPlanRecord);
  }

  getValidationPlanRecord(originRef: string): ValidationPlanRecord | null {
    const row = this.ctx.prep(`SELECT * FROM validation_plans WHERE origin_ref=?`).get(originRef) as
      | ValidationPlanRow
      | undefined;
    return row ? rowToPlanRecord(row) : null;
  }

  listValidationChecks(originRef: string): ValidationCheck[] {
    const rows = this.ctx
      .prep(`SELECT * FROM validation_checks WHERE origin_ref=? ORDER BY seq ASC, letter ASC`)
      .all(originRef) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  listAllValidationChecks(): ValidationCheck[] {
    const rows = this.ctx
      .prep(`SELECT * FROM validation_checks ORDER BY origin_ref ASC, seq ASC`)
      .all() as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  getValidationCheck(originRef: string, checkId: string): ValidationCheck | null {
    const row = this.ctx
      .prep(`SELECT * FROM validation_checks WHERE origin_ref=? AND id=? AND superseded_reason IS NULL`)
      .get(originRef, checkId) as ValidationCheckRow | undefined;
    return row ? rowToCheck(row) : null;
  }

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

  recordValidationHandback(originRef: string, checkId: string, note: string): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
    if (!current) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...current,
      actor: 'human',
      handbackNote: note,
      claimedBy: null,
      claimedAt: null,
      updatedAt: ts,
    };
    this.writeCheck(next);
    return next;
  }

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
    const tookOverFrom = target.claimedBy !== null && target.claimedBy !== holder ? target.claimedBy : null;
    const ts = this.ctx.now();
    const next: ValidationCheck = { ...target, claimedBy: holder, claimedAt: ts, updatedAt: ts };
    this.writeCheck(next);
    return { ok: true, check: next, tookOverFrom };
  }

  releaseValidationClaim(originRef: string, checkId: string): ValidationCheck | null {
    const current = this.getValidationCheck(originRef, checkId);
    if (!current || current.claimedBy === null) return current;
    const next: ValidationCheck = { ...current, claimedBy: null, claimedAt: null, updatedAt: this.ctx.now() };
    this.writeCheck(next);
    return next;
  }

  liveClaims(staleBefore: string): ValidationCheck[] {
    const rows = this.ctx
      .prep(
        `SELECT * FROM validation_checks
         WHERE claimed_by IS NOT NULL AND claimed_at > ? AND superseded_reason IS NULL
         ORDER BY claimed_at ASC`,
      )
      .all(staleBefore) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  listValidationResources(originRef: string): ValidationResource[] {
    const rows = this.ctx
      .prep(`SELECT * FROM validation_resources WHERE origin_ref=? ORDER BY name ASC`)
      .all(originRef) as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  listAllValidationResources(): ValidationResource[] {
    const rows = this.ctx
      .prep(`SELECT * FROM validation_resources ORDER BY origin_ref ASC, name ASC`)
      .all() as ValidationResourceRow[];
    return rows.map(rowToResource);
  }

  recordValidationResult(
    originRef: string,
    checkId: string,
    input: {
      state: ValidationCheckState;
      note: string | null;
      by: ValidationCheckResultBy | null;
      until?: string | null;
      /**
       * The screen a `screenshot` step handed back. Omitted keeps whatever is on the row, which is
       * what the person recording their judgement of the capture is looking at — clearing it there
       * would delete the evidence at the exact moment somebody is acting on it. Only a reset, which
       * means *nothing to attribute*, takes it away.
       */
      capture?: string | null;
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
      resultAt: input.state === 'unrun' ? null : ts,
      capture: input.state === 'unrun' ? null : (input.capture ?? current.capture),
      deferUntil: input.state === 'deferred' ? (input.until ?? null) : null,
      revision: null,
      amendedAt: null,
      amendNote: null,
      handbackNote: null,
      claimedBy: null,
      claimedAt: null,
      updatedAt: ts,
    };
    this.writeCheck(next);
    return next;
  }

  /**
   * The grace sweep's one write: the check's steps, and nothing else on the row. It is deliberately
   * not `recordValidationResult` — removing a script's source says nothing about whether the check
   * passed, and a writer that cleared the reading, the hand-back and the amendment band beside it
   * would take a goal's whole validation history out with a housekeeping pass.
   *
   * @public the seam `RemoteValidationDesk`'s script grace sweep writes through
   */
  sweepValidationScripts(originRef: string, checkId: string, steps: readonly ValidationStep[]): void {
    this.ctx
      .prep(`UPDATE validation_checks SET steps=?, updated_at=? WHERE origin_ref=? AND id=?`)
      .run(JSON.stringify(steps), this.ctx.now(), originRef, checkId);
  }

  private writeCheck(check: ValidationCheck): void {
    this.ctx
      .prep(
        // TECHDEBT: `check_do` rather than `do`: DO is a SQLite keyword (UPSERT), and unquoted it
        // is a syntax error at prepare time. `check_expect` follows so the pair reads as one.
        `INSERT INTO validation_checks (origin_ref, id, letter, seq, title, check_do, check_expect, uses, covers,
           satisfies, fleet_candidate, candidate_why, actor, handback_note, claimed_by, claimed_at, state, result_note,
           result_by, result_at, defer_until, superseded_reason, revision, amended_at, amend_note,
           steps, capture, proof, created_at, updated_at)
         VALUES (@originRef, @id, @letter, @seq, @title, @do, @expect, @uses, @covers,
           @satisfies, @fleetCandidate, @candidateWhy, @actor, @handbackNote, @claimedBy, @claimedAt, @state, @resultNote,
           @resultBy, @resultAt, @deferUntil, @supersededReason, @revision, @amendedAt, @amendNote,
           @steps, @capture, @proof, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref, id) DO UPDATE SET letter=excluded.letter, seq=excluded.seq, title=excluded.title,
           check_do=excluded.check_do, check_expect=excluded.check_expect, uses=excluded.uses,
           covers=excluded.covers, satisfies=excluded.satisfies, fleet_candidate=excluded.fleet_candidate,
           candidate_why=excluded.candidate_why, actor=excluded.actor,
           handback_note=excluded.handback_note, claimed_by=excluded.claimed_by,
           claimed_at=excluded.claimed_at, state=excluded.state, result_note=excluded.result_note,
           result_by=excluded.result_by, result_at=excluded.result_at, defer_until=excluded.defer_until,
           superseded_reason=excluded.superseded_reason, revision=excluded.revision,
           amended_at=excluded.amended_at, amend_note=excluded.amend_note,
           steps=excluded.steps, capture=excluded.capture, proof=excluded.proof,
           updated_at=excluded.updated_at`,
      )
      .run({
        ...check,
        uses: JSON.stringify(check.uses),
        covers: JSON.stringify(check.covers),
        satisfies: JSON.stringify(check.satisfies ?? []),
        fleetCandidate: check.fleetCandidate ? 1 : 0,
        revision: check.revision === null ? null : JSON.stringify(check.revision),
        steps: check.steps.length === 0 ? null : JSON.stringify(check.steps),
      });
  }
}

/**
 * Every check set authored before the acceptance gate existed is a set an operator has been running
 * for weeks. Null `released_at` means "still a proposal", so without this the gate holds all of them
 * at once — sheets stop assembling and `validate-check` stops dispatching, with nothing red. Gated on
 * `ensureColumns`' report of having just added the column, because a pass on every boot would release
 * the set an operator is being asked about right now.
 * → docs/spec/14-persistence.md#when-a-null-means-something
 */
export function releaseValidationPlansFromBeforeTheGate(db: Database.Database): void {
  db.prepare(
    `UPDATE validation_plans SET released_at=authored_at WHERE authored_at IS NOT NULL AND released_at IS NULL`,
  ).run();
}
