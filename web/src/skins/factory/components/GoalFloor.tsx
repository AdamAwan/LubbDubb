import { useEffect, useState, type JSX } from 'react';
import type { Issue, Plan, PlanPart, PullRequest, QueueItem, Task, WorkNodeView } from '../../../types.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { refLink } from '../../../components/util.js';
import { buildGoalFloor, type GoalFloorModel, type Machine } from '../goalFloor.js';
import { clip, iconForStage, patchStatus, toneColor } from '../vocabulary.js';

/**
 * The Goal Floor: one ticket's whole production line, from the patch it is mined
 * out of to the launch that ends it.
 *
 * It takes the Research rail's slot and replaces the tech tree, which drew a
 * plan's parts by depth and stopped at the part. The tree's one unique claim —
 * depth is how many merges must land before a part can start — survives intact as
 * the floor's **column**; what the floor adds is everything on either side of it:
 * the assay, the furnace, the checks on the pull request, the silo the merges
 * fill and the goal check that fires on the lot.
 *
 * Three readings it has to keep apart, and each is why something here looks
 * odd until you know:
 *
 * - **Absent is not stopped.** A goal nothing has assayed draws no drill at all;
 *   one refused at intake draws a drill that is red, stopped and carrying its
 *   reason. Telling those apart by reading a caption would put #158 back.
 * - **A stopped machine says why, in the harness's own words.** Every plate below
 *   the floor quotes a string the server computed — an assay summary, a planner's
 *   reason, a health reason, a queue item's reason. Nothing is assembled here and
 *   nothing is parsed, for `signalPolarity`'s reason.
 * - **The belt is the harness running.** A lit belt animates only while cycles
 *   run; paused or held on recovery, they all stop. `test/factorySkin.test.ts`
 *   asserts that rather than trusting the CSS.
 *
 * Two sources, and they have different jobs: `/api/state` is the live reading and
 * wins wherever both speak, while `GET /api/work/issue:<n>` is fetched **once**
 * when a floor is opened and may only *add* settled machines the world has
 * forgotten. It never contradicts a live reading and never re-fetches on a poll.
 * That one rule is the whole of the merge — two sources each partly owning a
 * field is how they start disagreeing.
 */

const NODE_W = 176;
const NODE_H = 118;
const COL_GAP = 54;
const LANE_GAP = 18;
const PAD = 12;
const SCAN_ROW = 15;

interface GoalFloorProps {
  issues: Issue[];
  plans: Plan[];
  parts: PlanPart[];
  openPrs: PullRequest[];
  closedPrs: PullRequest[];
  tasks: Task[];
  upcoming: QueueItem[];
  refUrls: Record<string, string>;
  /** Paused, or held on recovery: no cycle will run, so no belt may move. */
  stopped: boolean;
  onViewPlan: (planId: string) => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  /** `GET /api/work/:ref`, routed through `CockpitActions` — a skin never reaches `api.js`. */
  onFetchWork: (ref: string) => Promise<{ nodes: WorkNodeView[] }>;
}

const IN_PRODUCTION = new Set(['active', 'has_pr', 'planning', 'delivered']);
const inProduction = (issue: Issue): boolean => IN_PRODUCTION.has(issue.pickup?.status ?? '');

export function GoalFloor(props: GoalFloorProps): JSX.Element {
  const { issues, plans, parts, stopped, refUrls } = props;
  const [picked, setPicked] = useState<number | null>(null);
  const [recorded, setRecorded] = useState<WorkNodeView[]>([]);

  // Opened on a goal the harness is actually working, rather than on whichever
  // ticket the provider listed first: the strip is right there to pick another,
  // and a floor with nothing moving on it is the least useful thing to land on.
  const current = issues.find((i) => i.number === picked) ?? issues.find(inProduction) ?? issues[0] ?? null;
  const ref = current ? `issue:${current.number}` : null;

  // Fetched on open, never polled — the graph only ever grows, and the panel it
  // feeds is a *lens*, so a failed read degrades to the world's own reading
  // rather than to an error.
  useEffect(() => {
    if (!ref) return;
    let live = true;
    setRecorded([]);
    void props.onFetchWork(ref).then(
      (r) => {
        if (live) setRecorded(r?.nodes ?? []);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  if (!current) {
    return <p className="fx-empty">No goals in the world — nothing to lay a floor for.</p>;
  }

  const plan = plans.find((p) => p.originRef === `issue:${current.number}`) ?? null;
  const floor = buildGoalFloor({
    issue: current,
    plan,
    parts: plan ? parts.filter((p) => p.planId === plan.id) : [],
    openPrs: props.openPrs,
    closedPrs: props.closedPrs,
    tasks: props.tasks,
    upcoming: props.upcoming,
    recorded,
  });

  return (
    <>
      <div className="fx-gf-patches" role="tablist" aria-label="Goals">
        {issues.map((issue) => {
          const status = patchStatus(issue.pickup?.status ?? 'eligible');
          const on = issue.number === current.number;
          return (
            <button
              key={issue.id}
              role="tab"
              aria-selected={on}
              className={`fx-gf-patch ${on ? 'on' : ''}`}
              style={{ ['--fx-tone' as string]: toneColor(status.tone) }}
              onClick={() => setPicked(issue.number)}
              title={issue.title}
            >
              <span className="fx-ref">issue:{issue.number} · ore patch</span>
              <span className="fx-job">{clip(issue.title, 30)}</span>
              <span className="fx-gf-patch-word">{status.word}</span>
            </button>
          );
        })}
      </div>

      <FloorPlan floor={floor} stopped={stopped} refUrls={refUrls} />

      {floor.plates.map((plate, i) => (
        <div
          key={`${plate.who}-${i}`}
          className="fx-gf-plate fx-sunk"
          style={{ ['--fx-tone' as string]: toneColor(plate.tone) }}
        >
          <span className="fx-gf-who">{plate.who}</span>
          {plate.route && <span className="fx-gf-route">route · {plate.route}</span>}
          <span>{plate.text}</span>
          {plate.planId && (
            <span className="fx-gf-act">
              <button className="fx-btn" onClick={() => props.onViewPlan(plate.planId!)}>
                Open plan
              </button>
              <AsyncButton
                className="fx-btn"
                onClick={() => props.onReplan(plate.planId!)}
                title="Send the plan back to a planner. Parts nothing has started for are retired."
              >
                Replan
              </AsyncButton>
            </span>
          )}
        </div>
      ))}

      <div className="fx-gf-foot">
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('ok') }} />
          Shipped
        </span>
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('idle') }} />
          Running
        </span>
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('next') }} />
          Ready to start
        </span>
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('ghost') }} />
          Ghost — drawn, not built
        </span>
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('warn') }} />
          Held — not ours to fix
        </span>
        <span>
          <i className="fx-gf-dot" style={{ background: toneColor('bad') }} />
          Stopped — waiting on you
        </span>
        <span>◆ splitter, where lanes divide · ◆ merger, where they rejoin</span>
      </div>
    </>
  );
}

/**
 * The floor itself, as one SVG.
 *
 * A branching plan is not a rail, and drawing the linear case one way and the
 * branching case another would be two components deriving a part's state
 * independently — the thing this panel exists to stop. So there is one renderer,
 * and a floor with no branches is simply a floor whose lanes all came out at
 * zero.
 */
function FloorPlan({
  floor,
  stopped,
  refUrls,
}: {
  floor: GoalFloorModel;
  stopped: boolean;
  refUrls: Record<string, string>;
}): JSX.Element {
  const { layout } = floor;
  // One band for every lane, sized by the busiest scanner row on the floor, so
  // the lane pitch stays uniform: a per-node height would put two machines in
  // the same lane at different heights and the belts between them on a slope.
  const band = Math.max(0, ...floor.machines.map((m) => m.scanners.length)) * SCAN_ROW;
  const laneH = NODE_H + band + LANE_GAP;
  const x = (col: number) => PAD + col * (NODE_W + COL_GAP);
  const y = (lane: number) => PAD + lane * laneH;
  const width = PAD * 2 + layout.columns * NODE_W + (layout.columns - 1) * COL_GAP;
  const height = PAD * 2 + layout.lanes * laneH - LANE_GAP;
  const at = (ref: string) => layout.slots.get(ref) ?? { column: 0, lane: 0 };
  const byRef = new Map(floor.machines.map((m) => [m.ref, m]));

  // A machine's own vertical centre — except the silo, which genuinely is as tall
  // as everything feeding it, so belts meet it in the middle of the stack.
  const centreY = (m: Machine | undefined, lane: number) =>
    m?.kind === 'silo' ? PAD + (layout.lanes * laneH - LANE_GAP) / 2 : y(lane) + NODE_H / 2;

  return (
    <div className="fx-scroller">
      <svg className="fx-gf" viewBox={`0 0 ${width} ${height}`} style={{ width: `${width}px` }} role="img">
        <title>{`The production line for issue:${floor.issueNumber} — ${floor.title}`}</title>

        {/* Belts first, so a machine always covers its own join. */}
        {floor.edges.map((edge) => {
          const from = at(edge.from);
          const to = at(edge.to);
          const source = byRef.get(edge.from);
          // Lit means work has actually come out of the machine behind it. A cold
          // belt is not a fault — it is an edge nothing can travel yet.
          const lit = source?.presence === 'built' && source.status.tone === 'ok';
          const x1 = x(from.column) + NODE_W;
          const y1 = centreY(source, from.lane);
          const x2 = x(to.column);
          const y2 = centreY(byRef.get(edge.to), to.lane);
          const d = `M${x1} ${y1} C ${x1 + 26} ${y1} ${x2 - 26} ${y2} ${x2} ${y2}`;
          return (
            <g key={`${edge.from}->${edge.to}`}>
              <path className="fx-gf-bed" d={d} />
              <path className={`fx-gf-belt ${lit ? 'lit' : 'cold'} ${stopped ? 'stopped' : ''}`} d={d} />
            </g>
          );
        })}

        {/* Belt fixtures. Not machines: no status, no agent, no origin ref —
            which is also why they are 14px diamonds rather than tiles stretched
            to the height of the fan-out. */}
        {floor.fixtures.map((fix) => {
          const slot = at(fix.ref);
          const machine = byRef.get(fix.ref);
          const cx = fix.kind === 'splitter' ? x(slot.column) + NODE_W + COL_GAP / 2 : x(slot.column) - COL_GAP / 2;
          const cy = centreY(machine, slot.lane);
          return (
            <g key={`${fix.kind}:${fix.ref}`} className="fx-gf-fixture">
              <rect x={cx - 7} y={cy - 7} width="14" height="14" transform={`rotate(45 ${cx} ${cy})`} />
              <text className="fx-gf-fix" x={cx} y={cy + 26} textAnchor="middle">
                {fix.kind === 'splitter' ? 'SPLITTER' : 'MERGER'}
              </text>
            </g>
          );
        })}

        {floor.machines.map((m) => {
          const slot = at(m.ref);
          const mx = x(slot.column);
          const silo = m.kind === 'silo';
          const my = silo ? PAD : y(slot.lane);
          const mh = silo ? layout.lanes * laneH - LANE_GAP : NODE_H;
          const tone = toneColor(m.status.tone);
          const ghost = m.presence === 'ghost';
          return (
            <g
              key={m.ref}
              className={`fx-gf-m ${m.presence}`}
              opacity={m.presence === 'unbuilt' ? 0.28 : 1}
              style={{ color: tone }}
            >
              {/* One text node: a `<title>` with several children renders the
                  markup between them as literal text in the tooltip. */}
              <title>{`${m.kindLabel} — ${m.name}`}</title>
              <rect
                x={mx}
                y={my}
                width={NODE_W}
                height={mh}
                fill={ghost ? 'var(--panel-2)' : 'var(--panel)'}
                stroke={ghost ? 'var(--fx-ghost)' : 'var(--border-hi)'}
                strokeDasharray={ghost ? '5 4' : undefined}
              />
              <rect x={mx} y={my} width={NODE_W} height="4" fill={tone} opacity={ghost ? 0.55 : 0.9} />
              {/* Identity on the top row: icon, stage, and the PR chip hard
                  right. SVG has no wrapping and no ellipsis, so every clip below
                  is arithmetic against the next thing on its row rather than
                  hope — which is what `clip` exists for. */}
              <svg x={mx + 8} y={my + 10} width="18" height="18" viewBox="0 0 24 24">
                <use href={`#fx-i-${iconForStage(m.kind)}`} />
              </svg>
              <text className="fx-gf-kind" x={mx + 32} y={my + 24}>
                {clip(m.kindLabel.toUpperCase(), 13)}
              </text>
              <text className="fx-gf-name" x={mx + 10} y={my + 46}>
                {clip(m.name, 24)}
              </text>
              {m.meta.slice(0, 3).map((line, i) => (
                <text key={line + i} className="fx-gf-meta" x={mx + 10} y={my + 62 + i * 13}>
                  {clip(line, 25)}
                </text>
              ))}
              {silo && m.fill !== null && (
                <>
                  <rect
                    x={mx + 1}
                    y={my + mh - Math.round((mh - 2) * m.fill)}
                    width={NODE_W - 2}
                    height={Math.round((mh - 2) * m.fill)}
                    fill="var(--green)"
                    opacity="0.24"
                  />
                  {/* Below the midpoint, not on it: a one-lane floor's silo is
                      exactly a machine tall, and dead-centre lands on the name. */}
                  <text className="fx-gf-count" x={mx + NODE_W / 2} y={my + mh / 2 + 24} textAnchor="middle">
                    {m.siloLabel}
                  </text>
                </>
              )}
              <text className="fx-gf-word" x={mx + 10} y={my + mh - 12} fill={tone}>
                {m.status.word.toUpperCase()}
              </text>
              {m.prNumber !== null && (
                <foreignObject x={mx + NODE_W - 50} y={my + 11} width="44" height="16">
                  <span className="fx-gf-pr">{refLink(`#${m.prNumber}`, refUrls)}</span>
                </foreignObject>
              )}
              {m.scanners.map((s, i) => (
                <g key={s.name + i}>
                  <circle cx={mx + 14} cy={my + NODE_H + 6 + i * SCAN_ROW} r="3.5" fill={toneColor(s.status.tone)} />
                  <text className="fx-gf-meta" x={mx + 24} y={my + NODE_H + 10 + i * SCAN_ROW}>
                    {clip(`${s.name} · ${s.status.word}`, 24)}
                  </text>
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
