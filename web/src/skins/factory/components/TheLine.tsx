import type { JSX } from 'react';
import type { Agent, QueueItem, Task } from '../../../types.js';
import { elapsed } from '../../../components/util.js';
import { Icon } from './Sprite.js';
import { beltTag, botState, clip, iconForOrigin } from '../vocabulary.js';

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
 */

const BAY_W = 172;
const BAY_H = 106;
const BAY_Y = 20;
const BAY_X = [238, 460, 682, 904];
/** Item width plus the flex gap — the belt's pitch, shared with the CSS. */
const PITCH = 140;
const BELT_LEFT = 12;

interface LineProps {
  live: Agent[];
  taskFor(agent: Agent): Task | null;
  cap: number;
  items: QueueItem[];
  now: number;
  /** The harness is running no cycles: paused by an operator, or held on recovery. */
  stopped: boolean;
  onOpen(agentId: string): void;
}

/** A bay is one slot in the cap: the agent filling it, or nothing. */
interface Bay {
  agent: Agent | null;
  task: Task | null;
}

function Inserter({ x, active, delay }: { x: number; active: boolean; delay: '' | 'b' | 'c' | 'd' }): JSX.Element {
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
      {active ? (
        <g className={`fx-arm ${delay}`}>
          <path d="M0 0 L0 44" stroke="var(--accent)" strokeWidth="3.4" strokeLinecap="round" />
          <rect x="-5" y="-6" width="10" height="9" rx="1" fill="var(--accent)" opacity=".8" />
        </g>
      ) : (
        // A dead inserter, parked at rest. The stillness is the reading.
        <path
          d="M0 0 L0 44"
          stroke="var(--border-hi)"
          strokeWidth="3.4"
          strokeLinecap="round"
          transform="rotate(-26)"
        />
      )}
    </g>
  );
}

export function TheLine({ live, taskFor, cap, items, now, stopped, onOpen }: LineProps): JSX.Element {
  // One bay per slot, capped at what the plan has room to draw. Over-cap fleets
  // are named in the header rather than silently cropped.
  const slots = Math.max(1, Math.min(BAY_X.length, cap));
  const bays: Bay[] = Array.from({ length: slots }, (_, i) => {
    const agent = live[i] ?? null;
    return { agent, task: agent ? taskFor(agent) : null };
  });
  const overflow = Math.max(0, live.length - slots);

  const dispatching = items.filter((i) => i.status === 'dispatching').length;
  const gateX = BELT_LEFT + dispatching * PITCH - 7;

  return (
    <section className="fx-line-wrap fx-bev">
      <div className="fx-head">
        <div>
          <Icon name="belt" />
          <h2>The Line</h2>
        </div>
        <p className="fx-note">
          {live.length}/{cap} bays staffed
          {overflow > 0 && ` · ${overflow} more off-plan`} · {items.length} on the belt
        </p>
      </div>

      <div className="fx-scroller">
        <div className="fx-line fx-sunk">
          <svg className="fx-plan" viewBox="0 0 1120 236">
            {/* ---- roboport: one pad per slot, lit when the slot is free ---- */}
            <g>
              <circle cx="96" cy="88" r="40" fill="var(--panel)" stroke="var(--border-hi)" strokeWidth="1.5" />
              <circle cx="96" cy="88" r="26" fill="none" stroke="var(--blue)" strokeWidth="1.4" opacity=".5" />
              <circle cx="96" cy="88" r="10" fill="var(--blue)" opacity=".3" />
              <g stroke="var(--border-lo)" strokeWidth="1">
                {[
                  [58, 50],
                  [122, 50],
                  [58, 114],
                  [122, 114],
                ].map(([px, py], i) => {
                  const free = i < slots && !bays[i]?.agent;
                  return (
                    <rect
                      key={`${px}-${py}`}
                      className={free ? 'fx-pad' : undefined}
                      x={px}
                      y={py}
                      width="12"
                      height="12"
                      fill={i >= slots ? 'var(--bg)' : free ? 'var(--blue)' : 'var(--panel-2)'}
                    />
                  );
                })}
              </g>
              <text className="fx-hud" x="96" y="148" textAnchor="middle">
                Roboport
              </text>
              <text className="fx-mono on" x="96" y="162" textAnchor="middle">
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
                    d={`M136 ${88 + (i - 1) * 8} C ${BAY_X[i]! - 120} ${88 + (i - 1) * 10} ${BAY_X[i]! - 60} 40 ${BAY_X[i]! + BAY_W / 2} 26`}
                  />
                ) : null,
              )}
            </g>

            {/* ---- the bays ---- */}
            {bays.map((bay, i) => {
              const x = BAY_X[i]!;
              const { agent, task } = bay;
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
                    <text className="fx-mono" x={x + BAY_W / 2} y={BAY_Y + 42} textAnchor="middle">
                      awaiting an item
                    </text>
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
                  <title>{task?.title ?? agent.id}</title>
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
                    {state === 'idle' ? 'Idle — needs you' : clip(task?.title ?? 'Working', 15)}
                  </text>
                  <text className="fx-mono on" x={x + 58} y={BAY_Y + 48}>
                    {clip(origin ?? agent.id, 22)}
                  </text>
                  <text className="fx-mono" x={x + 58} y={BAY_Y + 62}>
                    {clip(task?.branch ?? 'no branch', 22)}
                  </text>
                  <text className="fx-mono" x={x + 58} y={BAY_Y + 82}>
                    {state === 'idle'
                      ? clip(agent.waitingReason ?? 'parked', 22)
                      : `running ${elapsed(agent.startedAt, agent.endedAt, now)}`}
                  </text>
                  {state === 'working' && (
                    <g fill="var(--muted)">
                      <circle className="fx-puff" cx={x + BAY_W - 16} cy={BAY_Y + 8} r="5" opacity=".2" />
                      <circle className="fx-puff p2" cx={x + BAY_W - 8} cy={BAY_Y + 8} r="3.5" opacity=".2" />
                    </g>
                  )}
                </g>
              );
            })}

            {bays.map((bay, i) => (
              <Inserter
                key={`ins-${i}`}
                x={BAY_X[i]! + BAY_W / 2}
                active={bay.agent != null && botState(bay.agent) !== 'idle'}
                delay={(['', 'b', 'c', 'd'] as const)[i] ?? ''}
              />
            ))}
          </svg>

          {/* ---- the belt ---- */}
          <div className={`fx-belt ${stopped ? 'stopped' : ''}`}>
            <div className="fx-belt-row">
              {items.map((item) => (
                <span
                  key={item.origin}
                  className={`fx-item ${item.status === 'dispatching' ? 'hot' : ''}`}
                  title={`${item.title} — ${item.reason}`}
                >
                  <Icon name={iconForOrigin(item.origin)} />
                  <span>
                    <span className="fx-item-ref">{item.origin}</span>
                    <span className="fx-item-why">{beltTag(item)}</span>
                  </span>
                </span>
              ))}
            </div>
          </div>

          {items.length > 0 && (
            <>
              <div className="fx-gate" style={{ left: gateX }} aria-hidden="true" />
              <p className="fx-gate-lbl" style={{ left: gateX - 26 }}>
                Gate
                <br />
                {cap} max
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
          <b style={{ background: 'var(--red)' }} />
          Jammed — waiting on you
        </span>
      </div>
    </section>
  );
}
