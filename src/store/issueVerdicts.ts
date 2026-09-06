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
 * The goal **assay** was renamed to the goal **appraisal**; the table followed and
 * nothing about the rows changed. Without the rename every verdict cast before it
 * is stranded and `SCHEMA` stands an empty table beside it, with nothing red.
 * → `docs/spec/14-persistence.md#renaming-a-table`
 */
export const ISSUE_VERDICT_RENAMES: readonly TableRename[] = [{ from: 'issue_assays', to: 'issue_appraisals' }];

/**
 * Both assessment verdicts carry the assessor's account, so both tables gained
 * `detail` together — a verdict lands in exactly one of them, so a `detail` on only
 * one table is silently dropped by every assessment that went the other way.
 */
export const ISSUE_VERDICT_COLUMNS: ColumnMigrations = {
  issue_deliveries: { detail: 'TEXT' },
  issue_shortfalls: { detail: 'TEXT' },
  issue_appraisals: {
    /** The profile the appraiser proposed — see {@link IssueAppraisal.proposedProfile}. */
    proposed_profile: 'TEXT',
    /**
     * When the profile question was settled — see {@link IssueAppraisal.profileAnsweredAt}.
     * Null on older rows, which is the right reading: they carry no
     * `proposed_profile` either, and the gate needs both.
     */
    profile_answered_at: 'TEXT',
    /** The container the appraiser proposed — see {@link IssueAppraisal.proposedParent}. */
    proposed_parent: 'INTEGER',
    /**
     * When the operator answered the parent question — see
     * {@link IssueAppraisal.parentSettledAt}. Null on older rows, which carry no
     * proposal either, and the question needs both.
     */
    parent_settled_at: 'TEXT',
    /** The area path the appraiser proposed — see {@link IssueAppraisal.proposedAreaPath}. */
    proposed_area_path: 'TEXT',
    /** {@link parent_settled_at} for the area path, and null on old rows for its reason. */
    area_path_settled_at: 'TEXT',
  },
};

/**
 * The four tables holding a standing verdict about an issue: `issue_conclusions`
 * (the working agent says it is finished), `issue_deliveries` (the assessor says
 * the goal is reached), `issue_shortfalls` (it is not) and `issue_appraisals` (the
 * goal text can or cannot be worked from).
 *
 * Together, because which of them may coexist is the interesting part. That matrix
 * is declared as data in `./verdicts.js`; {@link recordVerdict} is the one place
 * that applies it, and it is private so a writer cannot roll its own `DELETE`.
 * → `docs/spec/14-persistence.md#issue-verdicts-and-the-exclusion-matrix`
 */
export class IssueVerdictStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write one issue verdict and clear whatever {@link VERDICT_EXCLUSIONS} says it
   * contradicts, in one transaction. Deliberately does **not** compose the row —
   * the four differ in the ways that matter, so each public writer keeps its own
   * row-composition and only stops carrying an opinion about the other three.
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
   * Record who says an issue is finished, replacing any standing verdict for it.
   * Latest-wins per issue; `createdAt` is preserved across an overwrite so the row
   * still dates the first conclusion. What this clears is in
   * {@link VERDICT_EXCLUSIONS}, applied by {@link recordVerdict}.
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
   * Drop an issue's standing verdict, returning it to whatever its plan derives —
   * or to `undeclared`. A delete rather than a third stored verdict: `undeclared`
   * is precisely the absence of a row.
   */
  clearIssueConclusion(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Deliveries (the assessor's positive verdict) --------------------------

  /**
   * Record that an issue is delivered — the assessor's verdict, or the operator's.
   *
   * `decided_at` is preserved across an overwrite so the row still dates the first
   * judgement, which the cockpit chip and `deliveryHold`'s reason quote. World
   * signal must be measured against `updated_at`, never `decided_at`: read off the
   * older stamp, the event that expired the *previous* verdict ends the next one
   * before it is written and no verdict on that issue can ever hold again. Same
   * rule on `recordAppraisal` below. What this clears is in
   * {@link VERDICT_EXCLUSIONS}, applied by {@link recordVerdict}.
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
   * Every standing delivery verdict. **Unbounded on purpose**: a verdict that aged
   * out of a window would silently re-open pickup on work already delivered. One
   * row per assessed issue; the event read it feeds is bounded by time and item.
   */
  listDeliveries(): IssueDelivery[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_deliveries`).all() as IssueDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /** Drop an issue's delivery verdict — a delete rather than a stored `not_delivered`, for {@link clearIssueConclusion}'s reason. */
  clearDelivery(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Shortfalls (the assessor's negative verdict) --------------------------

  /**
   * Record that an issue was worked and its goal is *not* reached — the assessor's
   * negative verdict, or the operator's. `decided_at` is preserved across an
   * overwrite as a delivery's is (cosmetic here — this row holds nothing). What it
   * clears is in {@link VERDICT_EXCLUSIONS}, applied by {@link recordVerdict}.
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
      // Only a `part` cause names one; normalised here so a re-assessment that
      // changed cause cannot leave a stale slug behind.
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

  /**
   * Every standing shortfall. Unbounded in age for {@link listDeliveries}' reason,
   * and smaller still: a row lives only until the arm it named has been acted on.
   */
  listShortfalls(): IssueShortfall[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_shortfalls`).all() as IssueShortfallRow[];
    return rows.map(rowToShortfall);
  }

  /**
   * Drop an issue's shortfall — what the effect it drove does once it has taken
   * place, and the operator's "leave this alone". A delete rather than a settled
   * status, for {@link clearIssueConclusion}'s reason.
   */
  clearShortfall(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_shortfalls WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Appraisals (can the goal text be worked from at all?) ---------------------

  /**
   * Record whether an issue's goal text can be worked from — the appraiser's
   * verdict, or the operator's. `decided_at` is preserved across an overwrite for
   * {@link recordDelivery}'s reason, and `comment_ref` on absence, so the one living
   * comment is edited rather than duplicated. This clears **nothing**: an appraisal
   * answers a different question from the other three, so it may coexist with any.
   */
  recordAppraisal(input: {
    originRef: string;
    verdict: GoalAppraisalVerdict;
    summary: string;
    goalRef: string;
    by: AppraisalAuthor;
    agentId?: string | null;
    taskId?: string | null;
    /** The profile proposed for this goal's work, or null when none was named. */
    proposedProfile?: string | null;
    /** Whether the proposal needs a human answer before the funnel moves. Decided by the caller, which alone has the ticket's tag and the operator's config. */
    profileDiverges?: boolean;
    /**
     * The container this goal should hang off and the node it should sit on, as the
     * appraiser proposed them; null where it named none. Stored exactly as given and
     * **never gated here on whether the work item still lacks the field** — that
     * reading is derived off the live work item where it is drawn.
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
      goalRef: input.goalRef,
      by: input.by,
      proposedProfile,
      // Settled on arrival unless it diverges — agreement is not a question. A
      // diverging proposal is stored unanswered and `appraisalHold` holds on null.
      profileAnsweredAt: proposedProfile !== null && input.profileDiverges === true ? null : ts,
      proposedParent: input.proposedParent ?? null,
      proposedAreaPath: input.proposedAreaPath ?? null,
      // A re-appraisal is a fresh proposal, so the dismissal that answered the
      // previous one does not carry over — the whole of "a rewritten ticket is asked again".
      parentSettledAt: null,
      areaPathSettledAt: null,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      // Kept only while the verdict is about the same text: editing a superseded
      // goal's comment rewrites the answer to a question nobody asked any more.
      commentRef: prev && prev.goalRef === input.goalRef ? prev.commentRef : null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    return this.recordVerdict(
      'appraisal',
      `INSERT INTO issue_appraisals (origin_ref, verdict, summary, goal_ref, by, proposed_profile, profile_answered_at, proposed_parent, parent_settled_at, proposed_area_path, area_path_settled_at, agent_id, task_id, comment_ref, decided_at, updated_at)
       VALUES (@originRef, @verdict, @summary, @goalRef, @by, @proposedProfile, @profileAnsweredAt, @proposedParent, @parentSettledAt, @proposedAreaPath, @areaPathSettledAt, @agentId, @taskId, @commentRef, @decidedAt, @updatedAt)
       ON CONFLICT(origin_ref) DO UPDATE SET
         verdict=excluded.verdict, summary=excluded.summary, goal_ref=excluded.goal_ref,
         by=excluded.by, proposed_profile=excluded.proposed_profile,
         profile_answered_at=excluded.profile_answered_at,
         proposed_parent=excluded.proposed_parent, parent_settled_at=excluded.parent_settled_at,
         proposed_area_path=excluded.proposed_area_path,
         area_path_settled_at=excluded.area_path_settled_at,
         agent_id=excluded.agent_id, task_id=excluded.task_id,
         comment_ref=excluded.comment_ref, updated_at=excluded.updated_at`,
      row,
    );
  }

  getAppraisal(originRef: string): IssueAppraisal | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_appraisals WHERE origin_ref=?`).get(originRef) as
      | IssueAppraisalRow
      | undefined;
    return row ? rowToAppraisal(row) : null;
  }

  /**
   * Every standing appraisal. **Unbounded on purpose**, as {@link listDeliveries} is:
   * an aged-out `unclear` would dispatch against a goal already found unworkable, and
   * an aged-out `workable` would re-appraise every issue on a clock.
   */
  listAppraisals(): IssueAppraisal[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_appraisals`).all() as IssueAppraisalRow[];
    return rows.map(rowToAppraisal);
  }

  /**
   * Settle the profile question for this goal — the operator's one click, whichever
   * way they went. Stamps the answer rather than storing the choice (the choice is
   * the tag on the ticket, and re-reading the divergence would ask forever). Scoped
   * to `goalRef` so answering a superseded row cannot release an unseen question.
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
   * Settle one of a goal's placement questions. The only stored half of a question
   * whose visibility is otherwise derived from the live work item — written even
   * when the answer also ends it out there, because the derived read lags a pulse
   * and the question would flicker back. Scoped to `goalRef` as
   * {@link answerAppraisalProfile} is. The column comes from a closed union, never
   * from a caller's string.
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

  /**
   * Drop an issue's appraisal — the operator's "work it anyway", and the escape hatch
   * a blocking gate has to have. A delete rather than a stored third verdict, for
   * {@link clearIssueConclusion}'s reason.
   */
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
    // `?? null` rather than trusted: a row written before the column existed
    // reads `undefined`, which would reach the wire as a missing key.
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
function rowToAppraisal(r: IssueAppraisalRow): IssueAppraisal {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as GoalAppraisalVerdict,
    summary: r.summary,
    goalRef: r.goal_ref,
    by: r.by as AppraisalAuthor,
    // `?? null` rather than trusted: a pre-column row reads `undefined`, which for
    // `profile_answered_at` would park an issue nobody proposed anything for.
    proposedProfile: r.proposed_profile ?? null,
    profileAnsweredAt: r.profile_answered_at ?? null,
    // `?? null` for the same reason, with a smaller consequence: neither of these
    // two gates a dispatch.
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
