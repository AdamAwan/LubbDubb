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
import { VERDICT_EXCLUSIONS, VERDICT_TABLES, type VerdictKind } from './verdicts.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * Both assessment verdicts carry the assessor's account beside its headline, so
 * both tables gained `detail` together. A verdict lands in exactly one of them
 * depending on which way it went, so a `detail` on only the negative table would
 * be silently dropped by every `delivered` assessment — and silently is the whole
 * failure.
 */
export const ISSUE_VERDICT_COLUMNS: ColumnMigrations = {
  issue_deliveries: { detail: 'TEXT' },
  issue_shortfalls: { detail: 'TEXT' },
  issue_assays: {
    /** The profile the assayer proposed — see {@link IssueAssay.proposedProfile}. */
    proposed_profile: 'TEXT',
    /**
     * When the profile question was settled — see {@link IssueAssay.profileAnsweredAt}.
     *
     * Null on every row written before this existed, which is the right reading
     * for them and costs nothing: those rows also have no `proposed_profile`, and
     * the gate needs both.
     */
    profile_answered_at: 'TEXT',
    /** The container the assayer proposed — see {@link IssueAssay.proposedParent}. */
    proposed_parent: 'INTEGER',
    /**
     * When the operator answered the parent question — see
     * {@link IssueAssay.parentSettledAt}.
     *
     * Null on every row written before this existed, which is the right reading:
     * those rows carry no proposal either, and the question is only asked where
     * both a proposal and a still-missing field are present.
     */
    parent_settled_at: 'TEXT',
    /** The area path the assayer proposed — see {@link IssueAssay.proposedAreaPath}. */
    proposed_area_path: 'TEXT',
    /** {@link parent_settled_at} for the area path, and null on old rows for its reason. */
    area_path_settled_at: 'TEXT',
  },
};

/**
 * The four tables holding a standing verdict about an issue: `issue_conclusions`
 * (the working agent says it is finished), `issue_deliveries` (the assessor says
 * the goal is reached), `issue_shortfalls` (the assessor says it is not) and
 * `issue_assays` (the assayer says the goal text can — or cannot — be worked from).
 *
 * **Together, because which of them may coexist is the interesting part.** Those
 * four writers used to sit hundreds of lines apart in one 2,500-line class, each
 * clearing its siblings with an inline `DELETE` and explaining itself by pointing
 * at the next (#221). The matrix itself is not restated here — it is declared as
 * data in `./verdicts.js` (#222), which is dependency-free on purpose so the test
 * that walks it needs no SQLite; {@link recordVerdict} is the one place that
 * applies it, and it is private, so a writer cannot reach past it to roll its own.
 */
export class IssueVerdictStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write one issue verdict and clear whatever {@link VERDICT_EXCLUSIONS} says it
   * contradicts, in one transaction (#222).
   *
   * The boundary is drawn at exactly the thing all four writers share: an upsert
   * keyed on `origin_ref`, plus a set of sibling rows to delete. It deliberately
   * does **not** compose the row — the four are not the same shape in the ways
   * that matter (a conclusion preserves `created_at` where the others preserve
   * `decided_at`; a shortfall normalises `part_slug` against `cause`; an assay
   * keeps `comment_ref` only while the goal text is unchanged), so a version of
   * this that owned the row would be a `switch (kind)`: the same four half-rows,
   * moved. Each public writer keeps its own row-composition and the argument for
   * it; what they stop carrying is a private opinion about the other three.
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
   *
   * Latest-wins per issue rather than append-and-fold: a second pickup's agent
   * supersedes the first's, and an operator's toggle supersedes both. `createdAt`
   * is preserved across an overwrite so the row still dates the first time anyone
   * concluded this issue, which is what the cockpit shows when a verdict has been
   * revised.
   *
   * Which standing verdicts this clears is declared in {@link VERDICT_EXCLUSIONS}
   * and applied by {@link recordVerdict}.
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
   * way `created_at` is on a conclusion: it is what the cockpit chip and
   * `deliveryHold`'s reason string quote, and refreshing it on every
   * re-assessment would lose the fact.
   *
   * It is **not** what world signal is measured against — `updated_at` is. The
   * two are the same instant until the first re-cast and different afterwards,
   * and a hold read off `decided_at` judges the verdict standing now against a
   * transition that predates it: the event that expired the *previous* verdict
   * ends the next one before it is written, and no verdict on that issue can
   * ever hold again. Same rule on `recordAssay` below.
   *
   * Which standing verdicts this clears — a conclusion and a shortfall, with the
   * argument for each — is declared in {@link VERDICT_EXCLUSIONS} and applied by
   * {@link recordVerdict}. It is stated there rather than here because a matrix
   * written one writer at a time is one nobody can read a row of, and because a
   * deliberate "clears nothing" then reads as an entry rather than as an absence.
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
   * Which standing verdicts this clears — a delivery, and deliberately *not* an
   * {@link IssueConclusion} — is declared in {@link VERDICT_EXCLUSIONS} and
   * applied by {@link recordVerdict}.
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
      // Only a `part` cause names one. Normalised here rather than trusted from
      // the caller, so a re-assessment that changed cause cannot leave a slug
      // behind pointing the arm resolver at a part nobody named.
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
   * This clears **nothing**, and {@link VERDICT_EXCLUSIONS} says so as an explicit
   * empty row rather than as a missing `DELETE` — an assay answers a different
   * question from the other three (whether the goal could be started from, not
   * whether the work is finished), so an issue may honestly carry it alongside
   * any of them.
   */
  recordAssay(input: {
    originRef: string;
    verdict: GoalAssayVerdict;
    summary: string;
    goalRef: string;
    by: AssayAuthor;
    agentId?: string | null;
    taskId?: string | null;
    /** The profile proposed for this goal's work, or null when none was named. */
    proposedProfile?: string | null;
    /**
     * Whether the proposal needs a human answer before the funnel moves. The
     * caller decides it, because deciding it needs the ticket's tag and the
     * operator's config — neither of which the store has, and both of which are
     * in hand exactly once, where the proposal is written.
     */
    profileDiverges?: boolean;
    /**
     * The container this goal should hang off, and the classification node it
     * should sit on, as the assayer proposed them — or null for either where it
     * named none.
     *
     * Stored exactly as given and **never gated here on whether the work item is
     * still missing the field**. That reading is derived where it is drawn, off
     * the live work item, so an operator who sets it by hand in the tracker ends
     * the question with no write to this row at all.
     */
    proposedParent?: number | null;
    proposedAreaPath?: string | null;
  }): IssueAssay {
    const ts = this.ctx.now();
    const prev = this.getAssay(input.originRef);
    const proposedProfile = input.proposedProfile ?? null;
    const row: IssueAssay = {
      originRef: input.originRef,
      verdict: input.verdict,
      summary: input.summary,
      goalRef: input.goalRef,
      by: input.by,
      proposedProfile,
      // Settled on arrival unless it diverges: agreement is not a question, so it
      // must not cost a click. A proposal that *does* diverge is stored unanswered
      // and `assayHold` holds the funnel on exactly this field being null.
      profileAnsweredAt: proposedProfile !== null && input.profileDiverges === true ? null : ts,
      proposedParent: input.proposedParent ?? null,
      proposedAreaPath: input.proposedAreaPath ?? null,
      // A re-assay is a fresh proposal about a fresh reading of the ticket, so the
      // dismissal that answered the *previous* one does not carry over. That is
      // the whole of "a rewritten ticket is asked again" — there is no second
      // mechanism, and nothing here has to have witnessed the edit.
      parentSettledAt: null,
      areaPathSettledAt: null,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      // Kept only while the verdict is about the same text: a comment written for
      // a superseded goal is not this verdict's comment, and editing it in place
      // would rewrite the answer to a question nobody asked any more.
      commentRef: prev && prev.goalRef === input.goalRef ? prev.commentRef : null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    return this.recordVerdict(
      'assay',
      `INSERT INTO issue_assays (origin_ref, verdict, summary, goal_ref, by, proposed_profile, profile_answered_at, proposed_parent, parent_settled_at, proposed_area_path, area_path_settled_at, agent_id, task_id, comment_ref, decided_at, updated_at)
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

  /**
   * Settle the profile question for this goal — the operator's one click, whether
   * they took the assayer's proposal or kept their own.
   *
   * Stamps the answer rather than storing what was chosen, because what was
   * chosen is the tag on the ticket and a second copy here would be free to drift
   * from it. That is also what makes "keep mine" work: the tag goes on diverging
   * from the proposal deliberately, and a gate that re-read the divergence would
   * ask the same question again for ever.
   *
   * Scoped to the row the operator was looking at: a re-assay writes a new
   * `goal_ref` and its own unanswered proposal, so answering a superseded one
   * cannot release a question nobody has seen.
   */
  answerAssayProfile(originRef: string, goalRef: string): boolean {
    const ts = this.ctx.now();
    return (
      this.ctx.db
        .prepare(
          `UPDATE issue_assays SET profile_answered_at=?, updated_at=? WHERE origin_ref=? AND goal_ref=? AND profile_answered_at IS NULL`,
        )
        .run(ts, ts, originRef, goalRef).changes > 0
    );
  }

  /**
   * Settle one of a goal's placement questions — the operator's one click,
   * whichever of the three answers they gave.
   *
   * The only stored half of a question whose visibility is otherwise **derived**
   * from the live work item. Two of the answers end it out there as well, and this
   * is written for them too: the derived read lags a pulse behind the write, and a
   * question that came back for one refresh would read as a click that did not
   * take.
   *
   * Scoped to the row the operator was looking at, exactly as
   * {@link answerAssayProfile} is: a re-assay writes a new `goal_ref` with its own
   * proposals, and settling a superseded one must not silence a question nobody
   * has seen.
   *
   * One method over a column name rather than two near-identical ones: the two
   * fields differ in what they hold and not at all in how they are settled, and a
   * second copy of this is a second place for the goal-ref scoping to be got
   * wrong. The column is chosen from a closed union, never from a caller's string.
   */
  settleAssayPlacement(originRef: string, goalRef: string, field: 'parent' | 'areaPath'): boolean {
    const column = field === 'parent' ? 'parent_settled_at' : 'area_path_settled_at';
    const ts = this.ctx.now();
    return (
      this.ctx.db
        .prepare(
          `UPDATE issue_assays SET ${column}=?, updated_at=? WHERE origin_ref=? AND goal_ref=? AND ${column} IS NULL`,
        )
        .run(ts, ts, originRef, goalRef).changes > 0
    );
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
interface IssueAssayRow {
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
function rowToAssay(r: IssueAssayRow): IssueAssay {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as GoalAssayVerdict,
    summary: r.summary,
    goalRef: r.goal_ref,
    by: r.by as AssayAuthor,
    // `?? null` rather than trusted: a row written before the columns existed
    // reads `undefined`, which would reach the wire as a missing key — and, for
    // `profile_answered_at`, would make an old row look like an unanswered
    // proposal and park an issue nobody had proposed anything for.
    proposedProfile: r.proposed_profile ?? null,
    profileAnsweredAt: r.profile_answered_at ?? null,
    // `?? null` for the same reason, and with a smaller consequence than the
    // profile pair's: an `undefined` here would reach the wire as a missing key
    // rather than as a proposal nobody made, since nothing about these two gates
    // a dispatch.
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
