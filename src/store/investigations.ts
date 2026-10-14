import type { InvestigationConfidence, InvestigationResolution, IssueInvestigation } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

type InvestigationInput = Omit<IssueInvestigation, 'decidedAt' | 'resolution' | 'resolvedAt'>;

export class InvestigationStore {
  constructor(private readonly ctx: StoreContext) {}

  record(input: InvestigationInput): IssueInvestigation {
    const row: IssueInvestigation = { ...input, decidedAt: this.ctx.now(), resolution: null, resolvedAt: null };
    this.ctx
      .prep(
        `INSERT INTO issue_investigations (origin_ref, goal_ref, by, reproduction, root_cause, confidence, locations, blast_radius, recommendation, decided_at, resolution, resolved_at)
         VALUES (@originRef, @goalRef, @by, @reproduction, @rootCause, @confidence, @locations, @blastRadius, @recommendation, @decidedAt, NULL, NULL)
         ON CONFLICT(origin_ref) DO UPDATE SET
           goal_ref=excluded.goal_ref, by=excluded.by, reproduction=excluded.reproduction,
           root_cause=excluded.root_cause, confidence=excluded.confidence, locations=excluded.locations,
           blast_radius=excluded.blast_radius, recommendation=excluded.recommendation,
           decided_at=excluded.decided_at, resolution=NULL, resolved_at=NULL`,
      )
      .run({
        originRef: row.originRef,
        goalRef: row.goalRef,
        by: row.by,
        reproduction: row.reproduction,
        rootCause: row.rootCause,
        confidence: row.confidence,
        locations: row.locations,
        blastRadius: row.blastRadius,
        recommendation: row.recommendation,
        decidedAt: row.decidedAt,
      });
    return row;
  }

  get(originRef: string): IssueInvestigation | null {
    const row = this.ctx.prep(`SELECT * FROM issue_investigations WHERE origin_ref=?`).get(originRef) as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(): IssueInvestigation[] {
    return (this.ctx.prep(`SELECT * FROM issue_investigations`).all() as Row[]).map(fromRow);
  }

  resolve(originRef: string, resolution: InvestigationResolution): IssueInvestigation | null {
    this.ctx
      .prep(`UPDATE issue_investigations SET resolution=?, resolved_at=? WHERE origin_ref=?`)
      .run(resolution, this.ctx.now(), originRef);
    return this.get(originRef);
  }

  clear(originRef: string): boolean {
    return this.ctx.prep(`DELETE FROM issue_investigations WHERE origin_ref=?`).run(originRef).changes > 0;
  }
}

interface Row {
  origin_ref: string;
  goal_ref: string;
  by: string;
  reproduction: string;
  root_cause: string;
  confidence: string;
  locations: string;
  blast_radius: string;
  recommendation: string;
  decided_at: string;
  resolution: string | null;
  resolved_at: string | null;
}

function fromRow(r: Row): IssueInvestigation {
  return {
    originRef: r.origin_ref,
    goalRef: r.goal_ref,
    by: r.by,
    reproduction: r.reproduction,
    rootCause: r.root_cause,
    confidence: r.confidence as InvestigationConfidence,
    locations: r.locations,
    blastRadius: r.blast_radius,
    recommendation: r.recommendation as InvestigationResolution,
    decidedAt: r.decided_at,
    resolution: (r.resolution as InvestigationResolution | null) ?? null,
    resolvedAt: r.resolved_at ?? null,
  };
}
