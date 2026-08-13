import { nextCheckLetter } from '../validation/checkDocument.js';
import type {
  ValidationCheck,
  ValidationCheckInput,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceInput,
  ValidationResourceKind,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * Both tables are fresh `CREATE TABLE`s, so `CREATE TABLE IF NOT EXISTS` is the
 * whole migration and neither needs an entry — **today**. The entry is declared
 * empty anyway, because a table being new *once* does not keep it exempt: the
 * next column added to either is invisible on every database from before it
 * existed, with nothing erroring, and the place to notice that is here rather
 * than in the reader that silently reads `undefined`. That is the `human_tasks`
 * lesson, written down before it costs anything.
 */
export const VALIDATION_COLUMNS: ColumnMigrations = {
  validation_checks: {},
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
    input: { checks: ValidationCheckInput[]; resources: ValidationResourceInput[]; supersededReason: string },
  ): ValidationCheck[] {
    const ts = this.ctx.now();
    const existing = this.listValidationChecks(planId);
    const byId = new Map(existing.map((c) => [c.id, c]));
    const taken = existing.map((c) => c.letter);
    const declared = new Set(input.checks.map((c) => c.id));

    const rows = input.checks.map((check) => {
      const prev = byId.get(check.id);
      const letter = prev?.letter ?? nextCheckLetter(taken);
      if (!prev) taken.push(letter);
      // Deliberately not `uses`/`covers`/`fleetCandidate`: those are references
      // and a suggestion, and a plan that fixed a mistyped resource name has not
      // changed what running the check involves.
      const reworded =
        prev !== undefined && (prev.title !== check.title || prev.do !== check.do || prev.expect !== check.expect);
      const keep = prev !== undefined && !reworded;
      const row: ValidationCheck = {
        planId,
        id: check.id,
        letter,
        seq: check.seq,
        title: check.title,
        do: check.do,
        expect: check.expect,
        uses: check.uses,
        covers: check.covers,
        fleetCandidate: check.fleetCandidate,
        candidateWhy: check.candidateWhy,
        state: keep ? prev.state : 'unrun',
        resultNote: keep ? prev.resultNote : null,
        resultBy: keep ? prev.resultBy : null,
        resultAt: keep ? prev.resultAt : null,
        deferUntil: keep ? prev.deferUntil : null,
        // A re-declared check is being asked for again, whatever an earlier
        // amendment did with it.
        supersededReason: null,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
      };
      return row;
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
      const stmt = this.ctx.db.prepare(
        `INSERT INTO validation_resources (plan_id, name, kind, note, provided, human_task_id)
         VALUES (@planId, @name, @kind, @note, @provided, @humanTaskId)`,
      );
      for (const resource of resources) {
        stmt.run({
          planId,
          name: resource.name,
          kind: resource.kind,
          note: resource.note,
          provided: resource.provided ? 1 : 0,
          humanTaskId: existing.get(resource.name)?.humanTaskId ?? null,
        });
      }
    });
    write();
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
    input: { state: ValidationCheckState; note: string | null; by: 'operator' | null; until?: string | null },
  ): ValidationCheck | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE plan_id=? AND id=? AND superseded_reason IS NULL`)
      .get(planId, checkId) as ValidationCheckRow | undefined;
    if (!row) return null;
    const ts = this.ctx.now();
    const next: ValidationCheck = {
      ...rowToCheck(row),
      state: input.state,
      resultNote: input.note,
      resultBy: input.by,
      // The instant a reading was taken, and cleared with it: an `unrun` check
      // carrying a timestamp reads as one that was run and forgotten.
      resultAt: input.state === 'unrun' ? null : ts,
      deferUntil: input.state === 'deferred' ? (input.until ?? null) : null,
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
           fleet_candidate, candidate_why, state, result_note, result_by, result_at, defer_until,
           superseded_reason, created_at, updated_at)
         VALUES (@planId, @id, @letter, @seq, @title, @do, @expect, @uses, @covers,
           @fleetCandidate, @candidateWhy, @state, @resultNote, @resultBy, @resultAt, @deferUntil,
           @supersededReason, @createdAt, @updatedAt)
         ON CONFLICT(plan_id, id) DO UPDATE SET letter=excluded.letter, seq=excluded.seq, title=excluded.title,
           check_do=excluded.check_do, check_expect=excluded.check_expect, uses=excluded.uses,
           covers=excluded.covers, fleet_candidate=excluded.fleet_candidate,
           candidate_why=excluded.candidate_why, state=excluded.state, result_note=excluded.result_note,
           result_by=excluded.result_by, result_at=excluded.result_at, defer_until=excluded.defer_until,
           superseded_reason=excluded.superseded_reason, updated_at=excluded.updated_at`,
      )
      .run({
        ...check,
        uses: JSON.stringify(check.uses),
        covers: JSON.stringify(check.covers),
        fleetCandidate: check.fleetCandidate ? 1 : 0,
      });
  }
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
  state: string;
  result_note: string | null;
  result_by: string | null;
  result_at: string | null;
  defer_until: string | null;
  superseded_reason: string | null;
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
    state: checkStateOf(r.state),
    resultNote: r.result_note,
    resultBy: r.result_by === 'operator' ? 'operator' : null,
    resultAt: r.result_at,
    deferUntil: r.defer_until,
    supersededReason: r.superseded_reason,
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
