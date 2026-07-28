import type { JSX } from 'react';
import type { Plan, PlanPart, QueueItem } from '../../../types.js';
import { AsyncButton } from '../../../components/AsyncButton.js';
import { refLink, relTime } from '../../../components/util.js';
import { layoutTechTree, researchQueue, type PartState, type TreeLayout } from '../techTree.js';
import { clip, crateMachineStatus } from '../vocabulary.js';
import { Icon } from './Sprite.js';

/**
 * A plan drawn as a tech tree.
 *
 * The shared `PlanPanel` draws the same rows as a stack, which is the right
 * default and loses the one thing the data actually has: `dependsOn` is a
 * prerequisite edge, so a part's *depth* is how many merges have to land before
 * it can start. A list renders a diamond and a chain identically.
 *
 * This follows the `UpNext` precedent from the skins design rather than
 * departing from it — replan stays a `CockpitActions` call and only the drawing
 * is skin-side, so the mutation has exactly one implementation however many
 * skins draw a plan.
 */

const NODE_W = 158;
const NODE_H = 66;
const COL_GAP = 56;
const ROW_GAP = 14;
const PAD = 6;

const STATE_COLOR: Record<PartState, string> = {
  researched: 'var(--green)',
  researching: 'var(--blue)',
  available: 'var(--accent)',
  locked: 'var(--grey)',
  blocked: 'var(--red)',
};

const STATE_CAPTION: Record<PartState, string> = {
  researched: 'Researched',
  researching: 'Researching',
  available: 'Available',
  locked: 'Locked',
  blocked: 'Blocked',
};

function nodeX(col: number): number {
  return PAD + col * (NODE_W + COL_GAP);
}
function nodeY(row: number): number {
  return PAD + row * (NODE_H + ROW_GAP);
}

/** What a part's own row says about it, under the title. */
function partLine(part: PlanPart): string {
  if (part.prNumber) return `${part.status.replace('_', ' ')} · PR #${part.prNumber}`;
  if (part.branch) return part.status.replace('_', ' ');
  return `${part.status.replace('_', ' ')} · no branch`;
}

function Tree({ layout, refUrls }: { layout: TreeLayout; refUrls: Record<string, string> }): JSX.Element {
  const at = new Map(layout.nodes.map((n) => [n.part.slug, n]));
  const width = PAD * 2 + layout.cols * NODE_W + (layout.cols - 1) * COL_GAP;
  const height = PAD * 2 + layout.rows * NODE_H + (layout.rows - 1) * ROW_GAP;

  return (
    <div className="fx-scroller">
      <svg className="fx-tree" viewBox={`0 0 ${width} ${height}`} style={{ width: `${width}px` }}>
        {/* Edges first so a node always covers its own join. */}
        {layout.edges.map((edge) => {
          const from = at.get(edge.fromSlug);
          const to = at.get(edge.toSlug);
          if (!from || !to) return null;
          const x1 = nodeX(from.col) + NODE_W;
          const y1 = nodeY(from.row) + NODE_H / 2;
          const x2 = nodeX(to.col);
          const y2 = nodeY(to.row) + NODE_H / 2;
          return (
            <g key={`${edge.fromSlug}->${edge.toSlug}`}>
              <path
                d={`M${x1} ${y1} C ${x1 + 30} ${y1} ${x2 - 30} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke={edge.lit ? 'var(--green)' : 'var(--border-hi)'}
                strokeWidth={edge.lit ? 1.8 : 1.5}
                opacity={edge.lit ? 0.85 : 1}
              />
              <path d={`M${x2} ${y2} l-9 -4.5 v9 z`} fill={edge.lit ? 'var(--green)' : 'var(--border-hi)'} />
            </g>
          );
        })}

        {layout.nodes.map((node) => {
          const x = nodeX(node.col);
          const y = nodeY(node.row);
          const color = STATE_COLOR[node.state];
          const dim = node.state === 'locked';
          return (
            <g key={node.part.id} opacity={dim ? 0.62 : 1}>
              {/* One text node: a `<title>` with several children renders the
                  markup between them as literal text in the tooltip. */}
              <title>{`${node.part.title} — ${node.part.scope}`}</title>
              <rect
                x={x}
                y={y}
                width={NODE_W}
                height={NODE_H}
                fill={node.state === 'locked' ? 'var(--panel-2)' : 'var(--panel)'}
                stroke={color}
                strokeWidth={node.state === 'researching' ? 1.8 : 1.4}
                strokeDasharray={node.state === 'available' ? '5 4' : undefined}
              />
              <rect x={x} y={y} width={NODE_W} height="3" fill={color} />
              {node.state === 'researching' && (
                <rect
                  className="fx-researching"
                  x={x - 4}
                  y={y - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  fill="none"
                  stroke="var(--blue)"
                  strokeWidth="1.2"
                />
              )}
              <g style={{ color }}>
                <svg x={x + 10} y={y + 18} width="22" height="22" viewBox="0 0 24 24">
                  <use href="#fx-i-assembler" />
                </svg>
              </g>
              <text className="fx-hud" x={x + 40} y={y + 26} fill={dim ? 'var(--muted)' : undefined}>
                {clip(node.part.slug, 14)}
              </text>
              <text className="fx-mono on" x={x + 40} y={y + 41}>
                {clip(partLine(node.part), 22)}
              </text>
              <text className="fx-mono" x={x + 40} y={y + 55} fill={color}>
                {STATE_CAPTION[node.state].toUpperCase()}
              </text>
              {node.part.prNumber && (
                <foreignObject x={x + NODE_W - 44} y={y + 8} width="40" height="16">
                  <span className="fx-tree-pr">{refLink(`#${node.part.prNumber}`, refUrls)}</span>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PlanTree({
  plan,
  parts,
  queued,
  now,
  refUrls,
  paused,
  onReplan,
  onViewPlan,
}: {
  plan: Plan;
  parts: PlanPart[];
  queued: Map<string, QueueItem>;
  now: number;
  refUrls: Record<string, string>;
  paused: boolean;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onViewPlan: (planId: string) => void;
}): JSX.Element {
  const layout = layoutTechTree(parts);
  const researched = layout.nodes.filter((n) => n.state === 'researched').length;
  const queue = researchQueue(layout);

  return (
    <div className="fx-plan-tree">
      <div className="fx-tree-hd">
        <span className="fx-job" title={plan.title}>
          {plan.title}
        </span>
        <span className="fx-ref">{refLink(plan.originRef.replace('issue:', '#'), refUrls)}</span>
        <span className="fx-tech-chip" title="Parts merged out of the parts this plan still declares">
          {researched}/{layout.nodes.length} researched
        </span>
        <span className="fx-ref">{plan.status.replace('_', ' ')}</span>
        <button
          className="fx-btn"
          onClick={() => onViewPlan(plan.id)}
          title="The whole plan: every part's scope, why it is its own PR, and the planner's write-up"
        >
          View
        </button>
        <AsyncButton
          className="fx-btn"
          onClick={() => onReplan(plan.id)}
          title="Send the plan back to a planner. Parts nothing has started for are retired."
        >
          Replan
        </AsyncButton>
      </div>

      {layout.nodes.length === 0 ? (
        <p className="fx-empty">This plan declares no live parts.</p>
      ) : (
        <Tree layout={layout} refUrls={refUrls} />
      )}

      <div className="fx-queue-strip fx-sunk">
        <span className="fx-queue-cap">Research queue</span>
        {queue.length === 0 && <span className="fx-empty">Nothing can start until a part merges.</span>}
        {queue.map((node) => {
          const item = queued.get(`${plan.originRef}:part:${node.part.slug}`);
          const held = item ? crateMachineStatus(item, paused) : null;
          return (
            <span
              key={node.part.id}
              className={`fx-qchip ${node.state === 'researching' ? 'now' : ''}`}
              title={node.part.title}
            >
              <Icon name="assembler" className="sm" />
              {node.part.slug}
              <span className="n">
                · {held ? held.word.toLowerCase() : node.state === 'researching' ? 'in review' : node.state}
              </span>
            </span>
          );
        })}
        <span className="fx-ref fx-queue-age">updated {relTime(plan.updatedAt, now)}</span>
      </div>
    </div>
  );
}

export function TechTree({
  plans,
  parts,
  upcoming,
  now,
  refUrls,
  paused,
  onReplan,
  onViewPlan,
}: {
  plans: Plan[];
  parts: PlanPart[];
  upcoming: QueueItem[];
  now: number;
  refUrls: Record<string, string>;
  paused: boolean;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onViewPlan: (planId: string) => void;
}): JSX.Element {
  if (plans.length === 0) {
    return <p className="fx-empty">No blueprints — the planning funnel is off, or no issue has been decomposed.</p>;
  }
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  return (
    <div className="fx-trees">
      {plans.map((plan) => (
        <PlanTree
          key={plan.id}
          plan={plan}
          parts={parts.filter((p) => p.planId === plan.id)}
          queued={queued}
          now={now}
          refUrls={refUrls}
          paused={paused}
          onReplan={onReplan}
          onViewPlan={onViewPlan}
        />
      ))}
    </div>
  );
}
