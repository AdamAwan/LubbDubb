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
    // The selector a runner offers for this check. Null means *no area declared*, which is true of
    // every row written before the column existed and stays true — so nothing is backfilled.
    area: 'TEXT',
  },
  validation_resources: {},
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
      const row = this.mergeCheck({
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
      actor: keep ? prev.actor : 'human',
      handbackNote: keep ? prev.handbackNote : null,
      claimedBy: keep ? prev.claimedBy : null,
      claimedAt: keep ? prev.claimedAt : null,
      state: keep ? prev.state : 'unrun',
      resultNote: keep ? prev.resultNote : null,
      resultBy: keep ? prev.resultBy : null,
      resultAt: keep ? prev.resultAt : null,
      deferUntil: keep ? prev.deferUntil : null,
      supersededReason: null,
      revision: band ? (reworded && prev !== undefined ? priorWording(prev) : null) : (prev?.revision ?? null),
      amendedAt: band ? ts : (prev?.amendedAt ?? null),
      amendNote: band ? amendNote : (prev?.amendNote ?? null),
      area: prev?.area ?? null,
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
  }

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

  linkValidationResourceTask(originRef: string, name: string, humanTaskId: string): void {
    this.ctx.db
      .prepare(`UPDATE validation_resources SET human_task_id=? WHERE origin_ref=? AND name=?`)
      .run(humanTaskId, originRef, name);
  }

  listValidationChecks(originRef: string): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE origin_ref=? ORDER BY seq ASC, letter ASC`)
      .all(originRef) as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  listAllValidationChecks(): ValidationCheck[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM validation_checks ORDER BY origin_ref ASC, seq ASC`)
      .all() as ValidationCheckRow[];
    return rows.map(rowToCheck);
  }

  getValidationCheck(originRef: string, checkId: string): ValidationCheck | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM validation_checks WHERE origin_ref=? AND id=? AND superseded_reason IS NULL`)
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
      resultAt: input.state === 'unrun' ? null : ts,
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

  private writeCheck(check: ValidationCheck): void {
    this.ctx.db
      .prepare(
        // TECHDEBT: `check_do` rather than `do`: DO is a SQLite keyword (UPSERT), and unquoted it
        // is a syntax error at prepare time. `check_expect` follows so the pair reads as one.
        `INSERT INTO validation_checks (origin_ref, id, letter, seq, title, check_do, check_expect, uses, covers,
           fleet_candidate, candidate_why, actor, handback_note, claimed_by, claimed_at, state, result_note,
           result_by, result_at, defer_until, superseded_reason, revision, amended_at, amend_note, area,
           created_at, updated_at)
         VALUES (@originRef, @id, @letter, @seq, @title, @do, @expect, @uses, @covers,
           @fleetCandidate, @candidateWhy, @actor, @handbackNote, @claimedBy, @claimedAt, @state, @resultNote,
           @resultBy, @resultAt, @deferUntil, @supersededReason, @revision, @amendedAt, @amendNote, @area,
           @createdAt, @updatedAt)
         ON CONFLICT(origin_ref, id) DO UPDATE SET letter=excluded.letter, seq=excluded.seq, title=excluded.title,
           check_do=excluded.check_do, check_expect=excluded.check_expect, uses=excluded.uses,
           covers=excluded.covers, fleet_candidate=excluded.fleet_candidate,
           candidate_why=excluded.candidate_why, actor=excluded.actor,
           handback_note=excluded.handback_note, claimed_by=excluded.claimed_by,
           claimed_at=excluded.claimed_at, state=excluded.state, result_note=excluded.result_note,
           result_by=excluded.result_by, result_at=excluded.result_at, defer_until=excluded.defer_until,
           superseded_reason=excluded.superseded_reason, revision=excluded.revision,
           amended_at=excluded.amended_at, amend_note=excluded.amend_note, area=excluded.area,
           updated_at=excluded.updated_at`,
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

function isReworded(prev: ValidationCheck, next: ValidationCheckAmendmentLike): boolean {
  return prev.title !== next.title || prev.do !== next.do || prev.expect !== next.expect;
}

interface ValidationCheckAmendmentLike {
  title: string;
  do: string;
  expect: string;
}

function priorWording(prev: ValidationCheck): ValidationRevision {
  return {
    title: prev.title,
    do: prev.do,
    expect: prev.expect,
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
  actor: string | null | undefined;
  handback_note: string | null | undefined;
  claimed_by: string | null | undefined;
  claimed_at: string | null | undefined;
  state: string;
  result_note: string | null;
  result_by: string | null;
  result_at: string | null;
  defer_until: string | null;
  superseded_reason: string | null;
  revision: string | null | undefined;
  amended_at: string | null | undefined;
  amend_note: string | null | undefined;
  area: string | null | undefined;
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
    actor: r.actor === 'fleet' ? 'fleet' : 'human',
    handbackNote: r.handback_note ?? null,
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
    area: r.area ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function checkStateOf(raw: string): ValidationCheckState {
  return raw === 'passed' || raw === 'failed' || raw === 'waived' || raw === 'deferred' ? raw : 'unrun';
}

function resultByOf(raw: string | null): ValidationCheckResultBy | null {
  return raw === 'operator' || raw === 'agent' || raw === 'desktop' ? raw : null;
}

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

function parseRevision(raw: string | null): ValidationRevision | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.title !== 'string' || typeof r.do !== 'string' || typeof r.expect !== 'string') return null;
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

function parseStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
