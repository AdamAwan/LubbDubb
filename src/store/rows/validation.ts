import type {
  ValidationCheck,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationPlanRecord,
  ValidationResource,
  ValidationResourceKind,
  ValidationRevision,
  ValidationStep,
} from '../../types.js';

export interface ValidationCheckRow {
  origin_ref: string;
  id: string;
  letter: string;
  seq: number;
  title: string;
  check_do: string;
  check_expect: string;
  proof: string | null | undefined;
  uses: string;
  covers: string;
  satisfies: string | null | undefined;
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
  steps: string | null | undefined;
  capture: string | null | undefined;
  created_at: string;
  updated_at: string;
}

export interface ValidationResourceRow {
  origin_ref: string;
  name: string;
  kind: string | null;
  note: string | null;
  provided: number;
  human_task_id: string | null;
}

export function rowToCheck(r: ValidationCheckRow): ValidationCheck {
  const claim = claimOf(r);
  return {
    originRef: r.origin_ref,
    id: r.id,
    letter: r.letter,
    seq: r.seq,
    title: r.title,
    do: r.check_do,
    expect: r.check_expect,
    proof: r.proof ?? null,
    uses: parseStringArray(r.uses),
    covers: parseStringArray(r.covers),
    satisfies: parseStringArray(r.satisfies ?? null),
    fleetCandidate: r.fleet_candidate === 1,
    candidateWhy: r.candidate_why,
    actor: r.actor === 'fleet' ? 'fleet' : 'human',
    handbackNote: r.handback_note ?? null,
    claimedBy: claim.claimedBy,
    claimedAt: claim.claimedAt,
    state: checkStateOf(r.state),
    resultNote: r.result_note,
    resultBy: resultByOf(r.result_by),
    resultAt: r.result_at,
    deferUntil: r.defer_until,
    supersededReason: r.superseded_reason,
    revision: parseRevision(r.revision ?? null),
    amendedAt: r.amended_at ?? null,
    amendNote: r.amend_note ?? null,
    steps: parseSteps(r.steps ?? null),
    capture: r.capture ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function claimOf(r: ValidationCheckRow): Pick<ValidationCheck, 'claimedBy' | 'claimedAt'> {
  return r.claimed_by !== null && r.claimed_by !== undefined && r.claimed_at
    ? { claimedBy: r.claimed_by, claimedAt: r.claimed_at }
    : { claimedBy: null, claimedAt: null };
}

/**
 * Anything unrecognised narrows to `unrun`, and that direction is what makes `captured` and
 * `declined` safe to add:
 * a row written before the state existed lands on *nobody has got to it* rather than on *there is an
 * image here waiting for you*. Adding a value to a column is not a schema change — `state` gained it
 * the way `result_by` gained `agent`, `desktop` and `spec`.
 */
function checkStateOf(raw: string): ValidationCheckState {
  return raw === 'passed' ||
    raw === 'failed' ||
    raw === 'waived' ||
    raw === 'deferred' ||
    raw === 'captured' ||
    raw === 'declined'
    ? raw
    : 'unrun';
}

/** `script` is its own answer and is never read back as `spec` — nothing reviewed a one-off script. */
function resultByOf(raw: string | null): ValidationCheckResultBy | null {
  return raw === 'operator' || raw === 'agent' || raw === 'desktop' || raw === 'spec' || raw === 'script' ? raw : null;
}

function resourceKindOf(raw: string | null): ValidationResourceKind | null {
  return raw === 'fixture' || raw === 'access' || raw === 'reference' || raw === 'data' ? raw : null;
}

export function rowToResource(r: ValidationResourceRow): ValidationResource {
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
      // Tolerated rather than required: a revision written before the field carries no `proof`, and
      // reading that blob as unparseable would throw away the whole record of what a check used to
      // say to gain one line of it.
      proof: typeof r.proof === 'string' ? r.proof : null,
      state: state === 'unrun' ? null : state,
      note: typeof r.note === 'string' ? r.note : null,
    };
  } catch {
    return null;
  }
}

/**
 * Null is **no steps**, and so is anything this cannot read back — the same rule the rest of this
 * module's JSON columns follow. A column added to an existing table is null on every row from before
 * it, and there is nothing to backfill: a check written before test plans existed genuinely had none.
 */
function parseSteps(raw: string | null): ValidationStep[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((step): step is ValidationStep => {
      if (typeof step !== 'object' || step === null) return false;
      const s = step as Record<string, unknown>;
      return typeof s.kind === 'string' && typeof s.do === 'string' && typeof s.actor === 'string';
    });
  } catch {
    return [];
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

export interface ValidationPlanRow {
  origin_ref: string;
  hint: string | null;
  note: string | null;
  empty_reason: string | null;
  authored_at: string | null;
  released_at: string | null;
}

export function rowToPlanRecord(r: ValidationPlanRow): ValidationPlanRecord {
  return {
    originRef: r.origin_ref,
    hint: r.hint ?? null,
    note: r.note ?? null,
    emptyReason: r.empty_reason ?? null,
    authoredAt: r.authored_at ?? null,
    releasedAt: r.released_at ?? null,
  };
}
