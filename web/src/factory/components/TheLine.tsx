import type { CSSProperties, JSX } from 'react';
import type { Agent, QueueItem, Task } from '../../types.js';
import { elapsed, refLink } from '../../components/util.js';
import { Icon, Lamp, LampMark } from './Sprite.js';
import { beltTier } from '../../view/production.js';
import {
  bayMachineStatus,
  botState,
  clip,
  crateMachineStatus,
  iconForOrigin,
  inserterPhase,
  toneColor,
  type InserterPhase,
  type MachineStatus,
} from '../vocabulary.js';

/**
 * The floor plan: a roboport with one pad per slot in the cap, a bay per slot,
 * and the queue on a belt underneath.
 *
 * The claim it makes is the dispatch rule itself — **a bay runs only when it has
 * both an item and a bot**. Headroom is drawn as free pads and a free bay,
 * the queue as items backed up behind a gate, and the cut as the gate's
 * position. Nothing here is decoration standing in for a number: every bay is a
 * live agent, every crate is a `QueueItem`, and the belt stops when the harness
 * does.
 *
 * The floor is laid out **from the cap** rather than from a fixed four slots. A
 * factory that grows when you raise the cap is the whole point of drawing one:
 * the old fixed array named the surplus in the header and cropped it off the
 * picture, which made the one control an operator actually turns invisible in
 * the one panel that exists to show it.
 */

const BAY_W = 172;
const BAY_H = 106;
const BAY_Y = 20;
const BAY_X0 = 238;
const BAY_PITCH = 222;
/**
 * Past this the plan is wider than any screen and the roboport's flight paths
 * become spaghetti. Beyond it the surplus is named in the header, as it was for
 * every bay past the fourth before.
 */
const MAX_BAYS = 8;
const PLAN_H = 236;

/** Crate width, and crate width plus the flex gap — the belt's pitch, shared with the CSS. */
const ITEM_W = 128;
const PITCH = 140;
const BELT_LEFT = 12;
/**
 * The gate fills the gap _between_ two crates, so it is exactly that gap wide.
 * Centring a wider bar on the boundary is what put it over the first waiting
 * crate's edge; a bar the width of the gap can only ever sit in it.
 */
const GATE_W = PITCH - ITEM_W;
/** Fixed so the label can be centred on the gate and clamped to the stage. */
const GATE_LBL_W = 76;

interface LineProps {
  live: Agent[];
  taskFor(agent: Agent): Task | null;
  cap: number;
  items: QueueItem[];
  now: number;
  /** The pulse interval — how long an inserter's swing lasts after a dispatch. */
  intervalMs: number;
  /** The harness is running no cycles: paused by an operator, or held on recovery. */
  stopped: boolean;
  /**
   * The server-built `ref → URL` map. The bay HUD and the belt crates both print an
   * origin ref, and both now link it where the provider resolved one — the floor
   * being animated is not a reason for the one ref an operator wants to open to be
   * the one they have to go and find somewhere else.
   */
  refUrls: Record<string, string>;
  onOpen(agentId: string): void;
}

/** A bay is one slot in the cap: the agent filling it, or nothing. */
interface Bay {
  agent: Agent | null;
  task: Task | null;
}

function bayX(index: number): number {
  return BAY_X0 + index * BAY_PITCH;
}

/**
 * Pads sized to fit the roboport's face rather than a fixed four.
 *
 * The ring is 80 across, so a fixed pad size runs out of port at about six. The
 * squares shrink instead, which keeps "one pad per slot" literally true — the
 * property the pads exist to state.
 */
function padLayout(count: number): { size: number; x: (i: number) => number } {
  const span = 70;
  const gap = 2;
  const size = Math.max(4, Math.min(12, Math.floor((span - (count - 1) * gap) / count)));
  const width = count * size + (count - 1) * gap;
  const left = 96 - width / 2;
  return { size, x: (i) => left + i * (size + gap) };
}

/** The glyph inside a machine's status badge, one shape per tone. */
function StatusGlyph({ tone }: { tone: MachineStatus['tone'] }): JSX.Element {
  const color = toneColor(tone);
  switch (tone) {
    case 'ok':
      return <path d="M2 6.4 4.6 9 10 3.2" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />;
    case 'bad':
      return <rect x="2.5" y="2.5" width="7" height="7" fill={color} />;
    case 'warn':
      return <path d="M6 1.8 10.4 9.8H1.6z" fill={color} />;
    case 'idle':
      return <circle cx="6" cy="6" r="3.4" fill="none" stroke={color} strokeWidth="1.8" />;
    case 'off':
      return <path d="M7 1.4 3 6.8h2.6L4.8 10.6 9 5.2H6.3z" fill={color} />;
    // The two the Goal Floor added. Nothing on this panel returns them today —
    // the switch is exhaustive, so they are here to be a shape rather than a
    // blank badge the day something does.
    case 'ghost':
      return (
        <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="2 2" />
      );
    case 'next':
      return <path d="M3.4 2.4 8.6 6l-5.2 3.6z" fill={color} />;
  }
}

/** A status badge, pinned to a bay's top-right corner. */
function StatusBadge({ x, y, status }: { x: number; y: number; status: MachineStatus }): JSX.Element {
  return (
    <g>
      <title>{status.word}</title>
      <rect
        x={x}
        y={y}
        width="18"
        height="18"
        fill="var(--panel-2)"
        stroke={toneColor(status.tone)}
        strokeWidth="1.2"
      />
      <svg x={x + 3} y={y + 3} width="12" height="12" viewBox="0 0 12 12">
        <StatusGlyph tone={status.tone} />
      </svg>
    </g>
  );
}

/**
 * An inserter swings on a *transfer*, not while a bay is occupied.
 *
 * The arm used to run continuously for the life of an agent, which made it the
 * one moving thing on the floor that carried no information — every staffed bay
 * looked identical whether it had just picked work up or had been grinding for
 * an hour. A swing now means a dispatch landed here, it carries the item while
 * it swings, and the rest of the time it is still.
 */
function Inserter({ x, phase, delay }: { x: number; phase: InserterPhase; delay: '' | 'b' | 'c' | 'd' }): JSX.Element {
  return (
    <g transform={`translate(${x} 126)`}>
      <rect
        x="-13"
        y="46"
        width="26"
        height="10"
        rx="1"
        fill="var(--panel)"
        stroke="var(--border-hi)"
        strokeWidth="1.2"
      />
      {phase === 'transfer' && (
        <g className={`fx-arm ${delay}`}>
          <path d="M0 0 L0 44" stroke="var(--accent)" strokeWidth="3.4" strokeLinecap="round" />
          <rect x="-5" y="-6" width="10" height="9" rx="1" fill="var(--accent)" opacity=".8" />
          {/* The item in the hand: what makes the swing a transfer rather than a wave. */}
          <g className="fx-held">
            <rect
              x="-8"
              y="-19"
              width="16"
              height="12"
              fill="var(--blue-fill)"
              stroke="var(--blue)"
              strokeWidth="1.2"
            />
            <rect x="-3" y="-15.5" width="6" height="5" fill="var(--blue)" />
          </g>
        </g>
      )}
      {phase === 'rest' && (
        // Staffed, nothing moving. Upright and still — the commonest state on a
        // working floor, and it should look like work, not like a fault.
        <g>
          <path d="M0 0 L0 44" stroke="var(--border-hi)" strokeWidth="3.4" strokeLinecap="round" />
          <rect x="-5" y="-6" width="10" height="9" rx="1" fill="var(--border-hi)" />
        </g>
      )}
      {phase === 'off' && (
        // A dead inserter, parked at rest. The stillness is the reading.
        <path
          d="M0 0 L0 44"
          stroke="var(--border-hi)"
          strokeWidth="3.4"
          strokeLinecap="round"
          transform="rotate(-26)"
          opacity=".55"
        />
      )}
    </g>
  );
}

export function TheLine({
  live,
  taskFor,
  cap,
  items,
  now,
  intervalMs,
  stopped,
  refUrls,
  onOpen,
}: LineProps): JSX.Element {
  // One bay per slot, capped at what the plan has room to draw. Over-cap fleets
  // are named in the header rather than silently cropped.
  const slots = Math.max(1, Math.min(MAX_BAYS, cap));
  const bays: Bay[] = Array.from({ length: slots }, (_, i) => {
    const agent = live[i] ?? null;
    return { agent, task: agent ? taskFor(agent) : null };
  });
  const overflow = Math.max(0, live.length - slots);
  const planW = BAY_X0 + (slots - 1) * BAY_PITCH + BAY_W + 20;
  const pads = padLayout(slots);

  // The belt splits at the cut: the prefix is boarding and moves, everything
  // behind it is backed up and butted solid. Both runs share the crate pitch, so
  // the gate still lands exactly in the gap between them.
  const boarding = items.filter((i) => i.status === 'dispatching');
  const backedUp = items.filter((i) => i.status !== 'dispatching');
  // The left edge of the first crate that is *not* boarding, backed off by the
  // gate's own width: the gate lands in the gap ahead of it rather than on it.
  const gateX = BELT_LEFT + boarding.length * PITCH - GATE_W;
  // Centred on the bar, but clamped to the stage — `.fx-line` clips, so an
  // unclamped label loses its first word whenever the gate is hard left.
  const gateLblX = Math.min(Math.max(gateX + GATE_W / 2 - GATE_LBL_W / 2, 2), planW - GATE_LBL_W - 2);

  const crate = (item: QueueItem, jammed: boolean) => {
    const status = crateMachineStatus(item, stopped);
    return (
      <span
        key={item.origin}
        className={`fx-item ${item.status === 'dispatching' ? 'hot' : ''} ${jammed ? 'jam' : ''} tone-${status.tone}`}
        title={`${item.title} — ${item.reason}`}
      >
        <Icon name={iconForOrigin(item.origin)} />
        <span>
          {/* The crate's own ref, linked. `refLink` rather than `refChip`: the
              origin is the label here — it is what the crate has always printed —
              so an unresolvable one keeps printing rather than vanishing. */}
          <span className="fx-item-ref">{refLink(item.origin, refUrls)}</span>
          <span className="fx-item-why">
            <Lamp tone={status.tone} />
            {status.word}
          </span>
        </span>
      </span>
    );
  };

  return (
    <section className="fx-line-wrap fx-bev" data-fx="line">
      <div className="fx-head">
        <div>
          <Icon name="belt" />
          <h2>The Line</h2>
        </div>
        <p className="fx-note">
          {live.length}/{cap} bays staffed
          {overflow > 0 && ` · ${overflow} more off-plan`} · {items.length} on the belt
          {backedUp.length > 0 && ` · ${backedUp.length} backed up`}
        </p>
      </div>

      <div className="fx-scroller">
        {/* The plan's own width goes in as a custom property rather than as the
            element's width: the floor and the belt fill the panel at any cap
            (a one-bay plan is narrower than any screen, and a floor that stopped
            at the last bay left the belt hanging in mid-air), while the SVG keeps
            its intrinsic width so its 1:1 viewBox scale — and therefore the crate
            pitch the gate is measured in — survives. See the CSS. */}
        <div className="fx-line fx-sunk" style={{ '--fx-plan-w': `${planW}px` } as CSSProperties}>
          <svg className="fx-plan" viewBox={`0 0 ${planW} ${PLAN_H}`}>
            {/* ---- roboport: one pad per slot, lit when the slot is free ---- */}
            <g>
              <circle cx="96" cy="88" r="40" fill="var(--panel)" stroke="var(--border-hi)" strokeWidth="1.5" />
              <circle cx="96" cy="88" r="26" fill="none" stroke="var(--blue)" strokeWidth="1.4" opacity=".5" />
              <circle cx="96" cy="88" r="10" fill="var(--blue)" opacity=".3" />
              <g stroke="var(--border-lo)" strokeWidth="1">
                {bays.map((bay, i) => (
                  <rect
                    key={`pad-${i}`}
                    className={bay.agent ? undefined : 'fx-pad'}
                    x={pads.x(i)}
                    y={100}
                    width={pads.size}
                    height={pads.size}
                    fill={bay.agent ? 'var(--panel-2)' : 'var(--blue)'}
                  />
                ))}
              </g>
              {/* Pulled up off the belt: the gate label shares this band, and at a
                  low cut it lands right here. */}
              <text className="fx-hud" x="96" y="144" textAnchor="middle">
                Roboport
              </text>
              <text className="fx-mono on" x="96" y="158" textAnchor="middle">
                {live.length} out · {Math.max(0, cap - live.length)} pad
                {cap - live.length === 1 ? '' : 's'} free
              </text>
            </g>

            {/* ---- flight paths, one per staffed bay ---- */}
            <g fill="none" stroke="var(--blue)" strokeWidth="1.2" strokeDasharray="3 5" opacity=".45">
              {bays.map((bay, i) =>
                bay.agent ? (
                  <path
                    key={bay.agent.id}
                    d={`M136 ${88 + (i - 1) * 8} C ${bayX(i) - 120} ${88 + (i - 1) * 10} ${bayX(i) - 60} 40 ${bayX(i) + BAY_W / 2} 26`}
                  />
                ) : null,
              )}
            </g>

            {/* ---- the bays ---- */}
            {bays.map((bay, i) => {
              const x = bayX(i);
              const { agent, task } = bay;
              const status = bayMachineStatus(agent, stopped);
              if (!agent) {
                return (
                  <g key={`free-${i}`}>
                    <rect
                      x={x}
                      y={BAY_Y}
                      width={BAY_W}
                      height={BAY_H}
                      fill="var(--panel)"
                      stroke="var(--accent)"
                      strokeWidth="1.4"
                      strokeDasharray="5 4"
                      opacity=".85"
                    />
                    <text className="fx-hud" x={x + BAY_W / 2} y={BAY_Y + 26} textAnchor="middle" fill="var(--accent)">
                      Free bay
                    </text>
                    <text className="fx-bay-word" x={x + BAY_W / 2} y={BAY_Y + 42} textAnchor="middle">
                      {status.word.toLowerCase()}
                    </text>
                    {/* Lower-left, where the game puts it. */}
                    <LampMark x={x + 8} y={BAY_Y + BAY_H - 15} tone={status.tone} />
                    <g style={{ color: 'var(--accent)' }}>
                      <svg
                        x={x + BAY_W / 2 - 18}
                        y={BAY_Y + 52}
                        width="36"
                        height="36"
                        viewBox="0 0 24 24"
                        opacity=".45"
                      >
                        <use href="#fx-i-assembler" />
                      </svg>
                    </g>
                    <StatusBadge x={x + BAY_W - 24} y={BAY_Y + 6} status={status} />
                  </g>
                );
              }

              const state = botState(agent);
              const origin = task?.originRef ?? null;
              const accent = state === 'idle' ? 'var(--red)' : 'var(--blue)';
              return (
                <g
                  key={agent.id}
                  role="button"
                  tabIndex={0}
                  // `aria-label` as well as the `<title>`: a `<title>` child names
                  // an `<svg>` reliably but not an arbitrary `<g>`, and this one
                  // read as an unnamed button in the accessibility tree without it.
                  aria-label={`Open the transcript for ${task?.title ?? agent.id}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpen(agent.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(agent.id);
                    }
                  }}
                >
                  <title>{`${task?.title ?? agent.id} — ${status.word}`}</title>
                  <rect
                    x={x}
                    y={BAY_Y}
                    width={BAY_W}
                    height={BAY_H}
                    fill="var(--panel)"
                    stroke={state === 'idle' ? 'var(--red)' : 'var(--border-hi)'}
                    strokeWidth="1.5"
                  />
                  <rect x={x} y={BAY_Y} width={BAY_W} height="4" fill={accent} opacity={state === 'idle' ? 1 : 0.5} />
                  <g style={{ color: accent }}>
                    {state === 'idle' ? (
                      <svg className="fx-flyer" x={x + 12} y={BAY_Y + 28} width="42" height="42" viewBox="0 0 24 24">
                        <use href="#fx-i-alert" />
                      </svg>
                    ) : (
                      <g className={`fx-spin ${origin?.startsWith('pr:') ? 'fast' : ''}`}>
                        <svg x={x + 12} y={BAY_Y + 28} width="42" height="42" viewBox="0 0 24 24">
                          <use href={`#fx-i-${iconForOrigin(origin)}`} />
                        </svg>
                      </g>
                    )}
                  </g>
                  <text className="fx-hud" x={x + 58} y={BAY_Y + 32} fill={state === 'idle' ? 'var(--red)' : undefined}>
                    {clip(task?.title ?? 'Working', 13)}
                  </text>
                  {/* The bay's origin ref, linked. A `foreignObject` because SVG
                      `<text>` cannot host one — the same wrapper the Goal Floor
                      uses for its PR chip, and the reason the meta lines around it
                      stay plain `<text>`.

                      `stopPropagation` on the group, because the whole bay is a
                      button that opens the transcript: without it a click on the
                      link would open the drawer *and* navigate. The bay keeps its
                      own click; the ref is the one hole in it. */}
                  <g onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <foreignObject x={x + 56} y={BAY_Y + 37} width={BAY_W - 82} height="15">
                      <span className="fx-bay-ref">{refLink(origin ?? agent.id, refUrls)}</span>
                    </foreignObject>
                  </g>
                  <text className="fx-mono" x={x + 58} y={BAY_Y + 62}>
                    {clip(task?.branch ?? 'no branch', 22)}
                  </text>
                  <text className="fx-bay-word" x={x + 58} y={BAY_Y + 82} fill={toneColor(status.tone)}>
                    {status.word}
                    {state !== 'idle' && ` · ${elapsed(agent.startedAt, agent.endedAt, now)}`}
                  </text>
                  {/* Lower-left, where the game puts it. */}
                  <LampMark x={x + 8} y={BAY_Y + BAY_H - 15} tone={status.tone} />
                  <StatusBadge x={x + BAY_W - 24} y={BAY_Y + 8} status={status} />
                  {state === 'working' && (
                    <g fill="var(--muted)">
                      <circle className="fx-puff" cx={x + BAY_W - 34} cy={BAY_Y + 8} r="5" opacity=".2" />
                      <circle className="fx-puff p2" cx={x + BAY_W - 28} cy={BAY_Y + 8} r="3.5" opacity=".2" />
                    </g>
                  )}
                </g>
              );
            })}

            {bays.map((bay, i) => (
              <Inserter
                key={`ins-${i}`}
                x={bayX(i) + BAY_W / 2}
                phase={stopped ? 'off' : inserterPhase(bay.agent, now, intervalMs)}
                delay={(['', 'b', 'c', 'd'] as const)[i % 4] ?? ''}
              />
            ))}
          </svg>

          {/* ---- the belt ---- */}
          {/* `clear` and `stopped` are different conditions: a paused belt carrying
              items is stopped and full height. Both classes can be on at once. */}
          <div
            className={`fx-belt ${stopped ? 'stopped' : ''} ${items.length === 0 ? 'clear' : ''} ${beltTier(items.length, cap)}`}
          >
            <div className="fx-belt-row">
              {/* Each run is rendered only when it has crates: an empty flex child
                  would still take the row's gap, and that gap is exactly where the
                  gate has to sit. */}
              {boarding.length > 0 && (
                <div className="fx-belt-run moving">{boarding.map((item) => crate(item, false))}</div>
              )}
              {backedUp.length > 0 && (
                <>
                  <div className="fx-belt-run jam">{backedUp.map((item) => crate(item, true))}</div>
                  {/* Trailing the jam rather than pinned to the belt's far edge:
                      the floor scrolls, so a tag anchored right is off-screen
                      exactly when the queue is long enough to need one. */}
                  <span className="fx-jam-tag">Backed up · {backedUp.length}</span>
                </>
              )}
            </div>
          </div>

          {items.length > 0 && (
            <>
              {/* `${}px` rather than a bare number: React drops the unit on 0,
                  and a gate with nothing boarding sits at exactly 0. */}
              <div className="fx-gate" style={{ left: `${gateX}px` }} aria-hidden="true" />
              <p className="fx-gate-lbl" style={{ left: `${gateLblX}px` }}>
                Gate · {cap} max
              </p>
            </>
          )}
        </div>
      </div>

      <div className="fx-legend">
        <span>
          <b style={{ background: 'var(--fx-ghost)' }} />
          Ghost — queued, not started
        </span>
        <span>
          <b style={{ background: 'var(--accent)' }} />
          Boarding this cycle
        </span>
        <span>
          <b style={{ background: 'var(--blue)' }} />
          Bot working
        </span>
        <span>
          <b style={{ background: 'var(--amber)' }} />
          No ingredients — throttled
        </span>
        <span>
          <b style={{ background: 'var(--red)' }} />
          Output full — waiting on you
        </span>
      </div>
    </section>
  );
}
