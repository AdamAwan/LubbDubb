import type { GoalWatch, PlanPartView, StateQuery, ValidationCheck } from '../types.js';

// → docs/spec/17-cockpit.md

export type ProofCell = 'manual' | 'suite' | 'watch' | 'state';

interface ProofCount {
  cell: ProofCell;
  label: string;
  count: string;
  unit: string;
  note: string;
  waiting: number;
}

/**
 * What a plan declared as its proof, counted. Four cells because there are four
 * ways a goal is shown to work and they are decided in one place and read in
 * four — a person's checks, the suite's areas, the post-deploy watch and the
 * state queries.
 *
 * **A cell with nothing declared still counts.** Nothing declared is a third
 * fact rather than a synonym for clean, and a band that drew only what was
 * there would read as a fuller proof the less a planner wrote.
 */
export function proofCounts(
  checks: readonly ValidationCheck[],
  parts: readonly PlanPartView[],
  watches: readonly GoalWatch[],
  queries: readonly StateQuery[],
): ProofCount[] {
  const live = checks.filter((c) => c.supersededReason === null);
  const manual = live.filter((c) => c.area === null);
  const settled = manual.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const nominated = manual.filter((c) => c.fleetCandidate && c.actor === 'human').length;
  const areas = [...new Set(parts.flatMap((p) => (typeof p.coverage === 'string' ? [p.coverage] : [])))];
  const covered = live.filter((c) => c.area !== null).length;
  const signals = watches.filter((w) => w.kind === 'signal').length;
  const measures = watches.filter((w) => w.kind === 'measure').length;
  const pending = watches.filter((w) => !w.live).length;
  const unread = queries.filter((q) => q.dryRunVerdict === null).length;

  return [
    {
      cell: 'manual',
      label: 'A person runs',
      count: `${manual.length}`,
      unit: manual.length === 1 ? 'check' : 'checks',
      note:
        manual.length === 0
          ? 'No check declared — closing this goal is a judgement call.'
          : settled === manual.length
            ? 'All settled.'
            : nominated > 0
              ? `${settled}/${manual.length} settled. ${nominated} nominated for the fleet.`
              : `${settled}/${manual.length} settled.`,
      waiting: manual.length - settled,
    },
    {
      cell: 'suite',
      label: 'The suite runs',
      count: `${areas.length}`,
      unit: areas.length === 1 ? 'area' : 'areas',
      note:
        areas.length === 0
          ? 'No test part — nothing here is covered by the browser suite.'
          : `${areas.join(', ')} — ${covered === 0 ? 'no check selects it yet' : `${covered} check${covered === 1 ? '' : 's'} verified against it`}.`,
      waiting: 0,
    },
    {
      cell: 'watch',
      label: 'After it ships',
      count: `${signals + measures}`,
      unit: signals + measures === 1 ? 'check' : 'checks',
      note:
        signals + measures === 0
          ? 'No watch declared — nothing is read once this is deployed.'
          : `${signals} signal${signals === 1 ? '' : 's'}, ${measures} measure${measures === 1 ? '' : 's'}.`,
      waiting: pending,
    },
    {
      cell: 'state',
      label: 'The data is right',
      count: `${queries.length}`,
      unit: queries.length === 1 ? 'query' : 'queries',
      note:
        queries.length === 0
          ? 'No state query — nothing reads what the change writes.'
          : `Put to a store on the goal, never committed.`,
      waiting: unread,
    },
  ];
}

/**
 * The band, directly under the verdict: what this plan says will show that it
 * worked, before the parts that will do the work.
 *
 * It counts and it jumps — every reading below it is drawn by the section it
 * lands on, so a number here can never disagree with the rows it stands for.
 *
 * @public embedded by the plan sheet, which owns its chrome
 */
export function ProofBand({
  checks,
  parts,
  watches,
  queries,
  onJump,
}: {
  checks: ValidationCheck[];
  parts: PlanPartView[];
  watches: GoalWatch[];
  queries: StateQuery[];
  onJump: (cell: ProofCell) => void;
}) {
  const counts = proofCounts(checks, parts, watches, queries);
  return (
    <>
      <span className="pm-section-label">
        How this gets proven <i className="k">declared at plan time</i>
      </span>
      <div className="pm-proof">
        {counts.map((c) => (
          <button key={c.cell} className={`pm-pcell ${c.cell}`} onClick={() => onJump(c.cell)}>
            <span className="pm-section-label">{c.label}</span>
            <span className="pm-pcount">
              {c.count} <i>{c.unit}</i>
            </span>
            {c.waiting > 0 && <span className="pm-pwait">{waiting(c)}</span>}
            <p className={c.count === '0' ? 'pm-pnone' : 'pm-pnote'}>{c.note}</p>
          </button>
        ))}
      </div>
    </>
  );
}

function waiting(count: ProofCount): string {
  if (count.cell === 'manual') return `${count.waiting} not settled`;
  if (count.cell === 'state') return `${count.waiting} not yet read`;
  return `${count.waiting} awaiting you`;
}
