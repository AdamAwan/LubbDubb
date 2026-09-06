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

// → docs/spec/14-persistence.md

export const ISSUE_VERDICT_RENAMES: readonly TableRename[] = [{ from: 'issue_assays', to: 'issue_appraisals' }];

export const ISSUE_VERDICT_COLUMNS: ColumnMigrations = {
  issue_deliveries: { detail: 'TEXT' },
  issue_shortfalls: { detail: 'TEXT' },
  issue_appraisals: {
    proposed_profile: 'TEXT',
    profile_answered_at: 'TEXT',
    proposed_parent: 'INTEGER',
    parent_settled_at: 'TEXT',
    proposed_area_path: 'TEXT',
    area_path_settled_at: 'TEXT',
    missing: 'TEXT',
  },
};

export class IssueVerdictStore {
  constructor(private readonly ctx: StoreContext) {}

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

  clearIssueConclusion(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(originRef).changes > 0;
  }

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

  listDeliveries(): IssueDelivery[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_deliveries`).all() as IssueDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  clearDelivery(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(originRef).changes > 0;
  }

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

  listShortfalls(): IssueShortfall[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_shortfalls`).all() as IssueShortfallRow[];
    return rows.map(rowToShortfall);
  }

  clearShortfall(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_shortfalls WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  recordAppraisal(input: {
    originRef: string;
    verdict: GoalAppraisalVerdict;
    summary: string;
    missing?: string[];
    goalRef: string;
    by: AppraisalAuthor;
    agentId?: string | null;
    taskId?: string | null;
    proposedProfile?: string | null;
    profileDiverges?: boolean;
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
      profileAnsweredAt: proposedProfile !== null && input.profileDiverges === true ? null : ts,
      proposedParent: input.proposedParent ?? null,
      proposedAreaPath: input.proposedAreaPath ?? null,
      parentSettledAt: null,
      areaPathSettledAt: null,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
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

  listAppraisals(): IssueAppraisal[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_appraisals`).all() as IssueAppraisalRow[];
    return rows.map(rowToAppraisal);
  }

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

  setAppraisalComment(originRef: string, commentRef: string): void {
    this.ctx.db
      .prepare(`UPDATE issue_appraisals SET comment_ref=?, updated_at=? WHERE origin_ref=?`)
      .run(commentRef, this.ctx.now(), originRef);
  }

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
  missing: string | null;
  goal_ref: string;
  by: string;
  proposed_profile: string | null;
  profile_answered_at: string | null;
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
