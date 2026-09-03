import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { ObstacleKind, ObstaclePurpose, ObstacleStanding } from '../types.js';
import { parseKeyCandidates } from './intake.js';
import { gateKeys, type KeyCandidate } from './keys.js';
import { buildObstacleWorld, reportedChecks } from './world.js';

/**
 * The model desk: the harness's secretary on the obstacle board, and deliberately
 * not its judge.
 *
 * The rule that governs what it may do is not about trust —
 *
 * > **A model may do anything whose mistakes are visible.**
 *
 * — and the table in
 * `docs/spec/32-obstacles.md#what-may-be-decided-by-a-model-and-what-may-not` is
 * the whole permission list. Four jobs are on it, and each is here because a wrong
 * answer to it can be seen:
 *
 * - **Extracting keys from prose.** Its output goes through the same three gates
 *   in `src/obstacles/keys.ts` that an agent's report goes through, so a wrong key
 *   fails to resolve and the row falls back to prose.
 * - **Suggesting a merge the keys missed.** It lands in `near[]` as a suggestion
 *   an agent or an operator confirms *by id* — or nobody does, and the rows stay
 *   apart.
 * - **Deciding what a row is for** — a ticket somebody fixes, or a change to the
 *   documentation. A wrong ticket is a ticket, and a ticket is visible.
 * - **Writing the ticket prose from the sightings.** It is prose, read by whoever
 *   reads any other ticket.
 *
 * **Deciding two reports are one obstacle is not on that list, and it is
 * unreachable from here.** A wrong merge hides one agent's report inside
 * another's: the swallowed report is answered *already owned*, nobody fixes it,
 * and nothing is red. So a key this desk extracts that another row already holds
 * does **not** move anything — `Store.addObstacleKeys` leaves it where it is and
 * hands the collision back, and the desk records it as one more suggestion. A
 * duplicate row costs a few hundred bytes and can be seen.
 *
 * **Nothing it writes moves a row's state, takes an owner, or resolves anything.**
 * The three writes it makes are keys, suggestions and the reading itself, plus the
 * one field that says which of the two doors a row is at — and that is guarded on
 * the row being one nothing has taken yet.
 *
 * On the pulse and not in `src/dispatcher/` for the other obstacle desks' reason:
 * it staffs nobody and no rule reads what it writes.
 */

/** What one row is handed to a reader. Prose and ids — no store, no world object. */
export interface ObstacleReadingRequest {
  obstacleId: string;
  /** The claim as the board holds it, the reporter's own frame already stripped. */
  what: string;
  /** What the intake made of it: something a fix ends, or something written down. */
  kind: ObstacleKind;
  /** Every voice behind the row, in its author's own words. */
  sightings: { words: string; whyNotMine: string | null; goalRef: string | null }[];
  /**
   * The other rows on the board, id and claim. Offered **only** so a merge can be
   * suggested by id: nothing the reader says about one of these merges anything.
   */
  others: { id: string; what: string }[];
  /** The check names the provider is reporting, so a key is spelled the provider's way. */
  checks: string[];
}

/**
 * How a deployment reads one row.
 *
 * A seam and not a client, on the terms every other desk here takes one: the
 * ownership desk files no ticket where no tracker is configured, and the endings
 * desk writes up no note where no prompt book renders one. **Absent, extraction
 * stays the mechanical reading in `src/obstacles/keys.ts`** and the ticket stays
 * the mechanical composition in `src/obstacles/ownership.ts` — which is what the
 * harness did before this desk existed, and is a deployment with no reader rather
 * than a policy.
 *
 * It answers with whatever it answers with: the shape is read defensively by
 * {@link parseObstacleReading}, because a reading is a model's output and a
 * validator that threw on one would be a pulse a model could fail.
 */
export type ObstacleReader = (request: ObstacleReadingRequest) => Promise<unknown>;

/** One reading, after everything unusable has been dropped out of it. */
interface ParsedReading {
  /** Key candidates in the same spelling an agent names them in, ungated. */
  keys: KeyCandidate[];
  /** Ids of rows it says are this one. A suggestion, and only ever confirmed by id. */
  near: string[];
  purpose: ObstaclePurpose | null;
  title: string | null;
  body: string | null;
}

/**
 * Read one answer, dropping what is not usable and keeping the rest.
 *
 * The gates' own rule, one door further out: **what fails is dropped and the
 * reading is kept.** A reader that answered with half a shape has still said
 * something about the other half, and refusing the lot would throw away work
 * already paid for. Nothing here throws — this runs on the pulse.
 *
 * `near` is filtered to ids that are actually on the board, which is the only
 * validation a merge suggestion can have: an id naming nothing is a row nobody can
 * confirm.
 */
export function parseObstacleReading(raw: unknown, onBoard: ReadonlySet<string>): ParsedReading {
  const fields = (raw ?? {}) as Record<string, unknown>;
  const purpose = fields.purpose;
  const ticket = (fields.ticket ?? {}) as Record<string, unknown>;
  return {
    // The same parser an agent's `keys` argument goes through, shared rather than
    // copied: every gate a model's output passes is the gate an agent's report
    // passes, and a second reader of the spelling would be a second thing to be
    // wrong about.
    keys: parseKeyCandidates(fields.keys),
    near: Array.isArray(fields.near)
      ? [...new Set(fields.near.filter((id): id is string => typeof id === 'string' && onBoard.has(id)))]
      : [],
    purpose: purpose === 'ticket' || purpose === 'docs' ? purpose : null,
    title: text(ticket.title, TITLE_CHARS),
    body: text(ticket.body, BODY_CHARS),
  };
}

/** A tracker title stays a line, and a body stays a page somebody reads. */
const TITLE_CHARS = 80;
const BODY_CHARS = 8_000;

/** A non-empty string, trimmed and bounded — or null, which leaves what was there. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/** How many rows one pass reads. A reading is a round trip, and a pulse is seconds. */
const READS_PER_PASS = 1;

export class ObstacleModelDesk {
  /**
   * One pass at a time, the ownership desk's reason and one more of its own: a
   * reading is a model round trip, which is slower than a provider's, and a second
   * pass starting under the first would read the same inbox and pay for it twice.
   */
  private running = false;

  constructor(
    private readonly deps: {
      store: Store;
      /** Absent = no model is ever called, and the mechanical readings stand. */
      reader?: ObstacleReader;
      /** What a `path` key is validated against. Null where the harness has no checkout. */
      repoRoot?: string | null;
      errors?: ErrorRecorder;
    },
  ) {}

  /**
   * One pass over the inbox.
   *
   * **Only where the inbox is non-empty**, which is what keeps a quiet board from
   * being a model call every pulse: the inbox is rows nobody has said anything new
   * about since the last reading, so a board that has not moved reads as empty and
   * nothing is called at all.
   *
   * The pulse does not await this. A model round trip is not a provider round trip
   * — nothing downstream waits on a reading, and a pulse that blocked on one would
   * stall every dispatch behind a call this subsystem makes for its own
   * convenience. It never rejects: everything inside is caught and recorded.
   */
  async run(): Promise<void> {
    if (this.running) return;
    const reader = this.deps.reader;
    if (!reader) return;
    this.running = true;
    try {
      const inbox = this.deps.store.obstacleInbox();
      if (inbox.length === 0) return;
      const board = this.deps.store.obstacleBoard();
      for (const row of inbox.slice(0, READS_PER_PASS)) await this.read(row, board, reader);
    } catch (err) {
      // Never into the cycle, the other obstacle desks' rule: a pass that could
      // fail a pulse is a pass an operator turns off, and then the board is back to
      // the mechanical reading with nothing saying so.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Reading the obstacle board failed: ${(err as Error).message}`,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Read one row, and write down what a model is allowed to have decided.
   *
   * The stamp is written last and carries the row's `lastSeenAt` **as it stood
   * when the request was built**: a voice that landed during the call moves the
   * row's own stamp on, so it is back in the inbox next pulse and the words that
   * arrived while the model was thinking are not silently skipped.
   *
   * **Only the agents' words are read.** The harness's own voice is gated but
   * never extracted: a prose pass over its sentence would turn the branch name in
   * it into a `path` key that the check beside it then grounds, which is the
   * harness carrying a row to `standing` alone through a door every other rule
   * closes. The inbox leaves out a row nothing but the harness has said, and this
   * leaves out its sentence on the rows it shares.
   * → `docs/spec/32-obstacles.md#the-harness-is-a-voice`
   */
  private async read(row: ObstacleStanding, board: readonly ObstacleStanding[], reader: ObstacleReader): Promise<void> {
    const id = row.obstacle.id;
    const sightings = this.deps.store.listObstacleSightings(id).filter((s) => s.transition === null);
    const reading = parseObstacleReading(
      await reader({
        obstacleId: id,
        what: row.obstacle.what,
        kind: row.obstacle.kind,
        sightings: sightings.map((s) => ({ words: s.words, whyNotMine: s.whyNotMine, goalRef: s.goalRef })),
        others: board
          .filter((other) => other.obstacle.id !== id)
          .map((o) => ({ id: o.obstacle.id, what: o.obstacle.what })),
        checks: reportedChecks(this.deps.store.getWorldBaseline()),
      }),
      new Set(board.map((other) => other.obstacle.id)),
    );
    this.attachKeys(row, reading.keys);
    for (const near of reading.near) this.deps.store.suggestObstacleMerge(id, near, 'model');
    this.setPurpose(row, reading.purpose);
    this.deps.store.recordObstacleReading({
      obstacleId: id,
      readAt: row.obstacle.lastSeenAt,
      purpose: reading.purpose,
      title: reading.title,
      body: reading.body,
    });
  }

  /**
   * Put the keys through the same three gates an agent's report goes through, and
   * attach what survives.
   *
   * Validation and grounding are asked of what the harness already knows about
   * **this row** rather than about a dispatch, because a row is what is being read:
   * the grounding set is the row's own binding check keys — the harness's own
   * statement of what this obstacle is about — and the files of the goals that
   * reported it, which is the set those reports were themselves grounded against.
   * A key outside both validated but is unplaced, so it suggests rather than binds,
   * exactly as it would arriving from an agent.
   *
   * **A key another row already holds moves nothing.** It is handed back by the
   * store and recorded here as a merge suggestion, because following it would be a
   * model's merge wearing a key's clothes.
   */
  private attachKeys(row: ObstacleStanding, candidates: readonly KeyCandidate[]): void {
    if (candidates.length === 0) return;
    const world = buildObstacleWorld({
      reported: reportedChecks(this.deps.store.getWorldBaseline()),
      dispatchChecks: row.keys.filter((key) => key.kind === 'check' && key.binds).map((key) => key.value),
      branchPaths: row.goalRefs.flatMap((goalRef) => this.deps.store.listGoalFiles(goalRef).map((file) => file.path)),
      repoRoot: this.deps.repoRoot ?? null,
    });
    // The row's own binding check keys ride in beside the candidates, because
    // grounding reads the report in front of it: a `test` or a `path` is grounded
    // by *either* half of what the harness knows, and one of those halves is a
    // grounded check on the same report. Leaving them out would ground a file the
    // row is entirely about on nothing. They are already the row's, so the store
    // skips them.
    const own = row.keys
      .filter((key) => key.kind === 'check' && key.binds)
      .map((key) => ({ kind: key.kind, value: key.value }));
    const { taken } = this.deps.store.addObstacleKeys(row.obstacle.id, gateKeys([...own, ...candidates], world));
    for (const other of taken) this.deps.store.suggestObstacleMerge(row.obstacle.id, other, 'key');
  }

  /**
   * Which of the two doors the row is at: a ticket somebody fixes, or a change to
   * the documentation.
   *
   * It is the `kind` column the intake already writes from the agent's one
   * classification, and not a second field beside it — an obstacle is fixed and a
   * note is written down, which is the same pair. The store guards the write on
   * the row being one nothing has taken yet, so a reading can never pull a ticket
   * out from under an agent dispatched for it.
   */
  private setPurpose(row: ObstacleStanding, purpose: ObstaclePurpose | null): void {
    if (purpose === null) return;
    const kind: ObstacleKind = purpose === 'docs' ? 'note' : 'obstacle';
    if (kind !== row.obstacle.kind) this.deps.store.setObstacleKind(row.obstacle.id, kind);
  }
}
