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

/**
 * The obstacle board — *what is blocking the fleet, and what owns each one*.
 *
 * **Reachable by URL only.** It is not registered in the nav, deliberately, and
 * that stands until the operator lifts it in writing. A nav slot is the most
 * expensive space in the cockpit, and the one question this subsystem has not
 * settled is whether agents call its tool at all
 * ([27](../../../docs/spec/27-obstacles.md#what-is-not-settled)); the answer to
 * that is the call rate below, and it arrives as a number whether or not anybody
 * is looking.
 *
 * Four things about it are load-bearing, and each is a refusal.
 *
 * **It is read-mostly, and there is no badge.** The store this replaces gated
 * every durable claim on an operator's click, so its output when nobody visited
 * the page was exactly zero. Nothing on this board waits on a person: a row is
 * filed by an agent, carried to `standing` by a second independent voice, owned by
 * the pulse, and ended by one of the four endings. So there is no queue, no triage
 * verdict, and above all no count of *things waiting on you* — because nothing is,
 * and a badge that said otherwise would be inventing the state the whole design
 * exists to avoid.
 *
 * **Two sections, and the second is dimmed and says when it goes away.** Standing
 * is what reaches agents. *Sighted once* reaches nobody — one report is not
 * evidence, and it is the case the harness cannot tell apart from an agent
 * mis-diagnosing its own breakage — so it is drawn quieter than the rows that are
 * being told to the fleet, and each row says the instant it will decay rather than
 * that it eventually will.
 *
 * **Everything terminal is behind a fold that states its own size.** A tail that
 * names itself and its count cannot be mistaken for rows that went missing, and it
 * is what stops *resolved* reading as *deleted* — which is what
 * the retired claim store's own page spent nine open
 * sections buying.
 *
 * **It draws what it counts and never what it would like to.** Sightings, goals
 * cost, notices sent and the rate agents call the tool are all observed. *Turns an
 * agent did not spend* is the figure everyone wants and nothing measures, so it is
 * not drawn: a number invented to sit beside four real ones would be the one thing
 * on the page that is a lie, and it would be the one quoted.
 *
 * It fetches, so it lives here rather than under `console/` — the sanctioned route
 * the tickets tab and Insights already take, asserted in `test/console.test.ts`.
 *
 * → `docs/spec/27-obstacles.md#in-the-cockpit`, `docs/spec/17-cockpit.md`
 */
export function ObstaclesPage({
  open,
  ended,
  now,
  actions,
}: {
  /** The row whose sightings are unfolded, from `Place` — never a `useState` here. */
  open: string | null;
  /** Whether the terminal tail is opened, from `Place`, for the same reason. */
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

  // The four controls refetch this page rather than only the snapshot: the board
  // is its own route, so a refreshed snapshot would leave the row an operator just
  // muted still drawn as standing — a control that appeared to do nothing.
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

/** The states nothing further is owed about. Muted is a person's, and sits with them. */
/**
 * What each state of an obstacle asks of a reader: one standing is a gate, one
 * somebody has taken is in hand, one that is over is over. `sighted`, `dormant`
 * and `muted` carry no verdict and so take no tone — the word is the whole of it.
 */
const OBSTACLE_TONE: Partial<Record<ObstacleState, TagTone>> = {
  standing: 'amber',
  owned: 'blue',
  resolved: 'green',
};

const TERMINAL: ReadonlySet<ObstacleState> = new Set<ObstacleState>(['resolved', 'dormant', 'muted']);

/**
 * The four figures, and the sentence each one is.
 *
 * The call rate is drawn as its three counts rather than as a ratio, because the
 * denominator is the interesting half: *one agent of nineteen called it* is the
 * answer to the question this subsystem has not settled, and a percentage hides
 * exactly the number that answers it.
 */
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

/**
 * One row: the claim, its keys, what it cost, who has it, where it is and when it
 * was last seen — with the voices behind it a fold away.
 *
 * **The claim is the control and the references sit beside it.** A `<Ref>` inside
 * a button is a second destination for one click, which is the one thing a call
 * site here has to get right (`web/src/components/refs.tsx`).
 */
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

/** When a row with nothing further said about it decays. */
function dormantAt(lastSeenAt: string, dormantMs: number): string {
  return new Date(Date.parse(lastSeenAt) + dormantMs).toISOString();
}

/**
 * What ended a row, in words rather than in the column's own vocabulary.
 *
 * Totalled over the union rather than a lookup with a fallback, so an ending added
 * server-side is a compile error here instead of a row that says nothing about how
 * it ended.
 */
const ENDING_WORDS: Record<NonNullable<ObstacleBoardRow['obstacle']['endedBy']>, string> = {
  condition: 'the world cleared it',
  landing: 'its owner landed',
  expiry: 'the reporter’s own clock ran out',
  decay: 'nothing said it again',
  'written-down': 'it was written into the repository',
  retired: 'you retired it',
};

/**
 * One key, with whether it **binds** said out loud.
 *
 * A `signature` or a `cmd` never resolves an obstacle and never decides who is
 * told about one, and a board that drew all five identically would be inviting an
 * operator to read a suggestion as an identity.
 */
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

/**
 * The voices, in their authors' own words, each with its goal and why it landed
 * here.
 *
 * **This is the reason the row expands at all.** It is the only place the matcher
 * can be seen working or getting it wrong: `matchedBy` is the key that bound the
 * report, or `fresh` where nothing did — and an operator reading three unrelated
 * failures folded under one claim is reading a wrong merge, which is the failure
 * this whole subsystem is arranged to keep visible.
 */
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

/**
 * The four controls, and none of them is on any path.
 *
 * Each is drawn only where it is the operator's to say. *Own it* wants a ticket
 * ref, so it is a field rather than a button — naming what is fixing it is the
 * whole of the act, and a button that took the row with nothing to show the fleet
 * would tell every agent to stand down from something with no name.
 */
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
