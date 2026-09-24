import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  ObstacleBoardCounts,
  ObstacleBoardPayload,
  ObstacleBoardRow,
  ObstacleKey,
  ObstacleSighting,
  ObstacleState,
} from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { api } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Ref } from './refs.js';
import { absDate, relTime, untilTime } from './util.js';
import { HeadRow } from './panel.js';
import { Tag, type TagTone } from './tag.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

export function ObstaclesPage({
  open,
  ended,
  now,
  actions,
}: {
  open: string | null;
  ended: boolean;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  const { board, failed, refusal, setRefusal, act } = useObstacleBoard();

  if (failed) {
    return (
      <p className="empty">
        The obstacle board could not be read. The harness is unaffected — this is one route, and the rest of the cockpit
        is telling you the truth.
      </p>
    );
  }
  if (board === null) return <p className="empty">Reading the board…</p>;

  const standing = board.rows.filter((row) => row.obstacle.state === 'standing' || row.obstacle.state === 'owned');
  const sighted = board.rows.filter((row) => row.obstacle.state === 'sighted');
  const over = board.rows.filter((row) => TERMINAL.has(row.obstacle.state));

  const section = (rows: ObstacleBoardRow[], dim: boolean): JSX.Element[] =>
    rows.map((row) => (
      <Row
        key={row.obstacle.id}
        row={row}
        dim={dim}
        open={open === row.obstacle.id}
        now={now}
        dormantMs={board.dormantMs}
        canFileTickets={board.canFileTickets}
        ticketApproval={board.ticketApproval}
        actions={actions}
        act={act}
        onRefused={setRefusal}
      />
    ));

  return (
    <div className="ob">
      <BoardHead />

      <Counts counts={board.counts} now={now} />

      {refusal !== null && <p className="ob-refusal">{refusal}</p>}

      <section className="ob-section">
        <h3>
          Standing <span className="ob-n">{standing.length}</span>
        </h3>
        <p className="ob-note">
          Two independent voices have said each of these, so every dispatch whose checks and files they match is told
          about them — and told not to go fixing one.
        </p>
        {standing.length === 0 ? (
          <p className="empty">Nothing is standing. No dispatch is carrying an obstacle right now.</p>
        ) : (
          section(standing, false)
        )}
      </section>

      <section className="ob-section ob-dim">
        <h3>
          Sighted once <span className="ob-n">{sighted.length}</span>
        </h3>
        <p className="ob-note">
          One voice each, so these reach nobody — a single report is also what an agent mis-diagnosing its own change
          looks like. Each says when it goes dormant if nothing says it again.
        </p>
        {sighted.length === 0 ? <p className="empty">Nothing has been sighted once.</p> : section(sighted, true)}
      </section>

      {/* The fold states its own size, which is the whole of what makes it safe: a
          tail that names itself and its count cannot be read as rows that went
          missing. Shut by default, so the page as it stands is a bare URL. */}
      <EndedFold
        ended={ended}
        count={over.length}
        onToggle={() => actions.setObstacleQuery({ obstacleEnded: !ended })}
        rows={() => section(over, true)}
      />
    </div>
  );
}

function BoardHead(): JSX.Element {
  return (
    <header className="ob-head">
      <h2>Obstacles</h2>
      <p className="ob-blurb">
        What the fleet has run into that is not its work, and what owns each one. Every row has a way out that is not a
        person, so this stays a reading rather than a queue — a bug proposed for one is the single thing you are asked
        about, and a proposal nobody answers decays with the row.
      </p>
    </header>
  );
}

function useObstacleBoard() {
  const [board, setBoard] = useState<ObstacleBoardPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api.getObstacles());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (run: Promise<void>) => {
      setRefusal(null);
      await run;
      await load();
    },
    [load],
  );

  return { board, failed, refusal, setRefusal, act };
}

function EndedFold({
  ended,
  count,
  onToggle,
  rows,
}: {
  ended: boolean;
  count: number;
  onToggle: () => void;
  rows: () => JSX.Element[];
}): JSX.Element {
  return (
    <section className="ob-section">
      <button type="button" className="ob-fold" aria-expanded={ended} onClick={onToggle}>
        {ended ? '▾' : '▸'} Over and silenced <span className="ob-n">{count}</span>
      </button>
      {ended && (
        <>
          <p className="ob-note">
            Resolved, decayed, retired and muted. None is deleted — each keeps its keys, and a matching report reopens
            it at standing with its whole history.
          </p>
          {count === 0 ? <p className="empty">Nothing has ended yet.</p> : rows()}
        </>
      )}
    </section>
  );
}

const OBSTACLE_TONE: Partial<Record<ObstacleState, TagTone>> = {
  standing: 'amber',
  owned: 'blue',
  resolved: 'green',
};

const TERMINAL: ReadonlySet<ObstacleState> = new Set<ObstacleState>(['resolved', 'dormant', 'muted']);

function proposed(row: ObstacleBoardRow, canFileTickets: boolean, ticketApproval: boolean): boolean {
  const { obstacle } = row;
  return (
    ticketApproval &&
    canFileTickets &&
    obstacle.kind === 'obstacle' &&
    obstacle.state === 'standing' &&
    obstacle.ownerRef === null &&
    obstacle.ticketDecision === null
  );
}

function Counts({ counts, now }: { counts: ObstacleBoardCounts; now: number }): JSX.Element {
  const { window: rate } = counts;
  return (
    <div className="ob-counts">
      <Tile n={counts.sightings} label="sightings" note="every voice on every row, the harness's own included" />
      <Tile n={counts.goals} label="goals cost" note="distinct goals that have hit something and said so" />
      <Tile
        n={counts.told}
        label="agents told"
        note="mid-session notices actually sent — the only telling with a record behind it"
      />
      <div className="ob-tile ob-tile-wide">
        <div className="ob-tile-n">
          {rate.calls} <span className="ob-tile-of">from</span> {rate.callers}
          <span className="ob-tile-of"> of </span>
          {rate.agents}
        </div>
        <div className="ob-tile-l">calls to raise</div>
        <div className="ob-tile-note">
          agents that reached the tool channel at all, since {relTime(rate.since, now)} ({absDate(rate.since)}). This is
          the one number that says whether any of the rest of this is worth having.
        </div>
      </div>
    </div>
  );
}

function Tile({ n, label, note }: { n: number; label: string; note: string }): JSX.Element {
  return (
    <div className="ob-tile">
      <div className="ob-tile-n">{n}</div>
      <div className="ob-tile-l">{label}</div>
      <div className="ob-tile-note">{note}</div>
    </div>
  );
}

function Row({
  row,
  dim,
  open,
  now,
  dormantMs,
  canFileTickets,
  ticketApproval,
  actions,
  act,
  onRefused,
}: {
  row: ObstacleBoardRow;
  dim: boolean;
  open: boolean;
  now: number;
  dormantMs: number;
  canFileTickets: boolean;
  ticketApproval: boolean;
  actions: CockpitActions;
  act: (run: Promise<void>) => Promise<void>;
  onRefused: (message: string) => void;
}): JSX.Element {
  const { obstacle } = row;
  return (
    <div className={`ob-row${dim ? ' dim' : ''}${open ? ' open' : ''}`}>
      <HeadRow align="baseline" className="ob-row-top">
        <button
          type="button"
          className="ob-claim"
          aria-expanded={open}
          onClick={() => {
            if (!open) logUsage('obstacle.expand');
            actions.setObstacleQuery({ obstacle: open ? null : obstacle.id });
          }}
        >
          {obstacle.what}
        </button>
        {/* Beside the control, never inside it. */}
        <span className="cn-refs">{obstacle.ownerRef !== null && <Ref to={obstacle.ownerRef} />}</span>
        <Tag tone={OBSTACLE_TONE[obstacle.state]} fill={OBSTACLE_TONE[obstacle.state] !== undefined}>
          {obstacle.state}
        </Tag>
        {obstacle.kind === 'note' && <span className="ob-kind">note</span>}
        {proposed(row, canFileTickets, ticketApproval) && <Tag tone="amber">bug proposed — waiting on you</Tag>}
        {obstacle.state === 'standing' && obstacle.ticketDecision === 'declined' && (
          <span className="ob-kind">no bug</span>
        )}
      </HeadRow>

      <RowMeta row={row} now={now} dormantMs={dormantMs} />

      {open && (
        <div className="ob-open">
          <Sightings sightings={row.sightings} now={now} />
          <Controls
            row={row}
            canFileTickets={canFileTickets}
            ticketApproval={ticketApproval}
            actions={actions}
            act={act}
            onRefused={onRefused}
          />
        </div>
      )}
    </div>
  );
}

function RowMeta({ row, now, dormantMs }: { row: ObstacleBoardRow; now: number; dormantMs: number }): JSX.Element {
  const { obstacle } = row;
  return (
    <div className="ob-row-meta">
      <span className="ob-keys">
        {row.keys.length === 0 ? (
          <span className="ob-key none">no keys — it can be delivered to nobody</span>
        ) : (
          row.keys.map((key) => <Key key={key.id} entry={key} />)
        )}
      </span>
      <span className="ob-cost">
        {row.goalRefs.length} goal{row.goalRefs.length === 1 ? '' : 's'} · {row.voices} voice
        {row.voices === 1 ? '' : 's'}
      </span>
      <span className="ob-seen" title={absDate(obstacle.lastSeenAt)}>
        last seen {relTime(obstacle.lastSeenAt, now)}
      </span>
      {obstacle.state === 'sighted' && (
        <span className="ob-decay">dormant in {untilTime(dormantAt(obstacle.lastSeenAt, dormantMs), now)}</span>
      )}
      {obstacle.endedBy !== null && <span className="ob-ended">{ENDING_WORDS[obstacle.endedBy]}</span>}
    </div>
  );
}

function dormantAt(lastSeenAt: string, dormantMs: number): string {
  return new Date(Date.parse(lastSeenAt) + dormantMs).toISOString();
}

const ENDING_WORDS: Record<NonNullable<ObstacleBoardRow['obstacle']['endedBy']>, string> = {
  condition: 'the world cleared it',
  landing: 'its owner landed',
  expiry: 'the reporter’s own clock ran out',
  decay: 'nothing said it again',
  'written-down': 'it was written into the repository',
  retired: 'you retired it',
};

function Key({ entry }: { entry: ObstacleKey }): JSX.Element {
  return (
    <span
      className={`ob-key${entry.binds ? '' : ' suggests'}`}
      title={entry.binds ? 'binds: a report carrying this joins this row' : 'suggests only: it resolves nothing'}
    >
      <span className="ob-key-k">{entry.kind}</span>
      {entry.value}
    </span>
  );
}

function Sightings({ sightings, now }: { sightings: ObstacleSighting[]; now: number }): JSX.Element {
  return (
    <ol className="ob-sightings">
      {sightings.map((sighting) => (
        <li key={sighting.id}>
          <p className="ob-words">{sighting.words}</p>
          <p className="ob-why">
            <span className="cn-refs">{sighting.goalRef !== null && <Ref to={sighting.goalRef} />}</span>
            {sighting.goalRef === null && <span className="ob-harness">the harness itself</span>}
            {sighting.transition !== null && <span className="ob-transition">saw {sighting.transition}</span>}
            <span className="ob-matched">
              {sighting.matchedBy === 'fresh' ? (
                'filed this row — nothing matched'
              ) : (
                <>
                  joined on <code>{sighting.matchedBy}</code>
                </>
              )}
            </span>
            <span className="ob-when" title={absDate(sighting.createdAt)}>
              {relTime(sighting.createdAt, now)}
            </span>
          </p>
          {sighting.whyNotMine !== null && (
            <p className="ob-not-mine">
              <span className="ob-not-mine-l">why not theirs:</span> {sighting.whyNotMine}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Controls({
  row,
  canFileTickets,
  ticketApproval,
  actions,
  act,
  onRefused,
}: {
  row: ObstacleBoardRow;
  canFileTickets: boolean;
  ticketApproval: boolean;
  actions: CockpitActions;
  act: (run: Promise<void>) => Promise<void>;
  onRefused: (message: string) => void;
}): JSX.Element {
  const [ownerRef, setOwnerRef] = useState('');
  const { obstacle } = row;
  const live = obstacle.state === 'sighted' || obstacle.state === 'standing' || obstacle.state === 'owned';
  const fileable = obstacle.state === 'standing' && obstacle.kind === 'obstacle' && canFileTickets;
  return (
    <div className="ob-controls">
      <MuteControl obstacle={obstacle} live={live} actions={actions} act={act} onRefused={onRefused} />

      {fileable && ticketApproval && (
        <TicketDecision obstacle={obstacle} actions={actions} act={act} onRefused={onRefused} />
      )}

      {fileable && (
        <span className="ob-own">
          <input
            type="text"
            value={ownerRef}
            placeholder="issue:412 — the ticket you are using"
            aria-label="the ticket or work you are using to fix this"
            onChange={(e) => setOwnerRef(e.target.value)}
          />
          <AsyncButton
            disabled={ownerRef.trim() === ''}
            onClick={() => act(actions.ownObstacle(obstacle.id, ownerRef.trim()))}
            onRefused={onRefused}
            title="Name what is fixing it. The fleet is told to stand down from it and shown this."
          >
            Own it
          </AsyncButton>
        </span>
      )}

      {obstacle.state === 'standing' && obstacle.kind === 'note' && (
        <AsyncButton
          onClick={() => act(actions.writeDownObstacle(obstacle.id))}
          onRefused={onRefused}
          title="Queue the documentation change now. One note is written up at a time, across the whole fleet."
        >
          Write it down
        </AsyncButton>
      )}

      {live && (
        <ConfirmButton
          label="Retire"
          confirmLabel="Retire it"
          title="This is over and no reading is going to say so. It is not rejecting — the row keeps what it said, and a matching report reopens it."
          onConfirm={() => act(actions.retireObstacle(obstacle.id))}
        />
      )}
    </div>
  );
}

type ControlProps = {
  obstacle: ObstacleBoardRow['obstacle'];
  actions: CockpitActions;
  act: (run: Promise<void>) => Promise<void>;
  onRefused: (message: string) => void;
};

function MuteControl({
  obstacle,
  live,
  actions,
  act,
  onRefused,
}: ControlProps & { live: boolean }): JSX.Element | null {
  if (obstacle.state === 'muted') {
    return (
      <AsyncButton onClick={() => act(actions.muteObstacle(obstacle.id, false))} onRefused={onRefused}>
        Tell the fleet again
      </AsyncButton>
    );
  }
  if (!live) return null;
  return (
    <AsyncButton
      onClick={() => act(actions.muteObstacle(obstacle.id, true))}
      onRefused={onRefused}
      title="Never tell the fleet this. The one state whose exit is a person."
    >
      Mute
    </AsyncButton>
  );
}

function TicketDecision({ obstacle, actions, act, onRefused }: ControlProps): JSX.Element {
  return (
    <>
      {obstacle.ticketDecision !== 'approved' && (
        <AsyncButton
          onClick={() => act(actions.decideObstacleTicket(obstacle.id, true))}
          onRefused={onRefused}
          title="File the bug. The pulse files it on the next cycle, with the sightings behind it, and the row takes the ticket as its owner."
        >
          File the bug
        </AsyncButton>
      )}

      {obstacle.ticketDecision === null && (
        <AsyncButton
          onClick={() => act(actions.decideObstacleTicket(obstacle.id, false))}
          onRefused={onRefused}
          title="No bug for this. The fleet is still told about it and told not to go fixing it; nothing is filed, and the row decays as it would have."
        >
          No bug
        </AsyncButton>
      )}
    </>
  );
}
