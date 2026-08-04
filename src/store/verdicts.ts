import type {
  AssayAuthor,
  ConclusionAuthor,
  DeliveryAuthor,
  GoalAssayVerdict,
  IssueAssay,
  IssueConclusion,
  IssueConclusionVerdict,
  IssueDelivery,
  IssueShortfall,
  ShortfallAuthor,
  ShortfallCause,
} from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The four standing verdicts an issue can carry: `issue_conclusions` (the working
 * agent says it is finished), `issue_deliveries` (the assessor says the goal is
 * reached), `issue_shortfalls` (the assessor says it is not) and `issue_assays`
 * (the assayer says the goal text can — or cannot — be worked from).
 *
 * **Together, because the exclusion rules between them are the interesting part**,
 * and they used to sit hundreds of lines apart in one 2,500-line class joined only
 * by prose cross-references. The whole matrix, in one place:
 *
 * | write | clears |
 * | --- | --- |
 * | {@link recordIssueConclusion} | delivery |
 * | {@link recordDelivery} | conclusion **and** shortfall |
 * | {@link recordShortfall} | delivery (never the conclusion) |
 * | {@link recordAssay} | nothing |
 *
 * Every clear is in the same transaction as its write, and every one of them is
 * here rather than in a caller, because a caller that remembered one and forgot
 * the other would leave an issue carrying two verdicts that contradict.
 */
export class VerdictStore {
  constructor(private readonly ctx: StoreContext) {}

  // -- Conclusions (the working agent's own account of its run) --------------

  /**
   * Record who says an issue is finished, replacing any standing verdict for it.
   *
   * Latest-wins per issue rather than append-and-fold: a second pickup's agent
   * supersedes the first's, and an operator's toggle supersedes both. `createdAt`
   * is preserved across an overwrite so the row still dates the first time anyone
   * concluded this issue, which is what the cockpit shows when a verdict has been
   * revised.
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
    const write = this.ctx.db.transaction((c: IssueConclusion) => {
      this.ctx.db
        .prepare(
          `INSERT INTO issue_conclusions (origin_ref, verdict, note, by, agent_id, task_id, created_at, updated_at)
           VALUES (@originRef, @verdict, @note, @by, @agentId, @taskId, @createdAt, @updatedAt)
           ON CONFLICT(origin_ref) DO UPDATE SET
             verdict=excluded.verdict, note=excluded.note, by=excluded.by,
             agent_id=excluded.agent_id, task_id=excluded.task_id, updated_at=excluded.updated_at`,
        )
        .run(c);
      // The other half of "an issue never carries both". See {@link recordDelivery}.
      this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(c.originRef);
    });
    write(row);
    return row;
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
   * or to `undeclared`. The operator's "actually, nobody has decided this": a
   * delete rather than a third stored verdict, because `undeclared` is precisely
   * the absence of a row and storing it would give the resolver two ways to
   * express one state.
   */
  clearIssueConclusion(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Deliveries (the assessor's positive verdict) --------------------------

  /**
   * Record that an issue is delivered — the assessor's verdict, or the operator's.
   *
   * `decided_at` is preserved across an overwrite, so the row still dates the
   * moment the issue was *first* judged delivered. That is not cosmetic here the
   * way `created_at` is on a conclusion: it is the instant `deliveryHold` measures
   * world signal against, and refreshing it on every re-assessment would keep
   * moving the goalposts a transition has to clear.
   *
   * **Writing this clears any standing conclusion _and_ any standing shortfall**,
   * in the same transaction. The assessor is later and better informed than the
   * agent that declared its own run, and leaving both would have rule `work-item-back-to-pickup` return
   * the item to pickup while this gate blocked it; a shortfall is the direct
   * contradiction of this row — "worked, and not delivered" against "delivered" —
   * so an assessment that changes its mind must not leave rule `issue-shortfall`
   * proposing a replan for an issue the gate has just parked. The mirrors live in
   * {@link recordIssueConclusion} and {@link recordShortfall}, one module away at
   * most; the matrix on this class states all three together.
   */
  recordDelivery(input: {
    originRef: string;
    summary: string;
    by: DeliveryAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueDelivery {
    const ts = this.ctx.now();
    const prev = this.getDelivery(input.originRef);
    const row: IssueDelivery = {
      originRef: input.originRef,
      summary: input.summary,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    const write = this.ctx.db.transaction((d: IssueDelivery) => {
      this.ctx.db
        .prepare(
          `INSERT INTO issue_deliveries (origin_ref, summary, by, agent_id, task_id, decided_at, updated_at)
           VALUES (@originRef, @summary, @by, @agentId, @taskId, @decidedAt, @updatedAt)
           ON CONFLICT(origin_ref) DO UPDATE SET
             summary=excluded.summary, by=excluded.by, agent_id=excluded.agent_id,
             task_id=excluded.task_id, updated_at=excluded.updated_at`,
        )
        .run(d);
      this.ctx.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(d.originRef);
      this.ctx.db.prepare(`DELETE FROM issue_shortfalls WHERE origin_ref=?`).run(d.originRef);
    });
    write(row);
    return row;
  }

  getDelivery(originRef: string): IssueDelivery | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_deliveries WHERE origin_ref=?`).get(originRef) as
      | IssueDeliveryRow
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  /**
   * Every standing delivery verdict.
   *
   * **Unbounded on purpose**, exactly as `listProposals` is: a verdict that aged
   * out of a window would silently re-open pickup on work already delivered, which
   * is the failure this table exists to prevent. It stays small — one row per
   * assessed issue — and what bounds the *event* read it feeds is time and item
   * (`deliverySignalQuery`), never a row count.
   */
  listDeliveries(): IssueDelivery[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_deliveries`).all() as IssueDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /**
   * Drop an issue's delivery verdict — the operator's "no, there is more here".
   *
   * A delete rather than a stored `not_delivered`, for {@link clearIssueConclusion}'s
   * reason: the absence of a verdict is precisely one state, and storing it would
   * give the gate two ways to express it.
   */
  clearDelivery(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Shortfalls (the assessor's negative verdict) --------------------------

  /**
   * Record that an issue was worked and its goal is *not* reached — the assessor's
   * negative verdict, or the operator's (issue #159).
   *
   * `decided_at` is preserved across an overwrite, exactly as a delivery's is, so
   * the row still dates the moment the issue was first judged short. Here that is
   * cosmetic rather than load-bearing — nothing measures world signal against it,
   * because this row holds nothing and so has nothing to expire — but keeping the
   * two rows the same shape is what stops a reader having to remember which one
   * dates what.
   *
   * **Writing this clears any standing delivery**, in the same transaction: they
   * are the two polarities of one question and an issue must never carry both.
   * It deliberately does **not** clear an {@link IssueConclusion} — that is the
   * working agent's own statement about its own run, and overwriting it is
   * precisely the bug this table was created to stop. `resolveIssueConclusion`
   * ranks the two instead.
   */
  recordShortfall(input: {
    originRef: string;
    cause: ShortfallCause | null;
    partSlug?: string | null;
    summary: string;
    by: ShortfallAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueShortfall {
    const ts = this.ctx.now();
    const prev = this.getShortfall(input.originRef);
    const row: IssueShortfall = {
      originRef: input.originRef,
      cause: input.cause,
      // Only a `part` cause names one. Normalised here rather than trusted from
      // the caller, so a re-assessment that changed cause cannot leave a slug
      // behind pointing the arm resolver at a part nobody named.
      partSlug: input.cause === 'part' ? (input.partSlug ?? null) : null,
      summary: input.summary,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    const write = this.ctx.db.transaction((s: IssueShortfall) => {
      this.ctx.db
        .prepare(
          `INSERT INTO issue_shortfalls (origin_ref, cause, part_slug, summary, by, agent_id, task_id, decided_at, updated_at)
           VALUES (@originRef, @cause, @partSlug, @summary, @by, @agentId, @taskId, @decidedAt, @updatedAt)
           ON CONFLICT(origin_ref) DO UPDATE SET
             cause=excluded.cause, part_slug=excluded.part_slug, summary=excluded.summary, by=excluded.by,
             agent_id=excluded.agent_id, task_id=excluded.task_id, updated_at=excluded.updated_at`,
        )
        .run(s);
      this.ctx.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(s.originRef);
    });
    write(row);
    return row;
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
   * Drop an issue's shortfall — what the *effect it drove* does once it has taken
   * place, and the operator's "no, leave this alone" besides.
   *
   * A delete rather than a settled status, for {@link clearIssueConclusion}'s
   * reason: "nothing fell short here" is one state and storing it would give the
   * rule two ways to read it. Unlike a proposal there is no verdict to keep — the
   * proposal row is where the human's decision is recorded and audited.
   */
  clearShortfall(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_shortfalls WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  // -- Assays (can the goal text be worked from at all?) ---------------------

  /**
   * Record whether an issue's goal text can be worked from — the assayer's
   * verdict, or the operator's.
   *
   * `decided_at` is preserved across an overwrite for {@link recordDelivery}'s
   * reason: it is the instant `assayHold` measures world signal against, and
   * refreshing it on a re-assay would keep moving the goalposts a transition has
   * to clear. `comment_ref` is preserved on absence, so the one living comment on
   * the ticket is edited rather than duplicated when a verdict is restated.
   *
   * Unlike {@link recordDelivery} this clears **nothing**. A delivery and a
   * conclusion are two answers to one question, so one must win; an assay answers
   * a different question — whether the goal could be started from, not whether the
   * work is finished — and an issue may honestly carry both.
   */
  recordAssay(input: {
    originRef: string;
    verdict: GoalAssayVerdict;
    summary: string;
    goalRef: string;
    by: AssayAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueAssay {
    const ts = this.ctx.now();
    const prev = this.getAssay(input.originRef);
    const row: IssueAssay = {
      originRef: input.originRef,
      verdict: input.verdict,
      summary: input.summary,
      goalRef: input.goalRef,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      // Kept only while the verdict is about the same text: a comment written for
      // a superseded goal is not this verdict's comment, and editing it in place
      // would rewrite the answer to a question nobody asked any more.
      commentRef: prev && prev.goalRef === input.goalRef ? prev.commentRef : null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO issue_assays (origin_ref, verdict, summary, goal_ref, by, agent_id, task_id, comment_ref, decided_at, updated_at)
         VALUES (@originRef, @verdict, @summary, @goalRef, @by, @agentId, @taskId, @commentRef, @decidedAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET
           verdict=excluded.verdict, summary=excluded.summary, goal_ref=excluded.goal_ref,
           by=excluded.by, agent_id=excluded.agent_id, task_id=excluded.task_id,
           comment_ref=excluded.comment_ref, updated_at=excluded.updated_at`,
      )
      .run(row);
    return row;
  }

  getAssay(originRef: string): IssueAssay | null {
    const row = this.ctx.db.prepare(`SELECT * FROM issue_assays WHERE origin_ref=?`).get(originRef) as
      | IssueAssayRow
      | undefined;
    return row ? rowToAssay(row) : null;
  }

  /**
   * Every standing assay. **Unbounded on purpose**, as {@link listDeliveries} is: an
   * `unclear` verdict that aged out of a window would let the harness dispatch
   * against a goal it has already found unworkable, and a `workable` one aging out
   * would re-assay every issue on a clock. One row per assayed issue, and the
   * event read it feeds is bounded by time and item (`assaySignalQuery`).
   */
  listAssays(): IssueAssay[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM issue_assays`).all() as IssueAssayRow[];
    return rows.map(rowToAssay);
  }

  /** Remember the comment this verdict maintains on the ticket, so the next write edits it. */
  setAssayComment(originRef: string, commentRef: string): void {
    this.ctx.db
      .prepare(`UPDATE issue_assays SET comment_ref=?, updated_at=? WHERE origin_ref=?`)
      .run(commentRef, this.ctx.now(), originRef);
  }

  /**
   * Drop an issue's assay — the operator's "work it anyway", and the escape hatch
   * a blocking gate has to have. A delete rather than a stored third verdict, for
   * {@link clearIssueConclusion}'s reason.
   */
  clearAssay(originRef: string): boolean {
    return this.ctx.db.prepare(`DELETE FROM issue_assays WHERE origin_ref=?`).run(originRef).changes > 0;
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
  by: string;
  agent_id: string | null;
  task_id: string | null;
  decided_at: string;
  updated_at: string;
}
interface IssueAssayRow {
  origin_ref: string;
  verdict: string;
  summary: string;
  goal_ref: string;
  by: string;
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
    by: r.by as ShortfallAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
function rowToAssay(r: IssueAssayRow): IssueAssay {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as GoalAssayVerdict,
    summary: r.summary,
    goalRef: r.goal_ref,
    by: r.by as AssayAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    commentRef: r.comment_ref,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
