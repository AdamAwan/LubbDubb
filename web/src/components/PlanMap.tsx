import type { PlanPartView, QueueItem } from '../types.js';

// → docs/spec/17-cockpit.md

interface Node {
  part: PlanPartView;
  x: number;
  y: number;
}

const NODE_W = 236;
const NODE_H = 62;
const COL_GAP = 58;
const ROW_GAP = 14;
const PAD = 12;
const HEAD = 20;
const BUS = 30;

export function PlanMap({
  parts,
  queued,
  originOf,
  selected,
  onSelect,
}: {
  parts: PlanPartView[];
  queued: Map<string, QueueItem>;
  originOf: (slug: string) => string;
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  const waves = layout(parts);
  if (waves.length === 0) return null;
  const nodes = waves.flat();
  const width = PAD * 2 + waves.length * NODE_W + (waves.length - 1) * COL_GAP;
  const rows = Math.max(...waves.map((w) => w.length));
  const bottom = HEAD + PAD + rows * (NODE_H + ROW_GAP) - ROW_GAP;
  const bySlug = new Map(nodes.map((n) => [n.part.slug, n]));
  const skips = nodes.some((n) => n.part.dependsOn.some((slug) => spansAWave(bySlug.get(slug), n)));
  const height = bottom + PAD + (skips ? BUS : 0);

  return (
    <div className="pm-map">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={describe(parts)}
        className="pm-map-svg"
      >
        <defs>
          <marker id="pm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L9,5 L0,9 z" className="pm-edge-head" />
          </marker>
        </defs>

        {waves.map((wave, index) => {
          const node = wave[0];
          if (node === undefined) return null;
          return (
            <text key={`w${index}`} x={node.x} y={HEAD - 8} className="pm-wave-label">
              {index === 0 ? 'FIRST' : `WAVE ${index + 1}`}
            </text>
          );
        })}

        {/* Edges first, so a node always sits on top of the lines reaching it. */}
        {nodes.flatMap((node) =>
          node.part.dependsOn.flatMap((slug) => {
            const from = bySlug.get(slug);
            if (from === undefined) return [];
            const rejoin = node.part.dependsOn.length > 1;
            return [
              <path
                key={`${slug}->${node.part.slug}`}
                d={edge(from, node, bottom + BUS / 2)}
                className={`pm-edge${rejoin ? ' rejoin' : ''}`}
                markerEnd="url(#pm-arrow)"
              />,
            ];
          }),
        )}

        {nodes.map((node) => (
          <PartNode
            key={node.part.id}
            node={node}
            queue={queued.get(originOf(node.part.slug))}
            selected={node.part.slug === selected}
            onSelect={onSelect}
          />
        ))}
      </svg>
      <div className="pm-map-key">
        <span>
          <i></i>stacks on — cut from that branch, starts once it pushes
        </span>
        <span>
          <i className="dash"></i>rejoin — waits for <em>every</em> one to merge
        </span>
        <span className="human">▭ dashed border — a step a person does</span>
      </div>
    </div>
  );
}

function PartNode({
  node,
  queue,
  selected,
  onSelect,
}: {
  node: Node;
  queue: QueueItem | undefined;
  selected: boolean;
  onSelect: (slug: string) => void;
}) {
  const { part, x, y } = node;
  const human = part.expectedKind === 'human';
  const state = stateOf(part, queue);
  return (
    <g
      className={`pm-node ${state.tone}${human ? ' human' : ''}${selected ? ' on' : ''}`}
      onClick={() => onSelect(part.slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(part.slug);
        }
      }}
    >
      <title>{`${part.title} (${part.slug}) — ${state.label}`}</title>
      <rect x={x} y={y} width={NODE_W} height={NODE_H} className="pm-node-box" />
      {/* The status, as a stripe rather than a fill: the node has to stay readable,
          and a fill dark enough to read on is a fill too dark to tell apart. A
          human step has no stripe — its whole border is the signal. */}
      {!human && <rect x={x} y={y} width={3} height={NODE_H} className="pm-node-stripe" />}
      <text x={x + 12} y={y + 21} className="pm-node-title">
        {clip(part.title, 28)}
      </text>
      <text x={x + 12} y={y + 37} className="pm-node-slug">
        {clip(part.slug, 26)}
        {part.size === null ? '' : ` · ${part.size.toUpperCase()}`}
      </text>
      <text x={x + 12} y={y + 53} className="pm-node-state">
        {state.label}
      </text>
      {part.prNumber !== null && (
        <text x={x + NODE_W - 12} y={y + 53} className="pm-node-pr" textAnchor="end">
          #{part.prNumber}
        </text>
      )}
    </g>
  );
}

function stateOf(part: PlanPartView, queue: QueueItem | undefined): { label: string; tone: string } {
  switch (part.status) {
    case 'merged':
      return { label: 'merged', tone: 'done' };
    case 'concluded':
      return { label: part.outcomeKind ?? 'concluded', tone: 'done' };
    case 'in_review':
      return { label: 'in review', tone: 'review' };
    case 'dispatched':
      return { label: 'running', tone: 'live' };
    case 'blocked':
      return { label: 'held', tone: 'bad' };
    default: {
      if (part.expectedKind === 'human') return { label: 'by hand', tone: 'human' };
      if (queue?.status === 'dispatching') return { label: '▶ next', tone: 'live' };
      if (queue?.status === 'unapproved') return { label: 'unapproved', tone: 'wait' };
      if (queue?.status === 'capped') return { label: 'capped', tone: 'wait' };
      if (part.dependsOn.length > 1) return { label: `waits for all ${part.dependsOn.length}`, tone: 'wait' };
      if (part.dependsOn.length === 1) return { label: 'after the one above', tone: 'wait' };
      return { label: 'not started', tone: 'wait' };
    }
  }
}

function layout(parts: PlanPartView[]): Node[][] {
  const depth = Math.max(0, ...parts.map((p) => p.depth));
  const waves: Node[][] = [];
  for (let d = 0; d <= depth; d++) {
    const inWave = parts.filter((p) => p.depth === d);
    if (inWave.length === 0) continue;
    const x = PAD + waves.length * (NODE_W + COL_GAP);
    waves.push(inWave.map((part, row) => ({ part, x, y: HEAD + PAD + row * (NODE_H + ROW_GAP) })));
  }
  return waves;
}

function edge(from: Node, to: Node, bus: number): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (spansAWave(from, to)) {
    const drop = x1 + COL_GAP / 3;
    const rise = x2 - COL_GAP / 3;
    return `M${x1},${y1} H${drop} V${bus} H${rise} V${y2} H${x2}`;
  }
  if (y1 === y2) return `M${x1},${y1} H${x2}`;
  const mid = x1 + (x2 - x1) / 2;
  return `M${x1},${y1} H${mid} V${y2} H${x2}`;
}

function spansAWave(from: Node | undefined, to: Node): boolean {
  return from !== undefined && to.x - from.x > NODE_W + COL_GAP + 1;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function describe(parts: PlanPartView[]): string {
  const waves = Math.max(0, ...parts.map((p) => p.depth)) + 1;
  const rejoins = parts.filter((p) => p.dependsOn.length > 1).length;
  const human = parts.filter((p) => p.expectedKind === 'human').length;
  return [
    `${parts.length} part${parts.length === 1 ? '' : 's'} in ${waves} wave${waves === 1 ? '' : 's'}`,
    rejoins > 0 ? `${rejoins} rejoining several dependencies` : null,
    human > 0 ? `${human} done by hand` : null,
  ]
    .filter((s) => s !== null)
    .join(', ');
}
