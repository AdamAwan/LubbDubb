import type {
  AppraisalAuthor,
  ConclusionAuthor,
  DeliveryAuthor,
  GoalAppraisalVerdict,
  IssueAppraisal,
  IssueConclusion,
  IssueConclusionVerdict,
  IssueDelivery,
  IssueShortfall,
  ShortfallAuthor,
  ShortfallCause,
} from '../types.js';
import { VERDICT_EXCLUSIONS, VERDICT_TABLES, type VerdictKind } from './verdicts.js';
import type { ColumnMigrations, TableRename } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * The goal **assay** was renamed to the goal **appraisal**, and its table followed. Without this,
 * every verdict cast before the rename is stranded under a name no reader uses any more, and
 * `SCHEMA` stands an empty `issue_appraisals` up beside it — silently unholding every held goal.
 */
export const ISSUE_VERDICT_RENAMES: readonly TableRename[] = [{ from: 'issue_assays', to: 'issue_appraisals' }];

/**
 * Both assessment verdicts carry the assessor's account beside its headline, so both tables
 * gained `detail` together — a `detail` on only the negative table would be silently dropped by
 * every `delivered` assessment.
 */
export const ISSUE_VERDICT_COLUMNS: ColumnMigrations = {
  issue_deliveries: { detail: 'TEXT' },
  issue_shortfalls: { detail: 'TEXT' },
  issue_appraisals: {
    /** The profile the appraiser proposed — see {@link IssueAppraisal.proposedProfile}. */
    proposed_profile: 'TEXT',
    /** When the profile question was settled — see {@link IssueAppraisal.profileAnsweredAt}. Null on pre-existing rows, which also lack `proposed_profile`. */
    profile_answered_at: 'TEXT',
    /** The container the appraiser proposed — see {@link IssueAppraisal.proposedParent}. */
    proposed_parent: 'INTEGER',
    /** When the operator answered the parent question. Null on pre-existing rows, which carry no proposal either. */
    parent_settled_at: 'TEXT',
    /** The area path the appraiser proposed — see {@link IssueAppraisal.proposedAreaPath}. */
    proposed_area_path: 'TEXT',
    /** {@link parent_settled_at} for the area path, and null on old rows for its reason. */
    area_path_settled_at: 'TEXT',
    /** The appraiser's checklist — see {@link IssueAppraisal.missing}. JSON, one string per entry. Null on old rows, read as an empty list. */
    missing: 'TEXT',
  },
};

/**
 * The four tables holding a standing verdict about an issue: `issue_conclusions` (the working
 * agent's), `issue_deliveries` (assessor: reached), `issue_shortfalls` (assessor: not reached),
 * `issue_appraisals` (appraiser: can the goal text be worked from).
 *
 * Together, because which of them may coexist is the interesting part: it is declared as data in
 * `./verdicts.js` (dependency-free so the test that walks it needs no SQLite), and
 * {@link recordVerdict} is the one — private — place that applies it, so no writer can roll its own.
 */
export class IssueVerdictStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write one issue verdict and clear whatever {@link VERDICT_EXCLUSIONS} says it contradicts, in
   * one transaction. Deliberately does not compose the row — the four shapes differ in what they
   * preserve — so each public writer keeps its own row composition; only the sibling-clearing is shared.
   */
  private recordVerdict<T extends { originRef: string }>(kind: VerdictKind, upsert: string, row: T): T {
    const clears = VERDICT_EXCLUSIONS[kind].map((k) => VERDICT_TABLES[k]);
    const write = this.ctx.db.transaction((r: T) => {
      this.ctx.db.prepare(upsert).run(r);
      for (const table of clears) {
        this.ctx.db.prepare(`DELETE FROM ${table} WHERE origin_ref=?`).run(r.originRef);
      }
    });
    write(row);
    return row;
  }

  // -- Conclusions (the working agent's own account of its run) --------------

  /**
   * Record who says an issue is finished, replacing any standing verdict for it. Latest-wins per
   * issue. `createdAt` is preserved across an overwrite so the row still dates the first
   * conclusion. Which standing verdicts this clears is in {@link VERDICT_EXCLUSIONS}.
   */
  recordIssueConclusion(input: {
    originRef: string;
    verdict: IssueConclusionVerdict;
    note: string;
    by: ConclusionAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueConclusion {
    const ts = this.ctx.now();
    const prev = this.getIssueConclusion(input.originRef);
    const row: IssueConclusion = {
      originRef: input.originRef,
      verdict: input.verdict,
      note: input.note,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
    return this.recordVerdict(
      'conclusion',
      `INSERT INTO issue_conclusions (origin_ref, verdict, note, by, agent_id, task_id, created_at, updated_at)
       VALUES (@originRef, @verdict, @note, @by, @agentId, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(origin_ref) DO UPDATE SET
         verdict=excluded.verdict, note=excluded.note, by=excluded.by,
         agent_id=excluded.agent_id, task_id=excluded.task_id, updated_at=excluded.updated_at`,
      row,
    );
  }

  getIssueConclusion(originRef: string): IssueConclusion | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_conclusions WHERE origin_ref=?`).get(originRef) as
      | IssueConclusionRow
      | undefined;
    return row ? rowToIssueConclusion(row) : null;
  }

  listIssueConclusions(): IssueConclusion[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_conclusions`).all() as IssueConclusionRow[];
    return rows.map(rowToIssueConclusion);
  }

  /**
   * Drop an issue's standing verdict, returning it to whatever its plan derives, or to
   * `undeclared`. A delete rather than a third stored verdict: `undeclared` is precisely the
   * absence of a row.
   */
  clearIssueConclusion(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Deliveries (the assessor's positive verdict) --------------------------

  /**
   * Record that an issue is delivered. `decided_at` is preserved across an overwrite — it is what
   * `deliveryHold` measures world signal against, never `updated_at`. Reading a hold off
   * `decided_at` would let a transition that expired the *previous* verdict end the next one
   * before it is written, so no verdict on that issue could ever hold again. Same rule applies to
   * `recordAppraisal` below. Which verdicts this clears is in {@link VERDICT_EXCLUSIONS}.
   */
  recordDelivery(input: {
    originRef: string;
    summary: string;
    detail?: string | null;
    by: DeliveryAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueDelivery {
    const ts = this.ctx.now();
    const prev = this.getDelivery(input.originRef);
    const row: IssueDelivery = {
      originRef: input.originRef,
      summary: input.summary,
      detail: input.detail ?? null,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    return this.recordVerdict(
      'delivery',
      `INSERT INTO issue_deliveries (origin_ref, summary, detail, by, agent_id, task_id, decided_at, updated_at)
       VALUES (@originRef, @summary, @detail, @by, @agentId, @taskId, @decidedAt, @updatedAt)
       ON CONFLICT(origin_ref) DO UPDATE SET
         summary=excluded.summary, detail=excluded.detail, by=excluded.by, agent_id=excluded.agent_id,
         task_id=excluded.task_id, updated_at=excluded.updated_at`,
      row,
    );
  }

  getDelivery(originRef: string): IssueDelivery | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_deliveries WHERE origin_ref=?`).get(originRef) as
      | IssueDeliveryRow
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  /**
   * Every standing delivery verdict. Unbounded on purpose: a verdict aged out of a window would
   * silently re-open pickup on work already delivered. Stays small (one row per assessed issue);
   * only the *event* read it feeds is bounded by time/item (`deliverySignalQuery`).
   */
  listDeliveries(): IssueDelivery[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_deliveries`).all() as IssueDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /** Drop an issue's delivery verdict. A delete rather than a stored `not_delivered`, same reason as {@link clearIssueConclusion}. */
  clearDelivery(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Shortfalls (the assessor's negative verdict) --------------------------

  /**
   * Record that an issue was worked and its goal is not reached (issue #159). `decided_at` is
   * preserved across an overwrite for consistency with delivery rows, though here it is cosmetic
   * — this row holds nothing to expire. Which verdicts this clears — a delivery, deliberately not
   * a conclusion — is in {@link VERDICT_EXCLUSIONS}.
   */
  recordShortfall(input: {
    originRef: string;
    cause: ShortfallCause | null;
    partSlug?: string | null;
    summary: string;
    detail?: string | null;
    by: ShortfallAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueShortfall {
    const ts = this.ctx.now();
    const prev = this.getShortfall(input.originRef);
    const row: IssueShortfall = {
      originRef: input.originRef,
      cause: input.cause,
      // Only a `part` cause names one — normalised here rather than trusted from the caller.
      partSlug: input.cause === 'part' ? (input.partSlug ?? null) : null,
      summary: input.summary,
      detail: input.detail ?? null,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    return this.recordVerdict(
      'shortfall',
      `INSERT INTO issue_shortfalls (origin_ref, cause, part_slug, summary, detail, by, agent_id, task_id, decided_at, updated_at)
       VALUES (@originRef, @cause, @partSlug, @summary, @detail, @by, @agentId, @taskId, @decidedAt, @updatedAt)
       ON CONFLICT(origin_ref) DO UPDATE SET
         cause=excluded.cause, part_slug=excluded.part_slug, summary=excluded.summary,
         detail=excluded.detail, by=excluded.by,
         agent_id=excluded.agent_id, task_id=excluded.task_id, updated_at=excluded.updated_at`,
      row,
    );
  }

  getShortfall(originRef: string): IssueShortfall | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_shortfalls WHERE origin_ref=?`).get(originRef) as
      | IssueShortfallRow
      | undefined;
    return row ? rowToShortfall(row) : null;
  }

  /** Every standing shortfall. Unbounded on purpose, same reason as {@link listDeliveries}; a row lives only until its arm is acted on. */
  listShortfalls(): IssueShortfall[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_shortfalls`).all() as IssueShortfallRow[];
    return rows.map(rowToShortfall);
  }

  /** Drop an issue's shortfall. A delete rather than a settled status, same reason as {@link clearIssueConclusion}. */
  clearShortfall(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_shortfalls WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Appraisals (can the goal text be worked from at all?) ---------------------

  /**
   * Record whether an issue's goal text can be worked from. `decided_at` is preserved across an
   * overwrite for {@link recordDelivery}'s reason. `comment_ref` is preserved on absence, so the
   * one living comment on the ticket is edited rather than duplicated. This clears **nothing** —
   * {@link VERDICT_EXCLUSIONS} says so as an explicit empty row — because an appraisal answers a
   * different question from the other three and may honestly coexist with any of them.
   */
  recordAppraisal(input: {
    originRef: string;
    verdict: GoalAppraisalVerdict;
    summary: string;
    /** The author's checklist — see {@link IssueAppraisal.missing}. Absent = nothing to list. */
    missing?: string[];
    goalRef: string;
    by: AppraisalAuthor;
    agentId?: string | null;
    taskId?: string | null;
    /** The profile proposed for this goal's work, or null when none was named. */
    proposedProfile?: string | null;
    /** Whether the proposal needs a human answer before the funnel moves. Decided by the caller, which has the ticket's tag and the operator's config in hand. */
    profileDiverges?: boolean;
    /**
     * The container and classification node the appraiser proposed, or null. Stored exactly as
     * given and never gated here on whether the work item still needs it — that reading is
     * derived off the live work item where it is drawn.
     */
    proposedParent?: number | null;
    proposedAreaPath?: string | null;
  }): IssueAppraisal {
    const ts = this.ctx.now();
    const prev = this.getAppraisal(input.originRef);
    const proposedProfile = input.proposedProfile ?? null;
    const row: IssueAppraisal = {
      originRef: input.originRef,
      verdict: input.verdict,
      summary: input.summary,
      missing: input.missing ?? [],
      goalRef: input.goalRef,
      by: input.by,
      proposedProfile,
      // Settled on arrival unless it diverges — agreement must not cost a click. `appraisalHold`
      // holds the funnel on exactly this field being null for a diverging proposal.
      profileAnsweredAt: proposedProfile !== null && input.profileDiverges === true ? null : ts,
      proposedParent: input.proposedParent ?? null,
      proposedAreaPath: input.proposedAreaPath ?? null,
      // A re-appraisal is a fresh proposal; the previous dismissal does not carry over.
      parentSettledAt: null,
      areaPathSettledAt: null,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      // Kept only while the verdict is about the same text.
      commentRef: prev && prev.goalRef === input.goalRef ? prev.commentRef : null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    this.recordVerdict(
      'appraisal',
      `INSERT INTO issue_appraisals (origin_ref, verdict, summary, missing, goal_ref, by, proposed_profile, profile_answered_at, proposed_parent, parent_settled_at, proposed_area_path, area_path_settled_at, agent_id, task_id, comment_ref, decided_at, updated_at)
       VALUES (@originRef, @verdict, @summary, @missing, @goalRef, @by, @proposedProfile, @profileAnsweredAt, @proposedParent, @parentSettledAt, @proposedAreaPath, @areaPathSettledAt, @agentId, @taskId, @commentRef, @decidedAt, @updatedAt)
       ON CONFLICT(origin_ref) DO UPDATE SET
         verdict=excluded.verdict, summary=excluded.summary, missing=excluded.missing, goal_ref=excluded.goal_ref,
         by=excluded.by, proposed_profile=excluded.proposed_profile,
         profile_answered_at=excluded.profile_answered_at,
         proposed_parent=excluded.proposed_parent, parent_settled_at=excluded.parent_settled_at,
         proposed_area_path=excluded.proposed_area_path,
         area_path_settled_at=excluded.area_path_settled_at,
         agent_id=excluded.agent_id, task_id=excluded.task_id,
         comment_ref=excluded.comment_ref, updated_at=excluded.updated_at`,
      { ...row, missing: JSON.stringify(row.missing) },
    );
    return row;
  }

  getAppraisal(originRef: string): IssueAppraisal | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_appraisals WHERE origin_ref=?`).get(originRef) as
      | IssueAppraisalRow
      | undefined;
    return row ? rowToAppraisal(row) : null;
  }

  /**
   * Every standing appraisal. Unbounded on purpose, as {@link listDeliveries} is: an `unclear`
   * verdict aging out would let the harness dispatch against a goal already found unworkable, and
   * a `workable` one aging out would re-appraise every issue on a clock.
   */
  listAppraisals(): IssueAppraisal[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_appraisals`).all() as IssueAppraisalRow[];
    return rows.map(rowToAppraisal);
  }

  /**
   * Settle the profile question for this goal. Stamps the answer rather than storing what was
   * chosen (that is the ticket's tag) so a re-read cannot drift from it, and so "keep mine" does
   * not re-ask forever. Scoped to the `goal_ref` the operator was looking at: a re-appraisal
   * writes its own unanswered proposal, so answering a superseded one releases nothing unseen.
   */
  answerAppraisalProfile(originRef: string, goalRef: string): boolean {
    const ts = this.ctx.now();
    return (
      this.ctx.db
        .prepare(
          `UPDATE issue_appraisals SET profile_answered_at=?, updated_at=? WHERE origin_ref=? AND goal_ref=? AND profile_answered_at IS NULL`,
        )
        .run(ts, ts, originRef, goalRef).changes > 0
    );
  }

  /**
   * Settle one of a goal's placement questions. The only stored half of a question otherwise
   * derived from the live work item; written for it too since the derived read lags a pulse
   * behind. Scoped to `goal_ref`, same reason as {@link answerAppraisalProfile}. One method over a
   * column name (chosen from a closed union, never a caller's string) rather than two near-identical ones.
   */
  settleAppraisalPlacement(originRef: string, goalRef: string, field: 'parent' | 'areaPath'): boolean {
    const column = field === 'parent' ? 'parent_settled_at' : 'area_path_settled_at';
    const ts = this.ctx.now();
    return (
      this.ctx.db
        .prepare(
          `UPDATE issue_appraisals SET ${column}=?, updated_at=? WHERE origin_ref=? AND goal_ref=? AND ${column} IS NULL`,
        )
        .run(ts, ts, originRef, goalRef).changes > 0
    );
  }

  /** Remember the comment this verdict maintains on the ticket, so the next write edits it. */
  setAppraisalComment(originRef: string, commentRef: string): void {
    this.ctx.db
      .prepare(`UPDATE issue_appraisals SET comment_ref=?, updated_at=? WHERE origin_ref=?`)
      .run(commentRef, this.ctx.now(), originRef);
  }

  /** Drop an issue's appraisal — the escape hatch a blocking gate has to have. A delete, same reason as {@link clearIssueConclusion}. */
  clearAppraisal(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_appraisals WHERE origin_ref=?`).run(originRef).changes > 0;
  }
}

interface IssueConclusionRow {
  origin_ref: string;
  verdict: string;
  note: string;
  by: string;
  agent_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}
interface IssueDeliveryRow {
  origin_ref: string;
  summary: string;
  detail: string | null;
  by: string;
  agent_id: string | null;
  task_id: string | null;
  decided_at: string;
  updated_at: string;
}
interface IssueShortfallRow {
  origin_ref: string;
  cause: string | null;
  part_slug: string | null;
  summary: string;
  detail: string | null;
  by: string;
  agent_id: string | null;
  task_id: string | null;
  decided_at: string;
  updated_at: string;
}
interface IssueAppraisalRow {
  origin_ref: string;
  verdict: string;
  summary: string;
  /** JSON array of strings. Nullable *and* possibly absent: added by `ensureColumns` on older databases. */
  missing: string | null;
  goal_ref: string;
  by: string;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  proposed_profile: string | null;
  profile_answered_at: string | null;
  /** Nullable *and* possibly absent, exactly as the two profile columns are. */
  proposed_parent: number | null;
  parent_settled_at: string | null;
  proposed_area_path: string | null;
  area_path_settled_at: string | null;
  agent_id: string | null;
  task_id: string | null;
  comment_ref: string | null;
  decided_at: string;
  updated_at: string;
}

function rowToIssueConclusion(r: IssueConclusionRow): IssueConclusion {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as IssueConclusionVerdict,
    note: r.note,
    by: r.by as ConclusionAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToDelivery(r: IssueDeliveryRow): IssueDelivery {
  return {
    originRef: r.origin_ref,
    summary: r.summary,
    // `?? null` rather than trusted: a row written before the column existed reads `undefined`.
    detail: r.detail ?? null,
    by: r.by as DeliveryAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
function rowToShortfall(r: IssueShortfallRow): IssueShortfall {
  return {
    originRef: r.origin_ref,
    cause: (r.cause as ShortfallCause | null) ?? null,
    partSlug: r.part_slug,
    summary: r.summary,
    detail: r.detail ?? null,
    by: r.by as ShortfallAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
/** An absent or unparseable column is an empty list: the hold stands on the verdict, the checklist is a courtesy. */
function parseMissing(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToAppraisal(r: IssueAppraisalRow): IssueAppraisal {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as GoalAppraisalVerdict,
    summary: r.summary,
    missing: parseMissing(r.missing),
    goalRef: r.goal_ref,
    by: r.by as AppraisalAuthor,
    // `?? null`: an old row's `undefined` here would make it look like an unanswered proposal
    // and park an issue nobody had proposed anything for.
    proposedProfile: r.proposed_profile ?? null,
    profileAnsweredAt: r.profile_answered_at ?? null,
    proposedParent: r.proposed_parent ?? null,
    parentSettledAt: r.parent_settled_at ?? null,
    proposedAreaPath: r.proposed_area_path ?? null,
    areaPathSettledAt: r.area_path_settled_at ?? null,
    agentId: r.agent_id,
    taskId: r.task_id,
    commentRef: r.comment_ref,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
