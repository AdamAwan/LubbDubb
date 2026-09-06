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
        actions={actions}
        act={act}
        onRefused={setRefusal}
      />
    ));

  return (
    <div className="ob">
      <header className="ob-head">
        <h2>Obstacles</h2>
        <p className="ob-blurb">
          What the fleet has run into that is not its work, and what owns each one. Nothing here is waiting on you:
          every row has a way out that is not a person, so this is a reading rather than a queue.
        </p>
      </header>

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
      <section className="ob-section">
        <button
          type="button"
          className="ob-fold"
          aria-expanded={ended}
          onClick={() => actions.setObstacleQuery({ obstacleEnded: !ended })}
        >
          {ended ? '▾' : '▸'} Over and silenced <span className="ob-n">{over.length}</span>
        </button>
        {ended && (
          <>
            <p className="ob-note">
              Resolved, decayed, retired and muted. None is deleted — each keeps its keys, and a matching report reopens
              it at standing with its whole history.
            </p>
            {over.length === 0 ? <p className="empty">Nothing has ended yet.</p> : section(over, true)}
          </>
        )}
      </section>
    </div>
  );
}

const OBSTACLE_TONE: Partial<Record<ObstacleState, TagTone>> = {
  standing: 'amber',
  owned: 'blue',
  resolved: 'green',
};

const TERMINAL: ReadonlySet<ObstacleState> = new Set<ObstacleState>(['resolved', 'dormant', 'muted']);

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
      </HeadRow>

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

      {open && (
        <div className="ob-open">
          <Sightings sightings={row.sightings} now={now} />
          <Controls row={row} canFileTickets={canFileTickets} actions={actions} act={act} onRefused={onRefused} />
        </div>
      )}
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
  actions,
  act,
  onRefused,
}: {
  row: ObstacleBoardRow;
  canFileTickets: boolean;
  actions: CockpitActions;
  act: (run: Promise<void>) => Promise<void>;
  onRefused: (message: string) => void;
}): JSX.Element {
  const [ownerRef, setOwnerRef] = useState('');
  const { obstacle } = row;
  const live = obstacle.state === 'sighted' || obstacle.state === 'standing' || obstacle.state === 'owned';
  return (
    <div className="ob-controls">
      {obstacle.state === 'muted' ? (
        <AsyncButton onClick={() => act(actions.muteObstacle(obstacle.id, false))} onRefused={onRefused}>
          Tell the fleet again
        </AsyncButton>
      ) : (
        live && (
          <AsyncButton
            onClick={() => act(actions.muteObstacle(obstacle.id, true))}
            onRefused={onRefused}
            title="Never tell the fleet this. The one state whose exit is a person."
          >
            Mute
          </AsyncButton>
        )
      )}

      {obstacle.state === 'standing' && obstacle.kind === 'obstacle' && canFileTickets && (
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
